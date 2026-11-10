/**
 * 写入管线：抽取 → 安全检查 → 心情 → 门槛 → 去重/关联 → 落盘 → 投影。
 *
 * 由 Journal worker 调用，一次处理一个 turn。任何一步失败都不影响其它步：
 * 记忆系统是旁路设施，绝不能因为自身异常让对话失败。
 */

import {
  WEIGHTS, RECALL_TOP_K, SCORE_QUANTUM, DAY_MS,
  REL_THRESHOLD, CAUSAL_THRESHOLD, DEDUP_THRESHOLD,
  SEM_REL_THRESHOLD, SEM_CAUSAL_THRESHOLD, SEM_DEDUP_THRESHOLD,
  RECALL_MIN_SCORE, DORMANT_TTL_DAYS, FAILED_JOB_TTL_DAYS, MEM_CAP,
} from "../core/config.js";
import { initState, settle, grow, shouldPromote, retention } from "../core/decay.js";
import { extract, shouldWrite, jevClassify } from "./extract.js";
import { screenForWrite } from "./guard.js";
import {
  normalizeMood, aggregate, updateEma, effectiveEma, writeThreshold, gainFactor,
} from "../mood/model.js";
import { inferMood } from "../mood/probe.js";
import {
  embed, quantize, lexicalSearch, graphExpand, buildAdjacency, rerank,
} from "../storage/vector.js";

let seq = 0;
const nid = (prefix) => `${prefix}_${Date.now().toString(36)}_${(seq += 1).toString(36)}`;

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * 处理一个 turn 载荷。
 *
 * @param {object} deps 依赖注入：{ domain, index, log, config, embedder, semCache }
 * @param {object} payload { userText, assistantText, mood? }
 * @param {object} job 队列记录，含 turnId / sessionId / scope
 */
export async function runJob(deps, payload, job) {
  const { domain, log, config } = deps;
  const memories = domain.table("memories");
  const now = Date.now();
  const scope = job?.scope ?? "global";

  // ---- 1. 心情：先算，因为它决定本轮的写入门槛 ----
  const mood = await resolveMood(deps, payload, now);
  const theta = writeThreshold(mood.ema);
  const fGain = gainFactor(mood.ema);

  // ---- 2. 抽取 ----
  // importance 只由档位决定；心情的效价只作用于 θ（上一步已算好）
  // moodRaw 现在真的传进去了 —— 早期这里写死 null，导致整条心情链路失效
  const { candidates } = extract(payload, payload?.mood ?? null);

  // ---- 3. 安全检查：掩码 + 威胁扫描 ----
  const screened = [];
  for (const c of candidates) {
    const r = screenForWrite(c.text);
    if (!r.accept) {
      log?.debug?.(`memory: 拒绝写入（${r.reason}）：${c.text.slice(0, 60)}`);
      await bumpStats(domain, { blocked: 1 });
      continue;
    }
    screened.push({
      ...c,
      text: r.text,
      tainted: r.threats.level === "warn",
      taintReason: r.reason || undefined,
      secrets: r.secrets.length > 0 ? r.secrets : undefined,
    });
  }

  // ---- 4. 可选 Jev 覆盖（P3 期）----
  let jevUsed = 0;
  if (config.jevEndpoint && config.jevApiKey) {
    for (const c of screened) {
      const r = await jevClassify(c.text, {
        endpoint: config.jevEndpoint,
        apiKey: config.jevApiKey,
        model: config.jevModel,
      });
      if (r.ok) {
        c.kind = r.kind ?? c.kind;
        c.level = r.level;
        c.importance = r.importance;
        jevUsed += 1;
      }
    }
  }

  // ---- 5. 逐条写入 ----
  const written = [];
  for (const cand of screened) {
    if (!shouldWrite(cand, theta)) continue;
    const rec = await upsertCandidate(deps, cand, mood, now, fGain, scope);
    if (rec) written.push(rec);
  }

  // ---- 6. 建边：新条目与既有条目之间的关系 ----
  if (written.length > 0) {
    await buildEdges(deps, written, now);
  }

  // ---- 7. 统计埋点 ----
  await bumpStats(domain, {
    jobsDone: 1,
    moodTotal: mood.raw ? 1 : 0,
    moodRejected: mood.raw && !mood.accepted ? 1 : 0,
    multiLabel: (mood.labels?.length ?? 0) > 1 ? 1 : 0,
    jevDegraded: jevUsed < screened.length ? 1 : 0,
  });

  log?.debug?.(`memory: job ${job?.id} wrote ${written.length}/${screened.length}, theta=${theta.toFixed(3)}`);
  return { ok: true, written: written.length, blocked: candidates.length - screened.length };
}

/**
 * 心情解析。优先读载荷里直传的值，其次用内置的文本启发式判定。
 *
 * ⚠ 这一步的可靠性取决于**载荷里到底有没有 mood**。历史版本这里读
 * `payload.mood`，但入队方只写 `{ userText, assistantText }`，于是
 * 永远读不到 → EMA 恒 0 → θ 恒 0.55 → 整套心情调制形同虚设，
 * 而 README 里那张「开心3 / 焦虑3 / 疲惫2」的差异表根本不成立。
 *
 * 现在由 `mood/probe.js` 从文本推断，不依赖外部插件。载荷里显式给了
 * mood 就用它（外部插件仍可覆盖），没给就自己判。
 */
async function resolveMood(deps, payload, now) {
  const { domain } = deps;
  const g = domain.global.get();
  const prevEma = { v: g?.emaV ?? 0, a: g?.emaA ?? 0, at: g?.moodAt ?? 0 };

  let raw = payload?.mood ?? null;
  let inferred = false;
  if (!raw && deps.config?.moodInfer !== false) {
    try {
      raw = inferMood(payload?.userText ?? "", payload?.assistantText ?? "");
      inferred = Boolean(raw);
    } catch { /* 推断失败按无心情处理 */ }
  }

  if (!raw) {
    const ema = effectiveEma(prevEma, now);
    return { ema, raw: null, accepted: false, labels: [] };
  }

  const norm = normalizeMood(raw);
  if (!norm.ok) {
    const ema = effectiveEma(prevEma, now);
    return { ema, raw, accepted: false, labels: [], reject: norm.reason };
  }

  const { v, a } = aggregate(norm.labels);
  const ema = updateEma(prevEma, { v, a });
  await domain.global.set({
    ...g,
    emaV: ema.v,
    emaA: ema.a,
    moodAt: ema.at,
  });
  return { ema, raw, accepted: true, labels: norm.labels, v, a, inferred };
}

/**
 * 写入或更新一条候选记忆。
 *
 * 去重策略：先向量近邻找同实体，再判是否同一事实。
 * 同一事实 → 视为「再次提及」，走召回增益而非新建，避免同一句话存 20 份。
 *
 * 阈值按**空间**区分：语义向量与词袋向量的分布不同，同一组阈值不能通用。
 * 详见 core/config.js 的 SEM_* 常量说明。
 */
async function upsertCandidate(deps, cand, mood, now, fGain, scope) {
  const { domain, index, log } = deps;
  const memories = domain.table("memories");

  // 语义向量：取不到就只用词汇空间去重 —— 宁可漏一次去重，
  // 也不要让写入因网络失败而阻塞。
  const sem = await semanticOf(deps, cand.text);
  const lexVec = embed(cand.text, deps.dim);

  const nearSem = sem ? index.searchSemantic(sem, 3, SEM_DEDUP_THRESHOLD) : [];
  const nearLex = index.search(lexVec, 3, DEDUP_THRESHOLD);
  const near = dedupeMerge(nearSem, nearLex);

  if (near.length > 0) {
    const targetId = near[0].id;
    const cur = memories.get(targetId);
    if (cur && (cur.tier ?? "active") !== "dormant") {
      const gapMs = now - (cur.lastRecallAt ?? cur.createdAt ?? now);
      const rAtRecall = retention(cur.tier ?? "active", cur.stability ?? 3, gapMs);
      const next = {
        ...cur,
        stability: grow(cur.stability ?? 3, rAtRecall, fGain),
        recallCount: (cur.recallCount ?? 0) + 1,
        recurred: (cur.recurred ?? 0) + 1,
        lastRecallAt: now,
        lastDecayAt: now,
      };
      // 写入路径上的重复不计入「跨时间确认」，因此只累加 recallCount
      // 但绝不在此晋升：晋升交给 recall 路径（见 touchRecalled）
      await memories.put(targetId, next);
      index.put(targetId, next.text ?? cur.text, { ...next, sem: sem ?? undefined });
      if (sem) await putSemVec(deps, targetId, sem);
      return { id: targetId, action: "recur", tier: next.tier };
    }
  }

  // 新建
  const id = nid("mem");
  const st = initState(cand.level);
  const rec = {
    id,
    text: cand.text,
    kind: cand.kind,
    tier: st.tier,
    importance: clamp01(cand.importance),
    // initState 返回的是 stability，不是 s。写成 st.s 会落盘 undefined，
    // 而 schema 里 stability 是 optional，所以不报错 —— 静默失效，
    // 该条记忆的 R 永远算作 1，遗忘永不触发。与 decay.js 里踩过的坑同源。
    stability: st.stability,
    recallCount: 0,
    recurred: 0,
    createdAt: now,
    lastRecallAt: now,
    lastDecayAt: now,
    sourceTurn: deps.currentTurnId,
    /** 作用域：项目/会话隔离的依据。召回时按它过滤。 */
    scope,
    tags: cand.tags ?? [],
    /** 内容来源：user / assistant / tool。区分「用户口述」与「模型总结」。 */
    source: cand.source ?? "user",
    /** 安全标记：威胁扫描命中 warn 级时置位，注入时附提示。 */
    tainted: cand.tainted || undefined,
    taintReason: cand.taintReason,
    /** 命中的敏感信息类别。值本身已被掩码，这里只留类别名。 */
    secrets: cand.secrets,
    writeMood: {
      v: mood.v ?? mood.ema?.v ?? 0,
      a: mood.a ?? mood.ema?.a ?? 0,
      labels: mood.labels ?? [],
      theta: writeThreshold(mood.ema),
      inferred: mood.inferred || undefined,
    },
    schemaV: 1,
  };
  await memories.put(id, rec);
  if (rec.tier !== "dormant") index.put(id, rec.text, { ...rec, sem: sem ?? undefined });
  if (sem) await putSemVec(deps, id, sem);
  log?.debug?.(`memory: create ${id} (${rec.kind}/${cand.level}) scope=${scope}`);
  return { id, action: "create", tier: rec.tier };
}

/**
 * 工具路径的写入：`memory_remember` 用。
 *
 * 与 `runJob` 的区别：
 *   · 内容已由模型给定，不需要抽取与判档
 *   · 但仍必须过安全检查（模型也可能被诱导去「记住」一段注入文本）
 *   · 仍必须去重（早期这里是直接 put 新 id，重复调用造出一堆同质记录）
 *
 * @param {object} deps
 * @param {object} cand { text, kind, level, importance, tags, source }
 * @param {string} scope
 * @returns {Promise<{id: string, action: "create"|"recur", tier: string}>}
 */
export async function upsertByTool(deps, cand, scope) {
  const r = screenForWrite(cand.text);
  // 工具路径遇到 critical 级注入：仍然写入，但打上 tainted 标记并在注入时
  // 附风险提示。为什么不直接拒绝 —— 模型是被用户明确要求"记住"这段内容的，
  // 静默丢弃会让用户以为工具坏了。标记后由模型自己判断可信度更合理。
  const mood = { v: 0, a: 0, labels: [], ema: { v: 0, a: 0 } };
  const next = {
    ...cand,
    text: r.text,
    tainted: r.threats.level !== "clean",
    taintReason: r.reason || undefined,
    secrets: r.secrets.length > 0 ? r.secrets : undefined,
  };
  if (!r.accept) await bumpStats(deps.domain, { blocked: 1 });
  return upsertCandidate(deps, next, mood, Date.now(), 1.0, scope);
}

/** 合并两个空间的去重候选，按相似度取最高，去重按 id。 */
function dedupeMerge(a, b) {  const map = new Map();
  for (const h of [...a, ...b]) {
    const cur = map.get(h.id);
    if (!cur || h.sim > cur.sim) map.set(h.id, h);
  }
  return [...map.values()].sort((x, y) => y.sim - x.sim);
}

/** 取语义向量：命中缓存就复用，否则向 embedder 要。失败返回 null。 */
async function semanticOf(deps, text) {
  const { embedder, semCache, log } = deps;
  if (!embedder?.ready?.()) return null;

  const key = hashText(text);
  const cached = semCache?.get?.(key);
  if (cached) return cached;

  try {
    const v = await embedder.embedOne(text);
    if (!v) return null;
    semCache?.set?.(key, v);
    return v;
  } catch (e) {
    log?.debug?.(`memory: 语义嵌入失败 ${e?.message ?? e}`);
    return null;
  }
}

/** 语义向量持久化。不落盘的话每次重启都要重算全库，那等于没接。 */
async function putSemVec(deps, id, vec) {
  try {
    const t = deps.domain.table("semvec");
    if (!t) return;
    await t.put(id, { id, vec: Array.from(vec), dim: vec.length, schemaV: 1 });
  } catch { /* 加速层，落盘失败不影响召回（只是下次要重算） */ }
}

function hashText(text) {
  let h = 2166136261;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * 建边。只在同一 turn 新写入的条目与既有条目之间建，
 * 避免 O(n²) 全量两两比较。
 *
 * 为什么不能只看余弦：词袋哈希下，共享停用词（「的」「要」「不」）
 * 就能把两句无关的话推到 0.24 以上。实测中发现「故障取证」被连到
 * 「报告数据覆盖」——两者唯一的共同点是都有「的」。因此词汇空间加一道
 * 词法门槛：必须存在至少一个「非高频双字词」的真实重叠。
 *
 * 语义空间命中时不需要这道门槛：真 embedding 的相似度本身就排除了
 * 仅共享停用词的情形。
 */
async function buildEdges(deps, written, now) {
  const { domain, index, log } = deps;
  const edges = domain.table("edges");
  const memories = domain.table("memories");

  const created = [];
  for (const w of written) {
    const rec = memories.get(w.id);
    if (!rec?.text) continue;

    const lexVec = embed(rec.text, deps.dim);
    const semVec = index.get(w.id)?.sem;

    const lexNear = index.search(lexVec, 8, REL_THRESHOLD)
      .filter((h) => h.id !== w.id);
    const semNear = semVec
      ? index.searchSemantic(semVec, 8, SEM_REL_THRESHOLD).filter((h) => h.id !== w.id)
      : [];
    const near = dedupeMerge(semNear, lexNear);

    for (const h of near) {
      const other = memories.get(h.id);
      if (!other?.text) continue;

      const viaSem = h.space === "sem";
      // 词法二次确认只对词汇空间命中生效；语义命中自带判别力
      if (!viaSem && sharedContentToken(rec.text, other.text) === null) continue;

      const causal = viaSem
        ? h.sim >= SEM_CAUSAL_THRESHOLD
        : h.sim >= CAUSAL_THRESHOLD;

      const id = nid("edge");
      await edges.put(id, {
        id,
        from: w.id,
        to: h.id,
        rel: causal ? "causal" : "related",
        weight: clamp01(h.sim),
        via: h.space,
        createdAt: now,
        schemaV: 1,
      });
      created.push(id);
    }
  }
  if (created.length > 0) log?.debug?.(`memory: built ${created.length} edges`);
  return created;
}

/**
 * 停用双字词与伪双字。
 *
 * 为什么要包含「的时」这类：中文按双字切分会跨越词边界产生大量伪词，
 * 「…的时|候…」和「…的时|间…」共享「的时」，但语义毫无关系。
 * 判据：以结构助词/介词开头或结尾的双字组合一律视为伪词。
 */
const STOP_CHARS = new Set([..."的了着过和与及或但而且就都也还很太更最只仅再又才已经是需要有在被把让给对从向往于为以之其这那哪什怎样么"]);

function isPseudoGram(g) {
  if (STOP_CHARS.has(g[0]) || STOP_CHARS.has(g[1])) return true;
  return STOP_BIGRAMS.has(g);
}

/** 明确的高频双字词，即便两字都不是停用字也挡掉 */
const STOP_BIGRAMS = new Set([
  "我们", "你们", "他们", "自己", "什么", "怎么", "因为", "所以",
  "但是", "然后", "现在", "时候", "东西", "事情", "问题", "情况",
  "地方", "方面", "方式", "方法", "内容", "部分", "一直", "非常",
]);

/**
 * 找两条文本共享的「实义」双字词。无重叠返回 null。
 *
 * 要求：共享至少 1 个伪词过滤后的双字词，且该词不能是单字重复。
 */
function sharedContentToken(a, b) {
  const grams = (s) => {
    const out = new Set();
    const t = String(s ?? "");
    for (let i = 0; i + 1 < t.length; i += 1) {
      const g = t.slice(i, i + 2);
      if (!/^[\u4e00-\u9fa5]{2}$/.test(g)) continue;
      if (g[0] === g[1]) continue;        // 「谢谢」「常常」这类叠字
      if (isPseudoGram(g)) continue;      // 含虚字或整词停用
      out.add(g);
    }
    return out;
  };
  const ga = grams(a);
  if (ga.size === 0) return null;
  for (const g of grams(b)) if (ga.has(g)) return g;
  return null;
}

/** 累加 stats。读改写走 update 保证原子，且只在 global 存在时执行。 */
async function bumpStats(domain, deltas) {
  const g = domain.global.get();
  if (!g) return;
  const stats = { ...(g.stats ?? {}) };
  for (const [k, v] of Object.entries(deltas)) {
    stats[k] = (stats[k] ?? 0) + v;
  }
  await domain.global.set({ ...g, stats });
}

/**
 * 召回：语义 + 词汇 + 词法 + 图扩展四路合并，然后四因子重排。
 *
 * dormant 只能经图通道进来——这是「遗忘但可唤醒」的实现点。
 * 若 dormant 也能向量召回，遗忘就退化成「排序靠后」。
 *
 * ## 两个必守的门
 *
 * 1. **绝对分数下限**（RECALL_MIN_SCORE）。没有它，重排里
 *    importance/retention/recency 合计 0.45 会给任何一条新写入的
 *    important 记忆接近 0.39 的基线分，库小时等于「每轮全量注入」。
 * 2. **作用域过滤**。A 项目的决策不该出现在 B 项目的召回里。
 *
 * ## 为什么是同步的
 *
 * `systemPrompt.context()` 的 provider 必须是同步函数。语义**查询**向量
 * 由 `agent/pre-step` 提前算好放进 `opts.queryVec`；没有就只用词汇空间。
 *
 * @param {object} deps
 * @param {string} query
 * @param {object} [opts] { limit, scope, queryVec, includeDormant, minScore }
 */
export function recall(deps, query, opts = {}) {
  const { domain, index, dim } = deps;
  const now = Date.now();
  const limit = opts.limit ?? RECALL_TOP_K;
  const scope = opts.scope ?? null;
  const memories = domain.table("memories");

  const merged = new Map();

  // ---- 语义空间 ----
  const semVec = opts.queryVec ?? null;
  if (semVec) {
    for (const h of index.searchSemantic(semVec, limit * 3, SEM_REL_THRESHOLD)) {
      merged.set(h.id, { id: h.id, sim: h.sim, via: "semantic", space: "sem" });
    }
  }

  // ---- 词汇空间 ----
  const lexVec = embed(query, dim);
  for (const h of index.search(lexVec, limit * 4)) {
    const cur = merged.get(h.id);
    // 两个空间同一条命中时取最大值：都是「相关」的证据，不分高下
    if (cur) cur.sim = Math.max(cur.sim, h.sim);
    else merged.set(h.id, { id: h.id, sim: h.sim, via: "vector", space: "lex" });
  }

  // ---- 词法精确命中（专有名词、编号、约定）----
  for (const h of lexicalSearch(index, query, limit * 2)) {
    const cur = merged.get(h.id);
    if (cur) {
      cur.sim = Math.max(cur.sim, h.sim);
      if (h.sim > 0.5) cur.via = "lexical";
    } else merged.set(h.id, { id: h.id, sim: h.sim, via: "lexical", space: "lex" });
  }

  // ---- 图扩展：从种子沿边找邻居 ----
  //
  // ⚠ 顺序很关键：先按绝对下限筛出**够格的种子**，再从它们扩散。
  //
  // 早期写法是「全部命中都当种子，扩散完再统一卡下限」。那样 dormant
  // 永远出不来：dormant 不进向量索引，它只能经图通道被找到，而图命中
  // 的相似度是刻意保守的 0.35、retention 又接近 0 —— 四项加权后大约
  // 0.29，任何有意义的绝对下限都会把它全部滤掉。「遗忘但可通过联想
  // 唤醒」于是成了死代码。
  //
  // 正确语义是：**唤醒的门槛应该由种子决定，不该由被唤醒者决定**。
  // 用户提到的事足够相关（种子过线）→ 与它相连的旧事就值得带出来；
  // 反过来要求一条已经遗忘的记录自己也满足新鲜度/重要度门槛，等于
  // 要求它没被忘。
  const minScore = opts.minScore ?? RECALL_MIN_SCORE;
  const seeds = [];
  if (opts.includeDormant !== false) {
    for (const c of merged.values()) {
      const rec = memories.get(c.id);
      if (!rec || !scopeAllows(rec, scope)) continue;
      if ((rec.tier ?? "active") === "dormant") continue; // 遗忘件不做种子
      if (scoreOf(c, rec, index, now) < minScore) continue;
      seeds.push(c.id);
    }
  }

  if (seeds.length > 0) {
    // 只为种子集建邻接，不做全表物化（P3-2）
    const edgeRows = [...domain.table("edges").entries()].map(([, e]) => e);
    const adj = buildAdjacency(edgeRows, seeds);
    // 邻接里只关心目标记录，按需查
    const probe = { get: (id) => memories.get(id) };
    for (const h of graphExpand(seeds, adj, probe, 1)) {
      if (merged.has(h.id)) continue;
      // 通过关联边命中的条目，相似度给一个保守值：不是直接匹配，
      // 但也确实相关，不能给 0 让它在重排里被完全压掉。
      merged.set(h.id, { id: h.id, sim: 0.35, via: "graph", space: "lex" });
    }
  }

  // ---- 作用域 + 存在性过滤（在重排前做，省算力）----
  const cands = [];
  for (const c of merged.values()) {
    const rec = memories.get(c.id);
    if (!rec) continue;
    if (!scopeAllows(rec, scope)) continue;
    cands.push({ ...c, rec });
  }
  if (cands.length === 0) return [];

  const scored = rerank(cands, index, now, WEIGHTS, memories);

  const out = [];
  for (const s of scored) {
    const via = cands.find((c) => c.id === s.id)?.via ?? "vector";
    /**
     * 图通道不参与绝对下限 —— 它的准入在上一段（种子过线）已经决定了。
     *
     * 这不是放宽标准：能被带出来的 dormant 一定连着一条**当下确实相关**
     * 的活记忆。拿被唤醒者自身的新鲜度/重要度再卡一道，等于要求一条
     * 已经遗忘的记录"自己证明自己还新鲜"，逻辑上不可能成立。
     */
    if (via !== "graph" && s.score < minScore) continue;
    const rec = memories.get(s.id);
    if (!rec) continue;
    out.push({
      id: s.id,
      text: rec.text ?? "",
      tier: rec.tier ?? "active",
      kind: rec.kind,
      importance: rec.importance ?? 0.4,
      score: s.score,
      sim: s.sim,
      via,
      space: s.space,
      tainted: rec.tainted,
      taintReason: rec.taintReason,
      scope: rec.scope ?? "global",
    });
  }

  return quantize(out, SCORE_QUANTUM).slice(0, limit);
}

/**
 * 单条候选的最终分数。
 *
 * 存在的意义是让「种子是否够格」与「最终排序」用**完全相同**的算式。
 * 若这里另写一套（比如只按 sim 判断种子），种子线与输出线会不一致，
 * 表现为「明明过线了却没出现在结果里」这类难查的偏差。
 */
function scoreOf(cand, rec, index, nowMs) {
  const one = rerank([{ ...cand, rec }], index, nowMs, WEIGHTS, { get: () => rec });
  return one[0]?.score ?? 0;
}

/**
 * 作用域是否允许这条记录进入本次召回。
 *
 * 规则：
 *   · scope 为 null（调用方不限定）→ 全部允许
 *   · 记录 scope 为 "global" → 允许（全局偏好适用于任何项目）
 *   · 其余必须精确相等
 *
 * 为什么 global 永远放行：用户说「以后都用中文」是对人的约定，
 * 不是对某个项目仓库的约定。把它锁在某个 scope 里等于丢失。
 */
function scopeAllows(rec, scope) {
  if (!scope) return true;
  const rs = rec.scope ?? "global";
  if (rs === "global") return true;
  return rs === scope;
}

/** 召回后更新被命中条目的状态（grow / 唤醒 / 晋升） */
export async function touchRecalled(deps, hits, fGain = 1.0) {
  const { domain, index } = deps;
  const memories = domain.table("memories");
  const now = Date.now();
  let revived = 0;
  let promoted = 0;

  for (const h of hits) {
    const rec = memories.get(h.id);
    if (!rec) continue;

    if ((rec.tier ?? "active") === "dormant") {
      const { reviveNode } = await import("../core/decay.js");
      // 传 now：reviveNode 要把 lastDecayAt/lastRecallAt 推进到当前时刻，
      // 否则下一轮 settle 用同一个旧锚点算出相同的过期 R，刚唤醒的条目
      // 立刻又被判遗忘，形成无限唤醒循环。
      const next = { ...rec, ...reviveNode(rec, now) };
      await memories.put(h.id, next);
      index.put(h.id, next.text ?? "", next);
      // 唤醒后补回语义向量，否则它只能靠词汇空间被召回
      await restoreSemvec(deps, h.id);
      revived += 1;
      continue;
    }

    const gapMs = now - (rec.lastRecallAt ?? rec.createdAt ?? now);
    const rAtRecall = retention(rec.tier ?? "active", rec.stability ?? 3, gapMs);
    const next = {
      ...rec,
      stability: grow(rec.stability ?? 3, rAtRecall, fGain),
      recallCount: (rec.recallCount ?? 0) + 1,
      lastRecallAt: now,
      lastDecayAt: now,
    };
    if (shouldPromote(next)) {
      next.tier = "long";
      promoted += 1;
    }
    await memories.put(h.id, next);
    index.put(h.id, next.text ?? "", next);
    await restoreSemvec(deps, h.id);
  }

  if (revived || promoted) {
    await bumpStats(domain, { recalled: hits.length, revived, promoted });
  } else if (hits.length) {
    await bumpStats(domain, { recalled: hits.length });
  }
  return { revived, promoted, touched: hits.length };
}

/** 把持久化的语义向量补回索引（重启后、唤醒后都需要）。 */
async function restoreSemvec(deps, id) {
  try {
    const t = deps.domain.table("semvec");
    if (!t) return;
    const row = t.get(id);
    if (row?.vec) deps.index.attachSemantic(id, Float32Array.from(row.vec));
  } catch { /* 加速层，失败只影响语义召回率 */ }
}

/**
 * 惰性结算扫描：把已过期的 active 转 dormant、long 降级，
 * 并清理「彻底遗忘」的条目与孤儿边。
 *
 * 只在启动时与每次召回后跑增量，不做全量遍历定时器。
 *
 * @param {object} deps
 * @param {number} [limit] 本次最多扫描多少条
 */
export async function sweep(deps, limit = 200) {
  const { domain, index, log } = deps;
  const memories = domain.table("memories");
  const now = Date.now();
  let forgot = 0;
  let demoted = 0;
  let purged = 0;
  let seen = 0;

  const ttlMs = (Number(deps.config?.dormantTtlDays) > 0
    ? Number(deps.config.dormantTtlDays)
    : DORMANT_TTL_DAYS) * DAY_MS;

  for (const [id, rec] of memories.entries()) {
    if (seen >= limit) break;
    seen += 1;
    const tier = rec.tier ?? "active";

    /**
     * dormant 的清理：超过 TTL 且从未被唤醒过的，按「彻底遗忘」物理删除。
     *
     * 为什么必须做：早期设计里 dormant「永不删除，只增不减」。它的语义是
     * 「遗忘但不删除」，但**遗忘**本来就意味着信息已经无用；让它永久占盘
     * 且永久参与图扩展，等于把「不删」当成目标而非手段。
     *
     * 判据用「遗忘时刻 + TTL」而不是「创建时刻」：一条老记忆可能刚被遗忘
     * 一分钟，此时按创建时刻算会被立刻删掉，那就不叫 TTL 了。
     */
    if (tier === "dormant") {
      const since = rec.forgotAt ?? rec.lastDecayAt ?? rec.createdAt ?? now;
      if (now - since > ttlMs) {
        await memories.delete(id);
        index.drop(id);
        await dropSemvec(deps, id);
        purged += 1;
      }
      continue;
    }

    const st = settle(rec, now);
    if (!st.event) continue;

    const next = { ...rec, tier: st.tier, stability: st.s ?? rec.stability };
    if (st.event === "forget") {
      next.forgotAt = st.forgotAt ?? now;
      next.lastDecayAt = st.forgotAt ?? now;
      index.drop(id); // dormant 剥离索引，只能经图唤醒
      forgot += 1;
    } else if (st.event === "demote") {
      next.lastDecayAt = st.anchor ?? now;
      index.put(id, next.text ?? "", next);
      await restoreSemvec(deps, id);
      demoted += 1;
    }
    await memories.put(id, next);
  }

  // 孤儿边清理：两端有任一端已不存在的边删掉。
  // 不做的话边表只增不减，每轮召回的全表扫描成本会持续上升。
  const orphans = await pruneOrphanEdges(deps);

  // 容量上限：超了就从权重最低的 dormant 开始淘汰
  const overflow = await enforceCap(deps);

  if (forgot || demoted || purged || orphans || overflow) {
    await bumpStats(domain, { forgotten: forgot, purged, edgesPruned: orphans, evicted: overflow });
    log?.debug?.(`memory: sweep forgot=${forgot} demoted=${demoted} purged=${purged} edges=${orphans} evicted=${overflow}`);
  }
  return { forgot, demoted, purged, orphans, evicted: overflow, scanned: seen };
}

/** 删除一条记忆时同步清掉它的语义向量。 */
async function dropSemvec(deps, id) {
  try {
    const t = deps.domain.table("semvec");
    if (t?.delete) await t.delete(id);
  } catch { /* 加速层 */ }
}

/**
 * 清理孤儿边。
 *
 * @returns {Promise<number>} 删除的边数
 */
export async function pruneOrphanEdges(deps) {
  const { domain } = deps;
  const edges = domain.table("edges");
  const memories = domain.table("memories");
  let n = 0;
  for (const [key, e] of [...edges.entries()]) {
    if (!e?.from || !e?.to) { await edges.delete(key); n += 1; continue; }
    if (!memories.get(e.from) || !memories.get(e.to)) {
      await edges.delete(key);
      n += 1;
    }
  }
  return n;
}

/**
 * 容量上限。超出时按「权重最低的 dormant 优先」淘汰。
 *
 * 顺序刻意如此：先淘汰 dormant（已遗忘、无人引用），绝不因为超容量而
 * 删 long / critical —— 那等于让上限把最重要的记忆先干掉。
 *
 * @returns {Promise<number>} 淘汰条数
 */
async function enforceCap(deps) {
  const { domain, index } = deps;
  const cap = Number(deps.config?.memCap) > 0 ? Number(deps.config.memCap) : MEM_CAP;
  const memories = domain.table("memories");
  if (memories.size <= cap) return 0;

  const overflow = memories.size - cap;
  const victims = [...memories.entries()]
    .filter(([, r]) => (r.tier ?? "active") === "dormant")
    .map(([id, r]) => ({
      id,
      w: (r.importance ?? 0) * retention("active", r.stability ?? 3, Date.now() - (r.lastDecayAt ?? 0)),
    }))
    .sort((a, b) => a.w - b.w)
    .slice(0, overflow);

  const edges = domain.table("edges");
  for (const v of victims) {
    await memories.delete(v.id);
    index.drop(v.id);
    await dropSemvec(deps, v.id);
    // 顺带清掉它的边，避免下一轮再扫一遍
    for (const [key, e] of [...edges.entries()]) {
      if (e?.from === v.id || e?.to === v.id) await edges.delete(key);
    }
  }
  return victims.length;
}

/**
 * 清理过期的 failed journal 记录。
 *
 * 早期版本失败 3 次后标记 failed 就再也不动，队列只增不减。
 * 这里按 TTL 清掉。
 */
export async function pruneJournal(deps) {
  const { domain } = deps;
  const journal = domain.table("journal");
  const now = Date.now();
  const ttl = FAILED_JOB_TTL_DAYS * DAY_MS;
  let n = 0;
  for (const [key, j] of [...journal.entries()]) {
    if ((j?.status ?? "pending") !== "failed") continue;
    const at = j.enqueuedAt ?? 0;
    if (now - at > ttl) { await journal.delete(key); n += 1; }
  }
  if (n > 0) await bumpStats(domain, { jobsFailedPruned: n });
  return n;
}

/**
 * 批量清除。供 `memory_manage(clear)` 调用。
 *
 * 与 `forget` 的区别：这个是**批量**、**按条件**、**不可恢复**。
 * 用户行使「删除我的数据」必须能一次做完，而不是一条条让模型调工具。
 *
 * @param {object} deps
 * @param {object} opts { scope?, before?, tier?, dryRun? }
 */
export async function clearMemories(deps, opts = {}) {
  const { domain, index } = deps;
  const memories = domain.table("memories");
  const edges = domain.table("edges");
  const semvec = domain.table("semvec");

  const victims = [];
  for (const [id, r] of memories.entries()) {
    if (opts.scope && (r.scope ?? "global") !== opts.scope) continue;
    if (opts.before && (r.createdAt ?? 0) >= opts.before) continue;
    if (opts.tier && (r.tier ?? "active") !== opts.tier) continue;
    victims.push(id);
  }

  if (opts.dryRun) return { matched: victims.length, deleted: 0 };

  const set = new Set(victims);
  for (const id of victims) {
    await memories.delete(id);
    index.drop(id);
    try { if (semvec) await semvec.delete(id); } catch { /* 加速层 */ }
  }
  let edgeCount = 0;
  for (const [key, e] of [...edges.entries()]) {
    if (set.has(e?.from) || set.has(e?.to)) { await edges.delete(key); edgeCount += 1; }
  }

  await bumpStats(domain, { cleared: victims.length });
  return { matched: victims.length, deleted: victims.length, edges: edgeCount };
}

export { bumpStats, scopeAllows, RECALL_MIN_SCORE };

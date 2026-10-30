/**
 * 写入管线：抽取 → 心情 → 门槛 → 去重/关联 → 落盘 → 投影。
 *
 * 由 Journal worker 调用，一次处理一个 turn。任何一步失败都不影响其它步：
 * 记忆系统是旁路设施，绝不能因为自身异常让对话失败。
 */

import {
  LEVELS, WEIGHTS, RECALL_TOP_K, SCORE_QUANTUM, DAY_MS,
  REL_THRESHOLD, CAUSAL_THRESHOLD, DEDUP_THRESHOLD, JOB_MAX_ATTEMPTS,
} from "../core/config.js";
import { initState, settle, grow, shouldPromote, retention } from "../core/decay.js";
import { extract, shouldWrite, jevClassify, classifyKind, classifyLevel } from "./extract.js";
import { aggregate, normalizeMood, updateEma, effectiveEma, writeThreshold, gainFactor } from "../mood/model.js";
import { embed, quantize, lexicalSearch, graphExpand, rerank } from "../storage/vector.js";

let seq = 0;
const nid = (prefix) => `${prefix}_${Date.now().toString(36)}_${(seq += 1).toString(36)}`;

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * 处理一个 turn 载荷。
 *
 * @param {object} deps 依赖注入：{ domain, index, log, config, global }
 * @param {object} payload { userText, assistantText }
 * @param {object} job 队列记录，含 turnId / sessionId
 */
export async function runJob(deps, payload, job) {
  const { domain, index, log, config } = deps;
  const memories = domain.table("memories");
  const edges = domain.table("edges");
  const now = Date.now();

  // ---- 1. 心情：先算，因为它决定本轮的写入门槛 ----
  const mood = await resolveMood(deps, payload, now);
  const theta = writeThreshold(mood.ema);
  const fGain = gainFactor(mood.ema);

  // ---- 2. 抽取 ----
  // importance 只由档位决定；心情的效价只作用于 θ（上一步已算好）
  const { candidates } = extract(payload, null);

  // ---- 3. 可选 Jev 覆盖（P3 期）----
  let jevUsed = 0;
  if (config.jevEndpoint && config.jevApiKey) {
    for (const c of candidates) {
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

  // ---- 4. 逐条写入 ----
  const written = [];
  for (const cand of candidates) {
    if (!shouldWrite(cand, theta)) continue;
    const rec = await upsertCandidate(deps, cand, mood, now, fGain);
    if (rec) written.push(rec);
  }

  // ---- 5. 建边：新条目与既有条目之间的关系 ----
  if (written.length > 0) {
    await buildEdges(deps, written, now);
  }

  // ---- 6. 统计埋点 ----
  await bumpStats(domain, {
    jobsDone: 1,
    moodTotal: mood.raw ? 1 : 0,
    moodRejected: mood.raw && !mood.accepted ? 1 : 0,
    multiLabel: (mood.labels?.length ?? 0) > 1 ? 1 : 0,
    jevDegraded: jevUsed < candidates.length ? 1 : 0,
  });

  log?.debug?.(`memory: job ${job?.id} wrote ${written.length}/${candidates.length}, theta=${theta.toFixed(3)}`);
  return { ok: true, written: written.length };
}

/**
 * 心情解析。优先读自制心情插件写入的 global，其次读载荷里直传的值。
 * 读不到就当中性——心情是调制项，缺失不应阻断写入。
 */
async function resolveMood(deps, payload, now) {
  const { domain } = deps;
  const g = domain.global.get();
  const prevEma = { v: g?.emaV ?? 0, a: g?.emaA ?? 0, at: g?.moodAt ?? 0 };

  // 载荷直传（自制心情插件在本轮结束时推入）
  const raw = payload?.mood ?? null;
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
  return { ema, raw, accepted: true, labels: norm.labels, v, a };
}

/**
 * 写入或更新一条候选记忆。
 *
 * 去重策略：先向量近邻找同实体，再判是否同一事实。
 * 同一事实 → 视为「再次提及」，走召回增益而非新建，避免同一句话存 20 份。
 */
async function upsertCandidate(deps, cand, mood, now, fGain) {
  const { domain, index } = deps;
  const memories = domain.table("memories");

  const vec = embed(cand.text, deps.dim);
  const near = index.search(vec, 3).filter((h) => h.sim >= DEDUP_THRESHOLD);

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
      index.put(targetId, next.text ?? cur.text, next);
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
    tags: cand.tags ?? [],
    writeMood: {
      v: mood.v ?? mood.ema?.v ?? 0,
      a: mood.a ?? mood.ema?.a ?? 0,
      labels: mood.labels ?? [],
      theta: writeThreshold(mood.ema),
    },
    schemaV: 1,
  };
  await memories.put(id, rec);
  if (rec.tier !== "dormant") index.put(id, rec.text, rec);
  return { id, action: "create", tier: rec.tier };
}

/**
 * 建边。只在同一 turn 新写入的条目与既有条目之间建，
 * 避免 O(n²) 全量两两比较。
 *
 * 为什么不能只看余弦：词袋哈希下，共享停用词（「的」「要」「不」）
 * 就能把两句无关的话推到 0.24 以上。实测中发现「故障取证」被连到
 * 「报告数据覆盖」——两者唯一的共同点是都有「的」。因此加一道
 * 词法门槛：必须存在至少一个「非高频双字词」的真实重叠。
 */
async function buildEdges(deps, written, now) {
  const { domain, index, log } = deps;
  const edges = domain.table("edges");
  const memories = domain.table("memories");

  const created = [];
  for (const w of written) {
    const rec = memories.get(w.id);
    if (!rec?.text) continue;
    const vec = embed(rec.text, deps.dim);
    const near = index.search(vec, 8).filter((h) => h.id !== w.id && h.sim >= REL_THRESHOLD);

    for (const h of near) {
      const other = memories.get(h.id);
      if (!other?.text) continue;
      // 词法二次确认：挡掉只靠停用字相连的伪相关
      if (sharedContentToken(rec.text, other.text) === null) continue;

      const id = nid("edge");
      await edges.put(id, {
        id,
        from: w.id,
        to: h.id,
        rel: h.sim >= CAUSAL_THRESHOLD ? "causal" : "related",
        weight: clamp01(h.sim),
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
 * 召回：向量 + 词法 + 图扩展三路并行，然后四因子重排。
 *
 * dormant 只能经图通道进来——这是「遗忘但可唤醒」的实现点。
 * 若 dormant 也能向量召回，遗忘就退化成「排序靠后」。
 */
export function recall(deps, query, opts = {}) {
  const { domain, index, dim } = deps;
  const now = Date.now();
  const limit = opts.limit ?? RECALL_TOP_K;
  const memories = domain.table("memories");
  const edgesTable = domain.table("edges");

  const vec = embed(query, dim);
  const vecHits = index.search(vec, limit * 3);
  const lexHits = lexicalSearch(index, query, limit * 2);

  // 合并向量与词法，取最高分
  const merged = new Map();
  for (const h of vecHits) merged.set(h.id, { id: h.id, sim: h.sim, via: "vector" });
  for (const h of lexHits) {
    const cur = merged.get(h.id);
    if (cur) cur.sim = Math.max(cur.sim, h.sim);
    else merged.set(h.id, { id: h.id, sim: h.sim, via: "lexical" });
  }

  // 图扩展：从种子节点沿边找邻居。dormant 由此进入候选——它们不在索引里，
  // 这是唯一能触达它们的通道，也是「遗忘但可回想」的实现点。
  const edges = [...edgesTable.entries()].map(([, e]) => e);
  const byId = new Map([...memories.entries()].map(([k, v]) => [k, v]));
  const graphHits = graphExpand([...merged.keys()], edges, byId, 1);
  for (const h of graphHits) {
    if (merged.has(h.id)) continue;
    // 通过关联边命中的条目，相似度给一个保守值：不是直接匹配，
    // 但也确实相关，不能给 0 让它在重排里被完全压掉。
    merged.set(h.id, { id: h.id, sim: 0.35, via: "graph" });
  }

  // 重排。必须把 memories 作为 lookup 传进去：
  // dormant 记录已被剥离索引，只查 index 会让它们在此静默消失。
  const cands = [...merged.values()];
  const scored = rerank(cands, index, now, WEIGHTS, memories);

  const out = [];
  for (const s of scored) {
    const rec = memories.get(s.id);
    if (!rec) continue;
    out.push({
      id: s.id,
      text: rec.text ?? "",
      tier: rec.tier ?? "active",
      kind: rec.kind,
      importance: rec.importance ?? 0.4,
      score: s.score,
      via: cands.find((c) => c.id === s.id)?.via ?? "vector",
    });
  }

  return quantize(out, SCORE_QUANTUM).slice(0, limit);
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
  }

  if (revived || promoted) {
    await bumpStats(domain, { recalled: hits.length, revived, promoted });
  } else if (hits.length) {
    await bumpStats(domain, { recalled: hits.length });
  }
  return { revived, promoted, touched: hits.length };
}

/**
 * 惰性结算扫描：把已过期的 active 转 dormant、long 降级。
 * 只在启动时与每次召回后跑增量，不做全量遍历定时器。
 */
export async function sweep(deps, limit = 200) {
  const { domain, index, log } = deps;
  const memories = domain.table("memories");
  const now = Date.now();
  let forgot = 0;
  let demoted = 0;
  let seen = 0;

  for (const [id, rec] of memories.entries()) {
    if (seen >= limit) break;
    seen += 1;
    if ((rec.tier ?? "active") === "dormant") continue;

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
      demoted += 1;
    }
    await memories.put(id, next);
  }

  if (forgot || demoted) {
    await bumpStats(domain, { forgotten: forgot });
    log?.debug?.(`memory: sweep forgot=${forgot} demoted=${demoted}`);
  }
  return { forgot, demoted, scanned: seen };
}

export { bumpStats };

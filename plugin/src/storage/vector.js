/**
 * 进程内向量索引：双空间 + 暴力余弦。
 *
 * ## 为什么是两个空间，而不是一个
 *
 * 历史版本只有一个词袋哈希向量，`Embedder` 配好了却没接进来 —— 用户填了
 * 嵌入模型、`embed_status` 报「可用」，召回质量却完全不变化。这是最坏的一类
 * 缺陷：不报错、有反馈、没效果。
 *
 * 现在两个空间并存，各自独立：
 *
 *   lex  —— 词袋哈希，**同步**，永远可用。负责字面命中（专有名词、编号、
 *           命令、约定），也是嵌入不可用时的完整退路。
 *   sem  —— 真 embedding，**异步**。负责「那家店」↔「望京小腰」这类字面
 *           无重叠的语义召回。
 *
 * 为什么不能合成一个：两者维度不同（lex 由 config.dim 定，sem 由模型定，
 * bge-m3 是 1024，text-embedding-3-small 是 1536），而且可用性不同 ——
 * 语义向量要等网络返回，词汇向量当场就有。强行统一会让「嵌入暂时不可用」
 * 变成「整个索引不可用」。
 *
 * ## 为什么同步
 *
 * `systemPrompt.context()` 的 text provider 是同步函数，召回必须在它里面
 * 同步完成。因此语义**查询**向量由 `agent/pre-step` 提前算好放进缓存，
 * 召回时只做同步的余弦计算。写入侧的语义向量则在 worker 里 await 得到。
 *
 * ## 派生性
 *
 * 两个空间都完全由 KV 投影而来，可随时丢弃重建。dormant 条目不进任何空间 ——
 * 它们只能经关联边唤醒，否则「遗忘」退化为「排序靠后」。
 */

import {
  DAY_MS, MIN_VEC_SIM, SEM_REL_THRESHOLD, SEM_CAUSAL_THRESHOLD,
} from "../core/config.js";

const DEFAULT_DIM = 256;

/** 轻量确定性哈希：不依赖外部 tokenizer，保证同一文本永远同一向量 */
function tokenize(text) {
  const out = [];
  const norm = String(text ?? "").toLowerCase();
  // 中文按字切分（单字 + 双字），英文按词切分
  const words = norm.match(/[a-z0-9_]+|[\u4e00-\u9fa5]/g) ?? [];
  for (let i = 0; i < words.length; i += 1) {
    out.push(words[i]);
    if (i + 1 < words.length) out.push(words[i] + words[i + 1]);
  }
  return out;
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 词袋 + 哈希嵌入（词汇空间）。不是语义模型，但对「同一实体的不同提及」
 * 仍有召回力，且零依赖、可复现、全同步。
 */
export function embed(text, dim = DEFAULT_DIM) {
  const vec = new Float32Array(dim);
  const toks = tokenize(text);
  if (toks.length === 0) return vec;
  for (const t of toks) {
    const h = hash32(t);
    const idx = h % dim;
    const sign = (h >>> 31) === 1 ? -1 : 1;
    vec[idx] += sign;
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i += 1) vec[i] /= norm;
  return vec;
}

/**
 * 余弦。维度不一致时返回 NaN 而不是 0 —— 调用方必须能识别「算不了」，
 * 而不是把它当成「不相似」。历史版本里 dim 热改会让 b[i] 越界成 undefined，
 * 点积变 NaN，`sim > 0.05` 恒假，向量通道静默全空。
 */
function cosine(a, b) {
  if (!a || !b) return NaN;
  if (a.length !== b.length) return NaN;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return Number.isFinite(dot) ? dot : NaN;
}

export class VectorIndex {
  constructor(dim = DEFAULT_DIM) {
    this.dim = dim;
    /** id -> { lex, sem, tier, importance, stability, createdAt, lastRecallAt, text, tags } */
    this.map = new Map();
    /** 语义维度。0 表示还没有成功过一次语义嵌入。 */
    this.semDim = 0;
  }

  get size() { return this.map.size; }

  /** 已带语义向量的条数。用于界面与日志「语义覆盖率」。 */
  get semanticCount() {
    let n = 0;
    for (const rec of this.map.values()) if (rec.sem) n += 1;
    return n;
  }

  /**
   * 写入（或覆盖）一条。**同步**，只算词汇向量。
   *
   * @param {string} id
   * @param {string} text
   * @param {object} [meta] 可带 `sem`（Float32Array）直接注入语义向量，
   *   由已经 await 过 embedder 的调用方提供。
   */
  put(id, text, meta) {
    const sem = normalizeVec(meta?.sem);
    if (sem) this.semDim = sem.length;
    this.map.set(id, {
      lex: embed(text, this.dim),
      sem,
      tier: meta?.tier ?? "active",
      importance: meta?.importance ?? 0.4,
      stability: meta?.stability ?? 3,
      createdAt: meta?.createdAt ?? Date.now(),
      lastRecallAt: meta?.lastRecallAt ?? meta?.createdAt ?? Date.now(),
      text: text ?? "",
      tags: meta?.tags ?? [],
    });
  }

  /**
   * 单独补上语义向量（写入后端异步回来时用）。
   *
   * 为什么不在 put 里等：写入链路里 put 是最后一个同步动作，语义向量
   * 可能还没回来。等它会让一次写入的尾延迟取决于网络。因此先落词汇向量
   * （保证立刻可召回），语义向量回来后补上。
   *
   * @returns {boolean} 是否成功补上
   */
  attachSemantic(id, sem) {
    const rec = this.map.get(id);
    const vec = normalizeVec(sem);
    if (!rec || !vec) return false;
    if (this.semDim && vec.length !== this.semDim) return false;
    this.semDim = vec.length;
    rec.sem = vec;
    return true;
  }

  drop(id) { this.map.delete(id); }

  clear() { this.map.clear(); this.semDim = 0; }

  /**
   * 全量重建。KV 是权威，索引随时可弃。
   *
   * @param {object[]} rows
   * @param {Map<string, Float32Array>|null} [semVectors] id → 语义向量。
   *   通常来自 `semvec` 表（持久化的语义向量），没有就只建词汇空间。
   */
  rebuild(rows, semVectors) {
    this.map.clear();
    this.semDim = 0;
    for (const row of rows) {
      if (!row?.text) continue;
      if ((row.tier ?? "active") === "dormant") continue; // dormant 只经图通道
      const sem = semVectors?.get?.(row.id);
      this.put(row.id, row.text, { ...row, sem });
    }
    return this.map.size;
  }

  /**
   * 词汇空间召回。返回 [{id, sim}]，仅 active / long。
   *
   * minSim 默认取 MIN_VEC_SIM；NaN（维度不符）一律丢弃 —— 宁可少召回，
   * 不要用错误的相似度参与排序。
   */
  search(queryVec, limit = 20, minSim = MIN_VEC_SIM) {
    const hits = [];
    for (const [id, rec] of this.map) {
      if (rec.tier === "dormant") continue;
      const sim = cosine(queryVec, rec.lex);
      if (!Number.isFinite(sim)) continue;
      if (sim > minSim) hits.push({ id, sim, space: "lex" });
    }
    hits.sort((x, y) => y.sim - x.sim);
    return hits.slice(0, limit);
  }

  /**
   * 语义空间召回。查询向量缺失或维度不符时返回空数组，
   * 调用方自然会退回到词汇空间。
   */
  searchSemantic(queryVec, limit = 20, minSim = SEM_REL_THRESHOLD) {
    const q = normalizeVec(queryVec);
    if (!q || !this.semDim || q.length !== this.semDim) return [];
    const hits = [];
    for (const [id, rec] of this.map) {
      if (rec.tier === "dormant" || !rec.sem) continue;
      const sim = cosine(q, rec.sem);
      if (!Number.isFinite(sim)) continue;
      if (sim >= minSim) hits.push({ id, sim, space: "sem" });
    }
    hits.sort((x, y) => y.sim - x.sim);
    return hits.slice(0, limit);
  }

  get(id) { return this.map.get(id); }

  entries() { return this.map.entries(); }
}

/** 把各种输入归一成 Float32Array；认不出返回 null。 */
function normalizeVec(v) {
  if (!v) return null;
  if (v instanceof Float32Array) return v.length > 0 ? v : null;
  if (Array.isArray(v)) return v.length > 0 ? Float32Array.from(v) : null;
  if (ArrayBuffer.isView(v)) return Float32Array.from(v);
  return null;
}

/** 词法召回：tags 与原文子串精确命中，覆盖专有名词、编号、约定 */
export function lexicalSearch(index, query, limit = 20) {
  const q = String(query ?? "").toLowerCase().trim();
  if (!q) return [];
  const hits = [];
  for (const [id, rec] of index.map) {
    if (rec.tier === "dormant") continue;
    let score = 0;
    for (const tag of rec.tags ?? []) {
      if (tag && q.includes(String(tag).toLowerCase())) score += 0.6;
    }
    if (rec.text && rec.text.toLowerCase().includes(q)) score += 0.4;
    if (score > 0) hits.push({ id, sim: Math.min(1, score), space: "lex" });
  }
  hits.sort((x, y) => y.sim - x.sim);
  return hits.slice(0, limit);
}

/**
 * 图扩展：从命中节点沿边扩散，用于唤醒 dormant。
 *
 * 历史版本每轮都物化全部边与全部记忆（`[...edgesTable.entries()]`），
 * 数万条时每轮固定开销明显。现在由调用方只传**候选相关**的邻接表，
 * 见 `buildAdjacency(edgeRows, seedIds)`。
 */
export function graphExpand(seedIds, edgesOrAdj, memoriesById, hops = 1) {
  const adj = edgesOrAdj instanceof Map && edgesOrAdj.__isAdjacency
    ? edgesOrAdj
    : buildAdjacency(edgesOrAdj ?? [], seedIds, hops);

  const seen = new Set(seedIds);
  let frontier = [...seedIds];
  const out = [];
  for (let h = 0; h < hops; h += 1) {
    const next = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
        const rec = memoriesById.get(nb);
        if (rec) out.push({ id: nb, via: "graph", srcTier: rec.tier });
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * 只为给定种子集周围的邻域建邻接表。
 *
 * 代价从「物化全表」降到「扫 `hops` 遍边表，只存命中部分」—— 真正的收益
 * 是**不做**全表 Map 物化（历史版本同时建了 `[...edges]` 与
 * `[...memories]` 两份全量数组）。`hops=1`（生产路径）只扫一遍。
 *
 * ⚠ 必须按 hops 扩散，不能只留种子的直接邻居：那样 `graphExpand` 走第 2 跳
 * 时邻接表里根本没有种子邻居的边，多跳唤醒会静默少一半结果。
 *
 * @param {object[]} edgeRows
 * @param {string[]} seedIds
 * @param {number} [hops] 需要支持的最大跳数
 * @returns {Map<string, string[]>} 带 `__isAdjacency` 标记，供 graphExpand 识别
 */
export function buildAdjacency(edgeRows, seedIds, hops = 1) {
  const adj = new Map();
  adj.__isAdjacency = true;
  const want = new Set(seedIds);
  const rounds = Math.max(1, Number(hops) || 1);

  const link = (from, to) => {
    if (!adj.has(from)) adj.set(from, []);
    const list = adj.get(from);
    if (!list.includes(to)) list.push(to);
  };

  for (let r = 0; r < rounds; r += 1) {
    const added = [];
    for (const e of edgeRows) {
      if (!e?.from || !e?.to) continue;
      const inFrom = want.has(e.from);
      const inTo = want.has(e.to);
      if (!inFrom && !inTo) continue;
      if (inFrom && !want.has(e.to)) added.push(e.to);
      if (inTo && !want.has(e.from)) added.push(e.from);
      link(e.from, e.to);
      link(e.to, e.from);
    }
    if (added.length === 0) break;
    for (const id of added) want.add(id);
  }
  return adj;
}

/**
 * 重排：四因子加权，权重和为 1.0。
 *
 * @param cands 候选 [{id, sim, via, space}]
 * @param index 向量索引（**不含 dormant**）
 * @param nowMs 当前时间
 * @param weights 四因子权重
 * @param lookup 可选：id → 持久层记录。dormant 只在这里能查到，
 *   缺了它 dormant 候选会在重排阶段被静默丢弃，「经关联唤醒」整条链路失效。
 */
export function rerank(cands, index, nowMs, weights, lookup) {
  const scored = [];
  for (const c of cands) {
    const rec = lookup?.get?.(c.id) ?? index.get(c.id) ?? c.rec;
    if (!rec) continue;
    const tier = rec.tier ?? "active";
    const stab = rec.stability ?? rec.s ?? 3;
    const sEff = tier === "long" ? stab * 4 : stab;
    const anchor = rec.lastRecallAt ?? rec.createdAt ?? nowMs;
    const days = Math.max(0, (nowMs - anchor) / DAY_MS);
    const R = Math.exp(-days / Math.max(0.01, sEff));
    const recency = Math.exp(-days / 30);
    const sim = c.sim ?? 0.3;
    const score = weights.sim * sim
      + weights.importance * (rec.importance ?? 0.4)
      + weights.retention * R
      + weights.recency * recency;
    scored.push({ id: c.id, score, sim, R, tier, space: c.space ?? "lex" });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * 量化：抑制微小抖动。
 * systemPrompt.context 的快照仅在内容变化时记录，召回结果每轮微变会撑爆上下文。
 */
export function quantize(rows, quantum = 0.05) {
  return rows.map((r) => ({ ...r, score: Math.round(r.score / quantum) * quantum }));
}

export { cosine, tokenize, DEFAULT_DIM, SEM_REL_THRESHOLD, SEM_CAUSAL_THRESHOLD };

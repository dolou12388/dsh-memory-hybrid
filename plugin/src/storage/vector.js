/**
 * 进程内向量索引：暴力余弦。
 *
 * 为什么不上 ANN：active 层实际规模 480–5160 条，512 维下暴力余弦 0.7–1.7 ms。
 * 引入 HNSW/sqlite-vec 属于过度工程，且多一层需要与 KV 保持一致的同步负担。
 *
 * 派生性：索引完全由 KV 投影而来，可随时丢弃重建。dormant 条目不进索引——
 * 它们只能经关联边唤醒，否则「遗忘」退化为「排序靠后」。
 */

import { DAY_MS } from "../core/config.js";

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
 * 词袋 + 哈希嵌入。不是语义模型，但对「同一实体的不同提及」仍有召回力，
 * 且零依赖、可复现。接入真 embedding 时只需替换此函数。
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

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

export class VectorIndex {
  constructor(dim = DEFAULT_DIM) {
    this.dim = dim;
    this.map = new Map(); // id -> { vec, tier, importance, createdAt, lastRecallAt, text, tags }
  }

  get size() { return this.map.size; }

  put(id, text, meta) {
    this.map.set(id, {
      vec: embed(text, this.dim),
      tier: meta?.tier ?? "active",
      importance: meta?.importance ?? 0.4,
      stability: meta?.stability ?? 3,
      createdAt: meta?.createdAt ?? Date.now(),
      lastRecallAt: meta?.lastRecallAt ?? meta?.createdAt ?? Date.now(),
      text: text ?? "",
      tags: meta?.tags ?? [],
    });
  }

  drop(id) { this.map.delete(id); }

  clear() { this.map.clear(); }

  /** 全量重建。KV 是权威，索引随时可弃。 */
  rebuild(rows) {
    this.map.clear();
    for (const row of rows) {
      if (!row?.text) continue;
      if ((row.tier ?? "active") === "dormant") continue; // dormant 只经图通道
      this.put(row.id, row.text, row);
    }
    return this.map.size;
  }

  /** 向量召回：返回 [{id, sim}]，仅 active / long */
  search(queryVec, limit = 20) {
    const hits = [];
    for (const [id, rec] of this.map) {
      if (rec.tier === "dormant") continue;
      const sim = cosine(queryVec, rec.vec);
      if (sim > 0.05) hits.push({ id, sim });
    }
    hits.sort((x, y) => y.sim - x.sim);
    return hits.slice(0, limit);
  }

  get(id) { return this.map.get(id); }

  entries() { return this.map.entries(); }
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
    if (score > 0) hits.push({ id, sim: Math.min(1, score) });
  }
  hits.sort((x, y) => y.sim - x.sim);
  return hits.slice(0, limit);
}

/** 图扩展：从命中节点沿边扩散 1 跳，用于唤醒 dormant */
export function graphExpand(seedIds, edges, memoriesById, hops = 1) {
  const adj = new Map();
  for (const e of edges) {
    if (!e?.from || !e?.to) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }
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
 * 重排：四因子加权，权重和为 1.0。
 *
 * @param cands 候选 [{id, sim, via}]
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
    scored.push({ id: c.id, score, sim, R, tier });
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

export { cosine, tokenize, DEFAULT_DIM };

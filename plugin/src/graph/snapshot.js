/**
 * 图谱快照：把 domain 里的 memories / edges 投影成 `dsh-memory-graph/1`。
 *
 * 这个模块是**唯一**允许把内部存储暴露出去的地方，因此有三条自我约束：
 *
 *   1. 只读。不写库、不改状态、不触发结算 —— 快照是观察，观察不能有副作用。
 *   2. 口径不复制。retention / weight / degree 都在这里算一次，
 *      消费方（面板、导出、CLI）一律不许自己重算，否则两处口径迟早漂移。
 *   3. 脏数据就地消化。悬空边、缺字段、坏时间戳都不能让整份快照失败 ——
 *      图谱看不到只是少一个视图，不该连带别的功能。
 *
 * 字段语义见 tools/graph-snapshot.md。
 */

import { retention } from "../core/decay.js";
import { LEVELS, DAY_MS } from "../core/config.js";

/** 单条文本的上限。图谱里它是标签，不是正文；整段对话塞进来只会让传输变成瓶颈。 */
export const TEXT_MAX = 200;

/** 保留四位小数：再多也看不出来，只会让 JSON 变大。 */
const round4 = (v) => Math.round(v * 10000) / 10000;
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** 截断到 TEXT_MAX，且不切断代理对（emoji 被劈开会变成乱码方块）。 */
function snippet(text) {
  const s = typeof text === "string" ? text : "";
  if (s.length <= TEXT_MAX) return s;
  let cut = TEXT_MAX - 1;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + "…";
}

/**
 * 当前可召回度。
 *
 * dormant 记录本身已经不再参与衰减（settle 对它直接返回），但视图需要一个
 * 「有多淡」的数值，这里按它在遗忘锚点之后的真实衰减算 —— 于是 dormant 的 R
 * 会持续趋近 0，正好对应「越沉越看不见」。
 */
function retentionOf(row, now) {
  const tier = row.tier ?? "active";
  const s = row.stability ?? row.s ?? LEVELS.normal.s0;
  const anchor = row.lastDecayAt ?? row.lastRecallAt ?? row.createdAt ?? now;
  const dt = Math.max(0, now - anchor);
  // 让 dormant 走 active 的衰减斜率：它的 sEff 不应享受 long 的 4 倍放慢，
  // 否则一条沉底的记忆反而比对册的衰减得慢，视觉上说不通。
  return retention(tier === "dormant" ? "active" : tier, s, dt);
}

/**
 * @param {object} domain 已打开的 memory_hybrid domain
 * @param {object} [options]
 * @param {number} [options.now] 结算基准时刻（测试注入用）
 * @param {number} [options.rev] 版本号，单调递增；由调用方维护
 * @param {number} [options.limit] 只返回权重最高的 N 个节点（0/缺省 = 全部）
 * @returns {object} dsh-memory-graph/1 快照
 */
export function buildSnapshot(domain, options = {}) {
  const now = options.now ?? Date.now();
  const rev = options.rev ?? 0;
  const limit = options.limit ?? 0;

  const memories = domain.table("memories");
  const edgeTable = domain.table("edges");

  // ---- 边：先建度数，再过滤悬空 ----
  // 度数必须在过滤前累计：按「过滤后的子图」算会让枢纽随过滤条件变化，
  // 而过滤是消费方的行为，不该反过来影响核心给出的 degree（约定 §3 第 3 条）。
  const degree = new Map();
  const rawEdges = [];
  for (const [, e] of edgeTable.entries()) {
    if (!e || typeof e.from !== "string" || typeof e.to !== "string") continue;
    if (e.from === e.to) continue;
    rawEdges.push(e);
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  // ---- 节点 ----
  const rows = [];
  for (const [, r] of memories.entries()) {
    if (!r || r.id == null) continue;
    rows.push(r);
  }
  const ids = new Set(rows.map((r) => r.id));

  const nodes = rows.map((r) => {
    const tier = r.tier ?? "active";
    const importance = r.importance ?? LEVELS.normal.imp;
    const stability = r.stability ?? r.s ?? LEVELS.normal.s0;
    const retentionValue = retentionOf({ ...r, tier, stability }, now);

    return {
      id: r.id,
      text: snippet(r.text),
      kind: r.kind ?? "semantic",
      tier,
      importance,
      stability,
      retention: round4(retentionValue),
      weight: round4(clamp01(importance) * retentionValue),
      recallCount: r.recallCount ?? 0,
      createdAt: r.createdAt,
      ...(r.lastRecallAt ? { lastRecallAt: r.lastRecallAt } : {}),
      ...(r.lastDecayAt ? { lastDecayAt: r.lastDecayAt } : {}),
      ...(r.forgotAt ? { forgotAt: r.forgotAt } : {}),
      tags: Array.isArray(r.tags) ? r.tags : [],
      degree: degree.get(r.id) ?? 0,
    };
  });

  const edges = rawEdges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      rel: e.rel ?? "related",
      weight: round4(clamp01(e.weight ?? 0.2)),
    }));

  // ---- 统计：一律按全库算 ----
  // 分页时 stats 仍报全库计数，否则消费方分不清「数据变了」还是「只是换了过滤」（约定 §7）。
  const byTier = {};
  const byKind = {};
  for (const n of nodes) {
    byTier[n.tier] = (byTier[n.tier] ?? 0) + 1;
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  }
  const byRel = {};
  for (const e of edges) byRel[e.rel] = (byRel[e.rel] ?? 0) + 1;

  const fullCount = nodes.length;
  let outNodes = nodes;
  let outEdges = edges;

  if (limit > 0 && fullCount > limit) {
    // 按权重取头部，但边只保留两端都在结果里的 —— 半截边的渲染库会直接崩。
    outNodes = [...nodes].sort((a, b) => b.weight - a.weight).slice(0, limit);
    const keep = new Set(outNodes.map((n) => n.id));
    outEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }

  return {
    schema: "dsh-memory-graph/1",
    rev,
    generatedAt: now,
    source: "memory_hybrid",
    stats: {
      memories: fullCount,
      edges: edges.length,
      byTier,
      byKind,
      byRel,
      avgDegree: fullCount > 0 ? round4((edges.length * 2) / fullCount) : 0,
      isolated: nodes.filter((n) => n.degree === 0).length,
      ...(limit > 0 && fullCount > limit ? { returned: outNodes.length } : {}),
    },
    nodes: outNodes,
    edges: outEdges,
  };
}

/** 供 self-check 用的常量，避免调用方硬编码 24 小时。 */
export const ONE_DAY = DAY_MS;

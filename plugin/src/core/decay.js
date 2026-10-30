/**
 * 三量模型：importance / stability(S) / retrievability(R)。
 *
 * 设计约束（改代码前必读）：
 *  1. R 只由 S 与 dt 决定，绝不掺入心情。一旦衰减受心情调制，同一记忆在不同时刻
 *     会有不同遗忘速度，系统不可复现。
 *  2. importance 一旦写入即固定，只有内容被修正时才更新。心情、召回次数都不动它
 *     但 dormant 唤醒是一个例外：被重新提到的东西不再 trivial，会抬到 normal 下限。
 *  3. 权重 = imp × R 仅用于展示与排序，不参与任何状态判定。
 *  4. 字段名约定（踩过坑，务必遵守）：
 *       - 持久层（KV 记录）字段是 `stability`，不用单字母键
 *       - 本模块内部记号与函数返回值用 `s`
 *       - 所有读取持久层记录的地方必须写 `node.stability ?? node.s`
 *     早期只读 `s`，导致从 KV 读回的对象（只有 stability）算出 R=1，
 *     遗忘永不触发、唤醒后稳定度不恢复——都不报错，只静默失效。
 */

import {
  R_FORGET, R_DEMOTE, LAMBDA_LONG, S_MAX, S_PROMOTE, S_DEMOTE,
  S_REVIVE, IMP_FLOOR_REVIVE, G_BASE, SPACING_K, RECALL_MIN_PROMOTE,
  LEVELS, levelOfImportance, DAY_MS,
} from "./config.js";

/** long 层的等效稳定度：衰减放慢 LAMBDA_LONG 倍 */
function sEff(tier, s) {
  return tier === "long" ? s * LAMBDA_LONG : s;
}

/** 当前可召回度。dt 单位毫秒，S 单位天。 */
export function retention(tier, s, dtMs) {
  if (!(s > 0) || dtMs <= 0) return 1.0;
  const days = dtMs / DAY_MS;
  return Math.exp(-days / sEff(tier, s));
}

/** 权重，仅展示用 */
export function weight(importance, tier, s, dtMs) {
  return importance * retention(tier, s, dtMs);
}

/**
 * 一次成功召回后的稳定度。间隔效应：R 越低增益越大，R→1 时增益→0。
 *
 * 公式形状取自 FSRS：增益 ∝ e^(k(1−R)) − 1。
 * 为什么必须是这个形状：早期版本用线性 `1+(1−R)`，R=1 时给出 2 倍系数，
 * 于是「刚存下就再说一遍」反而拿到最大增益——同一天说十次等于十天间隔重复，
 * 与间隔效应的本意完全相反。指数形状在 R=1 处增益恰好为 0：
 * 没有间隔就没有巩固，这是不需要额外硬阈值就能自洽的性质。
 *
 * 副作用（正面）：因为靠公式而非时间硬阈值来区分，5.9 小时前刚提过一次
 * 这类真实情形不会被误杀，增益仍按其实际 R 值连续给出。
 */
export function grow(s, rAtRecall, fMood = 1.0) {
  const r = Math.min(1, Math.max(0, rAtRecall));
  const spacingGain = Math.exp(SPACING_K * (1 - r)) - 1;
  const gEff = G_BASE * spacingGain * fMood;
  return Math.min(s * (1 + gEff), S_MAX);
}

/**
 * dormant → active 的稳定度与档位回补。
 *
 * 早期设计用固定 floor=3.0，导致 trivial(S=0.5) 唤醒后跳 6 倍，短命条目获得
 * normal 级存活期并无限续命。
 *
 * 现行公式：S' = max(该档 S0 × S_REVIVE, S × S_REVIVE)，S_REVIVE=0.5
 *   即「减半，但不低于档位地板」。两条性质都是刻意的：
 *
 *   1. **减半是遗忘的代价**。被遗忘说明已经久到 R 跌到 R_FORGET，
 *      唤醒不该把它无损复原 —— 否则「忘了再说一次」等于免费刷新，
 *      遗忘机制形同虚设。
 *   2. **地板防止死亡螺旋**。没有地板时每轮唤醒都减半，
 *      S 会连续掉到接近 0，短命条目反复占位。
 *      有地板后反复唤醒会收敛到该档地板（normal 1.5 / important 7 /
 *      critical 30），不会无限下沉。
 *
 * 档位回补：importance 低于 IMP_FLOOR_REVIVE 的一律抬到 normal ——
 * 被重新提到的东西不再 trivial。
 *
 * ⚠ 早期注释曾写「且不超过自身原值」，与公式实际行为不符（S=3 唤醒后
 *   是 1.5，确实变小了）。那句话只对 floor 低于原值的情形成立，
 *   别按它推断语义。
 */
export function revive(s, level) {
  const newLevel = LEVELS[level].imp >= IMP_FLOOR_REVIVE ? level : "normal";
  const s0 = LEVELS[newLevel].s0;
  // min(s * S_REVIVE, s) 是 S_REVIVE > 1 时的保险，正常情况不起作用
  const target = Math.max(s0 * S_REVIVE, Math.min(s * S_REVIVE, s));
  return { s: target, level: newLevel, importance: LEVELS[newLevel].imp };
}

/** 新记忆的初始状态。字段名用 persist 侧的 `stability`，避免两套名字。 */
export function initState(level) {
  const cfg = LEVELS[level];
  const tier = level === "critical" ? "long" : "active";
  return { tier, importance: cfg.imp, stability: cfg.s0, recallCount: 0 };
}

/**
 * 惰性结算：只算 R 与必要的状态转移，不做 IO。
 * 返回新的 tier / s 与一个事件名，供调用方决定是否落盘。
 *
 * ⚠ 字段名：持久层用 `stability`（避开单字母键，便于 schema 演进），
 *   而本模块内部记号用 `s`。两个名字都接受，读取时优先稳定度字段。
 *   早期只读 `s`，导致从 KV 读回来的记录（只有 stability）算出 R=1，
 *   遗忘永不触发——这类「字段名不一致」不会报错，只会静默失效。
 */
export function settle(node, nowMs) {
  const tier = node.tier ?? "active";
  const s = node.stability ?? node.s ?? LEVELS.normal.s0;
  if (tier === "dormant") return { tier, s, event: null };
  const lastAnchor = node.lastDecayAt ?? node.lastRecallAt ?? node.createdAt ?? nowMs;
  const r = retention(tier, s, nowMs - lastAnchor);

  if (tier === "active" && r < R_FORGET) {
    return { tier: "dormant", s, r, event: "forget", forgotAt: nowMs };
  }
  if (tier === "long" && r < R_DEMOTE) {
    return { tier: "active", s: S_DEMOTE, r, event: "demote", anchor: nowMs };
  }
  return { tier, s, r, event: null };
}

/**
 * 召回后是否满足晋升条件。
 *
 * 为什么必须带 recallCount 下限：grow() 的间隔效应在「刚写入就再次提及」时
 * 给出最大增益（R_at_recall≈1 → 1.5 倍），critical 从 S=60 一次就冲到 90，
 * 直接越过 S_PROMOTE=30。若只看 S，一条刚存下就被重复一次的记忆会立刻
 * 变长期，与「反复确认才长期」的语义相反。因此晋升必须同时满足：
 * 稳定度够 且 被召回次数够。
 */
export function shouldPromote(node) {
  if ((node.tier ?? "active") !== "active") return false;
  const s = node.stability ?? node.s ?? 0;
  if (s < S_PROMOTE) return false;
  // 晋升必须同时满足：稳定度够 且 被召回次数够。
  // 只满足前者的话，刚写入就被重复一次的 critical 会立刻变长期。
  return (node.recallCount ?? 0) >= RECALL_MIN_PROMOTE;
}

/**
 * 由 dormant 唤醒后的完整新状态。
 *
 * ⚠ currentTime 参数不能省：settle 的锚点取 `lastDecayAt ?? lastRecallAt ?? createdAt`，
 *   而 dormant 记录的 lastDecayAt 停在**遗忘那一刻**（过去）。唤醒时若不把它
 *   推进到 now，下一轮 settle 会用同一个旧锚点算出相同的过期 R，
 *   于是刚刚「唤醒」的记忆立刻又被判遗忘 —— 表现为无限循环唤醒，
 *   且 stats.revived 每轮 +1。这类问题不报错，只在统计里看得到异常增长。
 *
 * 同样要兼容 `stability`/`s` 两个字段名——这里踩过坑：只读 `s` 时
 * 从 KV 回来的记录取不到值，唤醒后 S 停在默认档的 0.5，表面看「唤醒成功」
 * 但存活期几乎没有恢复。
 */
export function reviveNode(node, currentTime = Date.now()) {
  const curS = node.stability ?? node.s ?? LEVELS.normal.s0;
  const level = levelOfImportance(node.importance ?? LEVELS.normal.imp);
  const r = revive(curS, level);
  return {
    tier: "active",
    stability: r.s,
    importance: Math.max(node.importance ?? 0, r.importance),
    // 三个时间戳一起推进：lastRecallAt 供召回增益算间隔，lastDecayAt 供
    // settle 算锚点，forgotAt 清空表示「已不再处于遗忘态」。
    lastRecallAt: currentTime,
    lastDecayAt: currentTime,
    forgotAt: undefined,
  };
}

export { sEff, LEVELS, S_PROMOTE, S_DEMOTE };

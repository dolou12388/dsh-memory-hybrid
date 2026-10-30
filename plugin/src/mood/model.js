/**
 * 心情二维模型：valence（效价）× arousal（唤醒）。
 *
 * 为什么必须二维：一维求和下「开心3 + 焦虑3」得到效价 0，与「平静2」无法区分。
 * 但前者是高唤醒矛盾态、后者是低唤醒稳态，方向信息在求和时相消了。
 *
 * 分工：效价管写入门槛，唤醒管召回增益且不分正负（焦虑态：少写但更牢）。
 * 边界：衰减速度永不参与调制。
 */

import {
  MOOD_COORDS_FALLBACK, THETA_BASE, K_V, K_A,
  EMA_ALPHA, CONF_MIN, MAX_LABELS, MOOD_HORIZON_MS,
} from "../core/config.js";

/** 8 类心情的二维坐标。专注的 arousal 高于开心：任务态认知负荷更高。 */
export const MOOD_COORDS = Object.freeze({
  兴奋: { v: 1.0, a: 1.0 },
  开心: { v: 1.0, a: 0.55 },
  专注: { v: 0.4, a: 0.60 },
  平静: { v: 0.0, a: 0.0 },
  疲惫: { v: -0.5, a: -1.0 },
  低落: { v: -0.8, a: -0.60 },
  焦虑: { v: -1.0, a: 0.85 },
  烦躁: { v: -0.9, a: 0.55 },
});

export const CATEGORIES = Object.freeze(Object.keys(MOOD_COORDS));

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * 校验并规整心情判定结果。
 * 未知类别回退到中性而非抛错：worker 抛错会连带整个 turn 任务失败。
 */
export function normalizeMood(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "empty" };

  const conf = Number(raw.confidence);
  if (!Number.isFinite(conf) || conf < CONF_MIN) {
    return { ok: false, reason: "low-confidence", confidence: conf };
  }

  const list = Array.isArray(raw.labels) ? raw.labels : [];
  const labels = [];
  let dropped = 0;

  for (const item of list) {
    if (labels.length >= MAX_LABELS) { dropped += 1; continue; }
    const cat = item?.category;
    const coord = MOOD_COORDS[cat];
    if (!coord) { dropped += 1; continue; }
    const rawInt = Number(item?.intensity);
    const intensity = Number.isFinite(rawInt) ? clamp(Math.round(rawInt), 1, 3) : 2;
    labels.push({ category: cat, intensity });
  }

  if (labels.length === 0) return { ok: false, reason: "no-valid-label", dropped };
  return { ok: true, labels, confidence: conf, dropped };
}

/** 二维聚合。clamp 到 [-1,1]。 */
export function aggregate(labels) {
  let v = 0;
  let a = 0;
  for (const { category, intensity } of labels) {
    const c = MOOD_COORDS[category] ?? MOOD_COORDS_FALLBACK;
    const m = intensity / 3;
    v += c.v * m;
    a += c.a * m;
  }
  return { v: clamp(v, -1, 1), a: clamp(a, -1, 1) };
}

/**
 * 双轴 EMA。两轴独立平滑——合并成标量会退回一维。
 *
 * α 的选取：0.55 使单轮情绪即有明显影响（V=0.55），3～4 轮接近饱和。
 * 早期用 0.3 时，单轮只把 V 推到 0.30，需连续 7 轮同向心情才能改变
 * 一个档位的收录判定——那不叫心情，叫长期倾向。
 *
 * 反例（不要叠加）：曾在此之上再加一层「单轮样本折扣 0.5」，
 * 结果是两层惯性相乘，稳态 V 被压在 0.5，normal 档永远进不来。
 * 惯性只需要一层，EMA 已经提供了。
 */
export function updateEma(prev, sample, alpha = EMA_ALPHA) {
  const v = prev?.v ?? 0;
  const a = prev?.a ?? 0;
  return {
    v: (1 - alpha) * v + alpha * sample.v,
    a: (1 - alpha) * a + alpha * sample.a,
    at: Date.now(),
  };
}

/**
 * 心情是否已过期。超过 MOOD_HORIZON_MS 未更新的 EMA 回落到中性，
 * 避免数小时前的一次对话余温持续影响写入策略。
 */
export function effectiveEma(ema, nowMs = Date.now()) {
  if (!ema) return { v: 0, a: 0 };
  const age = nowMs - (ema.at ?? 0);
  if (age > MOOD_HORIZON_MS) return { v: 0, a: 0 };
  return { v: ema.v ?? 0, a: ema.a ?? 0 };
}

/** 写入门槛。V 越高门槛越低（放宽收录）。 */
export function writeThreshold(ema) {
  return THETA_BASE * (1 - K_V * ema.v);
}

/**
 * 召回增益因子。A 越高增益越大，不分正负。
 * 焦虑3 → 1.085（收紧收录但加强巩固）；疲惫3 → 0.90。
 */
export function gainFactor(ema) {
  return 1 + K_A * ema.a;
}

export { THETA_BASE, K_V, K_A, CONF_MIN };

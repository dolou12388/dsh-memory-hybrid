/** 全部可调参数集中在此。改这里，不要散落到业务代码。 */

export const R_FORGET = 0.05;
export const R_DEMOTE = 0.20;
export const LAMBDA_LONG = 4.0;
export const S_MAX = 365.0;
export const RECALL_MIN_PROMOTE = 2;

/**
 * 四档 importance：基准分值、可写入的分数下限/上限、初始稳定度 S0（天）。
 * 无召回存活期 = 2.996×S0。
 *
 * ⚠ 这里保存的是「档位固有的重要度」，它是内容属性，**不随心情变化**。
 *   早期版本让分值在区间内按效价浮动，结果与 θ 同向驱动、几乎抵消：
 *   要让 normal 档写入，需连续开心 7 轮（EMA α=0.3 下才够）。
 *   现在两者分工明确：
 *     - importance = 档位基准值（内容是什么）
 *     - θ          = 心情调制值（此刻愿不愿意收）
 *   心情只动门槛，不动内容，这才是「写入门槛」的语义。
 *
 * min/max 仍保留，用于 Jev 接入后在同一档内做细粒度定位（P3 期启用），
 * 当前规则路径一律取 .imp。
 */
export const LEVELS = Object.freeze({
  trivial: { imp: 0.15, min: 0.08, max: 0.22, s0: 0.5 },
  normal: { imp: 0.40, min: 0.30, max: 0.55, s0: 3.0 },
  important: { imp: 0.70, min: 0.62, max: 0.85, s0: 14.0 },
  critical: { imp: 0.95, min: 0.90, max: 1.00, s0: 60.0 },
});

export const LEVEL_ORDER = ["trivial", "normal", "important", "critical"];

/** 由 S0 反查档位，用于 dormant 唤醒时的档位回补 */
export function levelOfStability(s) {
  if (s >= LEVELS.critical.s0) return "critical";
  if (s >= LEVELS.important.s0) return "important";
  if (s >= LEVELS.normal.s0) return "normal";
  return "trivial";
}

/**
 * 由分值反查档位。按区间中点切分，保证与 LEVELS 的 [min,max] 一致。
 * 注意不能按 .imp 基准值切分——区间化后基准值不再是分档边界。
 */
export function levelOfImportance(imp) {
  if (imp >= 0.88) return "critical";
  if (imp >= 0.585) return "important";
  if (imp >= 0.26) return "normal";
  return "trivial";
}

/**
 * 给定档位，返回其固有的 importance 分值。
 *
 * 心情 **不** 参与这里：档位是内容属性（这条信息本身多重要），
 * 心情是情境属性（这一刻愿不愿意收）。二者混在一个数上会互相抵消，
 * 见 LEVELS 的说明。保留函数形式是为了让 Jev 接入后能在档内细调，
 * 以及让调用方不必关心 LEVELS 的结构。
 *
 * @param {string} level 档位名
 */
export function importanceFor(level) {
  return (LEVELS[level] ?? LEVELS.normal).imp;
}

export const S_PROMOTE = 30.0;
export const S_DEMOTE = 20.0;
export const S_REVIVE = 0.5;
export const IMP_FLOOR_REVIVE = 0.40;
/**
 * 巩固强度的基准系数。配合 SPACING_K 决定单次召回能涨多少：
 *   S' = S × (1 + G_BASE × (e^(SPACING_K×(1−R)) − 1) × f_mood)
 * 踩线召回（R≈0.05）时涨幅约 G_BASE×(e^1.425−1) ≈ 1.58 倍；
 * 刚写过（R≈1）时涨幅为 0——没有间隔就没有巩固。
 */
export const G_BASE = 0.5;
/** 间隔效应的陡峭度。越大则「越接近遗忘才复习」的收益越显著。 */
export const SPACING_K = 1.5;

/**
 * 写入门槛。θ = θ_base × (1 − K_V × V)，V 为效价 EMA。
 *
 * 参数是让「心情真的改变行为」倒推出来的，不是拍脑袋：
 *   档位分值 0.15 / 0.40 / 0.70 / 0.95，θ ∈ [0.275, 0.825]。
 *     V=+1.0（持续开心）→ θ=0.28 → normal 及以下放宽收录
 *     V= 0.0（中性）    → θ=0.55 → 只收 important 以上
 *     V=−0.5（疲惫）    → θ=0.69 → normal 被拦
 *     V=−0.8（低落）    → θ=0.77 → 连 important 也被拦
 *
 * 反例（早期参数，务必不要退回去）：
 *   θ_base=0.60 K_V=0.12 → θ ∈ [0.528, 0.672]，整段落在 0.40–0.70 的
 *   空隙里。无论心情如何，能写入的档位集合完全相同，调制形同虚设。
 *   这是「连续门槛 × 离散档位」最容易踩的坑：必须先画出档位线，
 *   再看 θ 的摆动是否真的跨过其中某一条。
 */
export const THETA_BASE = 0.55;
export const K_V = 0.50;
/** 唤醒对巩固增益的调制系数。不分正负：焦虑也加深记忆（唤醒固化效应）。 */
export const K_A = 0.10;

export const EMA_ALPHA = 0.55;
export const CONF_MIN = 0.55;
export const MAX_LABELS = 2;
export const MOOD_HORIZON_MS = 30 * 60 * 1000;
/** 未知类别回退坐标：中性，等价于平静 */
export const MOOD_COORDS_FALLBACK = Object.freeze({ v: 0, a: 0 });

/**
 * 向量相似度阈值。
 *
 * ⚠ 这两个数必须匹配 **实际使用的嵌入实现**，不能照抄语义模型的经验值。
 *   当前 embed() 是词袋 + 哈希（零依赖、可复现），实测分布：
 *     完全无关            −0.07 ～ 0.08
 *     共享一个关键词       0.13 ～ 0.18
 *     共享多个关键词       0.30 ～ 0.35
 *     近乎同一句话         > 0.80
 *   若照语义嵌入的直觉设 0.60，则除「几乎逐字重复」外永远不建边；
 *   若设 0.82 做去重，同一事实换个说法就会存成两份。
 *
 * 接入真 embedding 后这三个值都应重标（届时相关文本的余弦会整体上移）。
 */
export const REL_THRESHOLD = 0.22;
export const CAUSAL_THRESHOLD = 0.34;
/** 判为「同一事实」的重复写入阈值，用于 upsert 而非新建 */
export const DEDUP_THRESHOLD = 0.82;

export const RECALL_TOP_K = 6;
export const SCORE_QUANTUM = 0.05;

export const WEIGHTS = Object.freeze({
  sim: 0.55,
  importance: 0.20,
  retention: 0.15,
  recency: 0.10,
});

export const RECENCY_TAU_DAYS = 30;

export const JOB_MAX_ATTEMPTS = 3;
export const DAY_MS = 86_400_000;

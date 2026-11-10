/**
 * 心情推断：从对话文本估计 valence / arousal。
 *
 * ## 为什么必须有这个模块
 *
 * 整套心情调制（阈值 θ、巩固增益 f_mood、8 类二维坐标）依赖一个外部
 * 心情插件往 journal 载荷里塞 `mood` 字段。但那个插件从来不存在，
 * 入队方只写 `{ userText, assistantText }`。结果：
 *
 *   emaV / emaA 恒为 0 → theta 恒为 0.55 → gainFactor 恒为 1.0
 *   README 里「开心3 / 焦虑3 / 疲惫2」的行为差异，一条都不成立
 *   统计里的 moodTotal / multiLabel 永远为 0
 *
 * 这是一条「有配置、有 UI、有文档、有统计，全都不生效」的链路 ——
 * 比功能缺失更糟，因为它让人以为在用。
 *
 * ## 两种修法的取舍
 *
 * 方案 A：直接删掉心情体系（配置、文档、统计、model.js 全删）
 *   优点：诚实，代码量骤减
 *   缺点：model.js 的二维 EMA 设计确实有价值 —— 「开心3+焦虑3」与
 *         「平静2」在效价上都是 0，但前者是高唤醒矛盾态，这个区分是对的。
 *         删掉等于扔掉一个正确的洞察。
 *
 * 方案 B（本实现）：提供一个**内置的、零依赖的、确定性的**推断器
 *   优点：链路真的通了；无需外部插件；可测试、可复现
 *   缺点：规则推断的准确率有限，只能识别明显的情绪信号
 *
 * 选 B，但在文档与配置里把局限写明：它识别的是「措辞里的情绪线索」，
 * 不是真正的情绪理解。判不出来就返回 null（= 中性），不做猜测 ——
 * 误判比不判更糟，因为它会让门槛无理由地摆动。
 *
 * ## 为什么复用 model.js 的 8 类坐标
 *
 * 输出形态刻意做成 `{ confidence, labels: [{category, intensity}] }`，
 * 与「外部心情插件」的载荷完全一致。这样 normalizeMood / aggregate
 * 一行都不用改，两条来源可无缝切换。
 */

import { MOOD_COORDS } from "./model.js";

/**
 * 情绪线索词表。
 *
 * 每条 `[类别, 强度, 匹配模式]`。强度 1～3 对应该类的典型表达力度。
 *
 * 为什么强度分档而不是一律 2：同一个「焦虑」，「有点担心」和「急死了」
 * 对行为的影响不该相同。EMEA 的 α=0.55 会让单轮就显著改变 EMA，
 * 强度档位是这个放大器的输入。
 */
const CUES = [
  // ---- 正向高唤醒 ----
  ["兴奋", 3, /(太棒了|太好了|终于成功|搞定了|跑通了|上线了|完美|绝了|amazing|awesome|nailed it|it works)/i],
  ["兴奋", 2, /(太好了|非常期待|迫不及待|excited|can't wait)/i],
  // ---- 正向 ----
  ["开心", 3, /(哈哈+|开心|高兴|满意|赞|牛|厉害|感谢|多谢|thanks a lot|thank you so much)/i],
  ["开心", 2, /(不错|挺好|可以了|没问题|顺利|good|nice|great|works)/i],
  // ---- 专注 ----
  ["专注", 2, /(仔细看|认真|专注|深入|研究|排查|分析|focus|dig into|let me check)/i],
  ["专注", 1, /(先看|确认一下|核对|verify|check)/i],
  // ---- 负向高唤醒 ----
  // 强度 3 只放「已经在出事」的表达。把「风险」「不确定」这类提前预警
  // 也放进 3 会让一次普通的谨慎讨论把 EMA 拉到 -1，门槛从 0.55 跳到 0.825，
  // 那一轮的 important 记忆全部被拦。
  ["焦虑", 3, /(急死|崩溃|完了|糟糕|出事了|紧急|线上故障|宕机|事故|P0|urgent|critical|outage|down)/i],
  ["焦虑", 2, /(担心|害怕|怕|焦虑|紧张|不确定|风险|worry|concerned|risky|nervous)/i],
  ["烦躁", 3, /(烦死|恶心|离谱|搞什么|又错了|怎么又|受不了|ridiculous|again\?|wtf)/i],
  ["烦躁", 2, /(烦|讨厌|受不了|annoying|frustrat)/i],
  // ---- 负向低唤醒 ----
  ["低落", 3, /(绝望|没救了|放弃|不想做|太难了|hopeless|give up)/i],
  ["低落", 2, /(失望|可惜|遗憾|沮丧|难过|sad|disappoint)/i],
  ["疲惫", 3, /(累死|撑不住|通宵|熬夜|exhausted|burn(ed)? out)/i],
  ["疲惫", 2, /(累|疲|歇会|休息一下|tired|fatigue|sleepy)/i],
];

/**
 * 否定前缀会反转情绪词的含义。「不开心」不该判成开心。
 * 只处理紧邻前置，不做句法分析。
 */
const NEGATORS = ["不", "没", "无", "非", "别", "not ", "no ", "don't "];

function isNegated(text, index) {
  if (index <= 0) return false;
  const prev1 = text[index - 1];
  const prev4 = text.slice(Math.max(0, index - 4), index).toLowerCase();
  if (NEGATORS.includes(prev1)) return true;
  return NEGATORS.some((n) => n.endsWith(" ") && prev4.endsWith(n));
}

/**
 * 从一段文本推断心情。
 *
 * @param {string} userText 用户这一轮说的话（主要依据）
 * @param {string} [assistantText] 助手的话（弱信号，只在用户无信号时参考）
 * @returns {{confidence: number, labels: {category: string, intensity: number}[]} | null}
 *   null 表示「判不出」= 中性。**不返回"平静"标签** —— 平静是"确定了没情绪"，
 *   null 是"没判出来"，两者对 EMA 的作用同为 0，但混用会污染 multiLabel 统计。
 */
export function inferMood(userText, assistantText) {
  const text = String(userText ?? "").trim();
  if (!text) return null;

  const found = collect(text);
  if (found.length === 0) {
    // 用户没信号时才看助手的话，且要求更强的一致性（两条以上同类）
    const fromAssistant = collect(String(assistantText ?? "").slice(0, 400));
    if (!fromAssistant.length) return null;
    const counts = new Map();
    for (const f of fromAssistant) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < 2) return null;
    const top = fromAssistant.filter((f) => f.category === best[0])
      .sort((a, b) => b.intensity - a.intensity)[0];
    return { confidence: 0.58, labels: [{ category: top.category, intensity: top.intensity }] };
  }

  /**
   * 按强度排序，最多保留 2 个（与 MAX_LABELS 一致）。
   *
   * 为什么要保留两个而不是只取最强：核心设计动机就是区分「开心3+焦虑3」
   * （高唤醒矛盾态）与「平静2」（低唤醒稳态）—— 只取一个就把这个区分抹掉了。
   */
  const sorted = found.sort((a, b) => b.intensity - a.intensity || b.pos - a.pos);
  const labels = [];
  const seen = new Set();
  for (const f of sorted) {
    if (labels.length >= 2) break;
    // 同类多次命中取**最大值**，不做叠加。
    // 早期写的是「再命中一次就 +1」，结果「有点担心这个风险」里
    // 「担心」和「风险」各命中一次强度 2 的模式，直接叠到 3 ——
    // 一次普通的谨慎讨论被算成最高唤醒焦虑，把 EMA 拉满。
    if (seen.has(f.category)) continue;
    seen.add(f.category);
    labels.push({ category: f.category, intensity: f.intensity });
  }

  /**
   * 置信度：单标签明确命中给 0.62，双标签给 0.66。
   *
   * 门槛 CONF_MIN = 0.55，所以这里必须高于它 —— 但也不能给太高：
   * 规则推断本来就不该被当成高置信判定，它只配刚好通过。
   * 双标签反而更高，因为「两处独立线索指向不同情绪」比「一处」更可信。
   */
  const confidence = labels.length >= 2 ? 0.66 : 0.62;
  return { confidence, labels };
}

/**
 * 扫出所有命中，附带位置。
 *
 * 位置用于判断否定：「不开心」里的「开心」在 index 2，且前一位是「不」。
 */
function collect(text) {
  const out = [];
  for (const [category, intensity, re] of CUES) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let m;
    while ((m = g.exec(text)) !== null) {
      if (!MOOD_COORDS[category]) continue;
      if (isNegated(text, m.index)) continue;
      out.push({ category, intensity, pos: m.index });
      // 防止零宽匹配导致死循环
      if (m.index === g.lastIndex) g.lastIndex += 1;
    }
  }
  return out;
}

/**
 * 推断器的自述：给设置页与 `memory_manage(stats)` 用。
 * 用户需要能知道「心情到底靠什么在工作」。
 */
export const MOOD_INFERENCE_NOTE =
  "内置情绪推断：只看措辞线索（" +
  `${CUES.length} 条模式，覆盖 ${new Set(CUES.map((c) => c[0])).size} 类情绪）` +
  "，判不出时按中性处理。要接入真正的情绪模型，请在 journal 载荷里提供 mood 字段。";

export { CUES };

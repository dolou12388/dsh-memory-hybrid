/**
 * 生成一份「像真的」的记忆图谱快照，供 tools/graph-lab.html 做视觉设计验证。
 *
 * 定位与 tools/simulate.py 相同：**设计期探针，不是测试，不进 CI**。
 * 它回答的问题不是「代码对不对」，而是「这套编码在真实分布下读不读得懂」。
 *
 * 为什么用真模型而不是随手随机：
 *   tier 分布、稳定度、衰减、边权全部走 plugin/src/core 里那套真函数
 *   （LEVELS / retention / grow / settle）。如果样本用假公式，探针上好看的
 *   配色搬到真实数据上可能完全不成立 —— 例如 97% 的节点其实是 dormant，
 *   任何按 tier 上饱和色的方案都会立刻失真。
 *
 * 用法：
 *   node tools/make-snapshot.mjs                 # 默认 480 条，写 tools/snapshot.sample.json
 *   node tools/make-snapshot.mjs --nodes 5000    # 压满最坏规模
 *   node tools/make-snapshot.mjs --nodes 480 --seed 7 --out /tmp/s.json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEVELS, R_FORGET, R_DEMOTE, S_PROMOTE, S_DEMOTE, RECALL_MIN_PROMOTE,
  CAUSAL_THRESHOLD, DAY_MS,
} from "../plugin/src/core/config.js";
import { retention, grow, settle } from "../plugin/src/core/decay.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const NODES = Number(arg("nodes", 480));
const SEED = Number(arg("seed", 42));
const OUT = resolve(arg("out", resolve(HERE, "snapshot.sample.json")));
const NOW = Number(arg("now", Date.now()));
/** 观察窗口：两年。dormant 的沉淀形态要在这个尺度上才看得出来。 */
const HORIZON_DAYS = 730;

/* ------------------------------------------------------------------ *
 * 确定性随机
 * ------------------------------------------------------------------ */

/** mulberry32。必须确定性：同一 seed 两次生成要逐字节一致，否则视觉对比无意义。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const between = (lo, hi) => lo + rng() * (hi - lo);

/* ------------------------------------------------------------------ *
 * 文本合成
 * ------------------------------------------------------------------ *
 * 不追求语义正确，只求三点：长度分布像人话、同主题词汇有重叠、能当标签看。
 * 同主题词汇重叠很重要 —— 真实系统里边是「向量相似度 + 词法二次确认」建出来的，
 * 如果样本里的边和文本毫无关系，图谱上按标签聚合就会显得比实际更整齐。
 */

const TOPICS = [
  { tag: "部署", words: ["blue-green", "回滚窗口", "灰度", "镜像", "健康检查", "发布单"] },
  { tag: "供应商", words: ["aigwbce", "AnyFast", "对接", "SLA", "工单", "配额"] },
  { tag: "记忆", words: ["衰减", "唤醒", "稳定度", "召回", "dormant", "巩固"] },
  { tag: "前端", words: ["插槽", "面板", "注入", "首帧", "设置页", "侧栏"] },
  { tag: "排障", words: ["502", "超时", "日志", "复现", "inject", "装配顺序"] },
  { tag: "习惯", words: ["中文回答", "别用 emoji", "先证伪", "版本号上界面", "短句"] },
  { tag: "数据", words: ["快照", "schema", "字段", "迁移", "索引", "重算"] },
  { tag: "模型", words: ["embedding", "维度", "余弦", "阈值", "词袋", "哈希"] },
];

const KINDS = [
  { kind: "episodic", weight: 0.34, frame: (w) => `${pick(w)}那天又出问题了，${pick(w)}这次是${pick(w)}` },
  { kind: "semantic", weight: 0.36, frame: (w) => `${pick(w)}的规则是：${pick(w)}必须早于${pick(w)}` },
  { kind: "procedural", weight: 0.18, frame: (w) => `改${pick(w)}之前先跑一遍${pick(w)}，否则${pick(w)}` },
  { kind: "preference", weight: 0.12, frame: (w) => `用户偏好：${pick(w)}，不喜欢${pick(w)}` },
];

/** 按权重抽 kind。 */
function pickKind() {
  let r = rng();
  for (const k of KINDS) {
    if (r < k.weight) return k;
    r -= k.weight;
  }
  return KINDS[0];
}

/** 档位分布取真实系统的经验值：绝大多数是 trivial/normal，critical 极少。 */
function pickLevel() {
  const r = rng();
  if (r < 0.05) return "critical";
  if (r < 0.25) return "important";
  if (r < 0.65) return "normal";
  return "trivial";
}

/* ------------------------------------------------------------------ *
 * 生命史模拟
 * ------------------------------------------------------------------ *
 * 一天一天地走：每天按档位概率决定是否被召回，被召回就 grow()，
 * 满足条件就晋升，最后用 settle() 结算到今天。
 *
 * 为什么不用「直接抽一个稳定度」：稳定度是路径依赖的 —— 高召回条目会
 * 被推到 long，而 long 的衰减又慢 4 倍，两者叠加才产生「少数又大又久」
 * 的枢纽节点。这正是图谱上最值得看的结构，随机抽是抽不出来的。
 */

/**
 * 每档的日召回概率。数值参照 docs/memory-system-design.md 9.1 的稳态表：
 * 全库平均日召回率 0.01 时 dormant 约 97%，0.05 时约 65%。
 *
 * `--recall` 是全体倍率。480 节点实测（seed=42）：
 *   1.0  → dormant 48% / long 33% / active 18%   三态齐全，比配色用这个
 *   0.4  → dormant 62% / long 22% / active 16%
 *   0.1  → dormant 79% / long 9%  / active 12%   接近老年库
 *
 * ⚠ 与本项目稳态表（design 9.1：低召回时 dormant≈97%）仍有差距，原因有二：
 *   一是本脚本的创建时间偏近期（越近越密），年轻条目还没走到遗忘；
 *   二是 critical 档按 initState 的语义「出生即 long」，这部分永远不掉。
 *   探针要比的是编码可读性，不是人口结构，所以不在这里强行对齐 ——
 *   真要压到 97%，调 --recall 0.02 并接受全库只剩十几个彩点。
 */
const RECALL_P = { trivial: 0.002, normal: 0.010, important: 0.045, critical: 0.090 };
const RECALL_SCALE = Number(arg("recall", 1));

function makeNode(index) {
  const level = pickLevel();
  const topic = pick(TOPICS);
  const kind = pickKind();
  const cfg = LEVELS[level];

  // 创建时间：偏向近期（越近越密），符合「最近写得比两年前多」
  const ageDays = Math.pow(rng(), 1.8) * HORIZON_DAYS;
  const createdAt = NOW - ageDays * DAY_MS;

  let tier = level === "critical" ? "long" : "active";
  let stability = cfg.s0;
  let recallCount = 0;
  let lastRecallAt;
  let lastDecayAt = createdAt;

  const p = RECALL_P[level] * RECALL_SCALE;
  const days = Math.floor(ageDays);
  for (let d = 1; d <= days; d += 1) {
    if (rng() >= p) continue;
    const t = createdAt + d * DAY_MS;
    // 召回增益用真实公式：R 越低涨得越多（间隔效应）
    const r = retention(tier, stability, t - lastDecayAt);
    stability = grow(stability, r);
    recallCount += 1;
    lastRecallAt = t;
    lastDecayAt = t;
    // 晋升：稳定度够 且 召回次数够（缺一条都会让「刚写就重复一次」直接变长期）
    if (tier === "active" && stability >= S_PROMOTE && recallCount >= RECALL_MIN_PROMOTE) {
      tier = "long";
    }
    // long 掉回 active 的条件同样走真阈值，但只在结算时判，避免日内震荡
  }

  // 今天结算
  const s0 = { tier, stability, lastDecayAt, lastRecallAt, createdAt };
  const settled = settle(s0, NOW);
  tier = settled.tier;
  const forgotAt = settled.event === "forget" ? NOW : undefined;
  if (settled.event === "demote") stability = S_DEMOTE;

  const r = retention(tier, stability, NOW - (lastDecayAt ?? createdAt));
  const weight = cfg.imp * r;

  return {
    id: `m_${String(index).padStart(4, "0")}`,
    text: kind.frame(topic.words),
    kind: kind.kind,
    tier,
    importance: cfg.imp,
    stability: Number(stability.toFixed(3)),
    retention: Number(r.toFixed(4)),
    weight: Number(weight.toFixed(4)),
    recallCount,
    createdAt: Math.round(createdAt),
    ...(lastRecallAt ? { lastRecallAt: Math.round(lastRecallAt) } : {}),
    lastDecayAt: Math.round(lastDecayAt),
    ...(forgotAt ? { forgotAt: Math.round(forgotAt) } : {}),
    tags: [`topic:${topic.tag}`],
    _topic: topic.tag,
  };
}

/* ------------------------------------------------------------------ *
 * 边
 * ------------------------------------------------------------------ *
 * 用「同主题优先 + 偏好依附」造边：先按主题分簇，再让高度节点更容易被连。
 * 这两条合起来才会长出真实图谱的三个特征 —— 团块、枢纽、长尾孤立点。
 * 纯随机会得到一张均匀的毛球，看不出任何结构，也就无法比较配色。
 */

function buildEdges(nodes, perNode) {
  const byTopic = new Map();
  for (const n of nodes) {
    const list = byTopic.get(n._topic) ?? [];
    list.push(n);
    byTopic.set(n._topic, list);
  }

  const degree = new Map(nodes.map((n) => [n.id, 0]));
  const seen = new Set();
  const edges = [];

  /**
   * 孤立点：真实库里必然存在 —— 新写入的记忆在同批次里找不到词法重叠，
   * 建不出边，就孤零零挂在那儿。比例看着不高，但在图上很显眼（一屏散点），
   * 所以必须在样本里出现，否则「孤立点该怎么画」这个决定永远不做。
   */
  const isolated = new Set(
    nodes.filter(() => rng() < 0.08).map((n) => n.id),
  );

  /** 偏好依附：度越高越容易被选中，模拟真实记忆里的「反复引用」。 */
  function pickTarget(pool, self) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const cand = pool[Math.floor(Math.pow(rng(), 1.6) * pool.length)];
      // 孤立点不能被别人连上，否则「孤立」只是它不发起边，最终仍有度
      if (cand && cand.id !== self.id && !isolated.has(cand.id)) return cand;
    }
    return pool.find((c) => c.id !== self.id && !isolated.has(c.id));
  }

  for (const node of nodes) {
    if (isolated.has(node.id)) continue;
    const sameTopic = byTopic.get(node._topic) ?? [];
    const crossTopic = nodes.filter((n) => n._topic !== node._topic);
    const want = Math.max(1, Math.round(perNode * between(0.4, 1.6)));

    for (let i = 0; i < want; i += 1) {
      // 85% 同主题、15% 跨主题：跨主题的那几条会在图上形成「桥」
      const pool = rng() < 0.85 ? sameTopic : crossTopic;
      if (pool.length < 2) continue;
      const target = pickTarget(pool, node);
      if (!target) continue;

      const key = node.id < target.id ? `${node.id}|${target.id}` : `${target.id}|${node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // 权重分布：多数 0.22~0.34，少数强相关
      const w = rng() < 0.18 ? between(CAUSAL_THRESHOLD, 0.62) : between(0.22, CAUSAL_THRESHOLD);
      let rel = w >= CAUSAL_THRESHOLD ? "causal" : "related";
      const roll = rng();
      if (roll < 0.04) rel = "contradicts";
      else if (roll < 0.10) rel = "temporal";

      edges.push({
        id: `e_${edges.length.toString().padStart(5, "0")}`,
        from: node.id,
        to: target.id,
        rel,
        weight: Number(w.toFixed(4)),
      });
      degree.set(node.id, degree.get(node.id) + 1);
      degree.set(target.id, degree.get(target.id) + 1);
    }
  }

  return { edges, degree };
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

const nodes = Array.from({ length: NODES }, (_, i) => makeNode(i));
const { edges, degree } = buildEdges(nodes, Number(arg("degree", 4)));

for (const n of nodes) n.degree = degree.get(n.id) ?? 0;
// _topic 是生成期的辅助字段，不写进产物：真实快照里没有它，
// 留着会让探针误以为可以按它上色（实际只能靠 tags）。
const clean = nodes.map(({ _topic, ...rest }) => rest);

const byTier = {};
const byKind = {};
const byRel = {};
for (const n of clean) byTier[n.tier] = (byTier[n.tier] ?? 0) + 1;
for (const n of clean) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
for (const e of edges) byRel[e.rel] = (byRel[e.rel] ?? 0) + 1;

const snapshot = {
  schema: "dsh-memory-graph/1",
  rev: 1,
  generatedAt: NOW,
  source: `sample(seed=${SEED}, nodes=${NODES}, degree=${arg("degree", 4)})`,
  stats: {
    memories: clean.length,
    edges: edges.length,
    byTier,
    byKind,
    byRel,
    avgDegree: Number((edges.length * 2 / clean.length).toFixed(2)),
    isolated: clean.filter((n) => n.degree === 0).length,
  },
  nodes: clean,
  edges,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2), "utf8");

const pct = (v) => `${((v / clean.length) * 100).toFixed(1)}%`;
console.log(`写出 ${OUT}`);
console.log(`  节点 ${clean.length}  边 ${edges.length}  平均度 ${snapshot.stats.avgDegree}  孤立 ${snapshot.stats.isolated}`);
console.log(`  tier  ${Object.entries(byTier).map(([k, v]) => `${k} ${v}(${pct(v)})`).join("  ")}`);
console.log(`  kind  ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join("  ")}`);
console.log(`  rel   ${Object.entries(byRel).map(([k, v]) => `${k} ${v}`).join("  ")}`);

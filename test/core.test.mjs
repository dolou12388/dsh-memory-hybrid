/**
 * 纯逻辑回归：不依赖 dsh 宿主，只测衰减/心情/抽取/召回/管线。
 *
 * domain 用一个内存替身，接口与 storage-domain 的 Domain 对齐：
 *   domain.table(name) -> { put, get, delete, entries, size, update, has }
 *   domain.global      -> { get, set }
 *
 * 为什么不把 sqlite 后端接进来跑：本文件关心的是算法与状态机，
 * 存储契约另有 sqlite-embedded.test.mjs 与 backend-contract.test.mjs 覆盖。
 * 混在一起会让失败原因难以定位。
 */

import {
  R_FORGET, R_DEMOTE, LAMBDA_LONG, S_MAX, S_PROMOTE, S_DEMOTE,
  LEVELS, THETA_BASE, K_V, K_A, G_BASE, SPACING_K,
  RECALL_MIN_PROMOTE, DEDUP_THRESHOLD, REL_THRESHOLD,
  levelOfImportance, levelOfStability, importanceFor, DAY_MS,
} from "../plugin/src/core/config.js";
import {
  retention, grow, revive, initState, settle, shouldPromote, reviveNode, weight,
} from "../plugin/src/core/decay.js";
import {
  normalizeMood, aggregate, updateEma, effectiveEma, writeThreshold, gainFactor,
  MOOD_COORDS, CATEGORIES,
} from "../plugin/src/mood/model.js";
import {
  extract, classifyKind, classifyLevel, shouldWrite, extractTags,
} from "../plugin/src/pipeline/extract.js";
import { runJob, recall, touchRecalled, sweep } from "../plugin/src/pipeline/pipeline.js";
import { VectorIndex, embed, rerank, quantize, graphExpand } from "../plugin/src/storage/vector.js";
import { WEIGHTS } from "../plugin/src/core/config.js";

/* ------------------------------------------------------------------ *
 * 内存 domain 替身
 * ------------------------------------------------------------------ */

class MemTable {
  constructor() { this.map = new Map(); }
  get size() { return this.map.size; }
  get(k) { return this.map.get(k); }
  has(k) { return this.map.has(k); }
  async put(k, v) { this.map.set(k, v); return v; }
  async delete(k) { this.map.delete(k); }
  async update(k, fn) {
    const cur = this.map.get(k);
    const next = fn(cur);
    this.map.set(k, next);
    return next;
  }
  entries() { return this.map.entries(); }
  keys() { return this.map.keys(); }
  values() { return this.map.values(); }
}

class MemDomain {
  constructor(initialGlobal) {
    this.tables = new Map();
    this._global = initialGlobal;
  }
  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new MemTable());
    return this.tables.get(name);
  }
  get global() {
    const self = this;
    return {
      get() { return self._global; },
      async set(v) { self._global = v; return v; },
    };
  }
}

function makeDeps(overrides = {}) {
  const domain = overrides.domain ?? new MemDomain({
    emaV: 0, emaA: 0, moodAt: 0,
    stats: { turnsSeen: 0, jobsDone: 0, recalled: 0, promoted: 0, forgotten: 0, revived: 0 },
    schemaV: 1,
  });
  return {
    domain,
    index: overrides.index ?? new VectorIndex(256),
    dim: 256,
    log: { debug() {}, info() {}, warn() {} },
    config: { jevEndpoint: "", jevApiKey: "", ...overrides.config },
    currentTurnId: "t1",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = "") {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log(`  ✗ ${name} ${extra}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `实际 ${a} / 期望 ${e}`);
}
function near(name, actual, expected, tol) {
  ok(name, Math.abs(actual - expected) <= tol, `实际 ${actual} / 期望 ${expected}±${tol}`);
}
function group(title) { console.log(`\n${title}`); }

/* ================================================================== *
 * 一、衰减三量模型
 * ================================================================== */

group("[1] 三量模型：retention / grow");
{
  // R = exp(-t/S_eff)
  eq("R(0) = 1", retention("active", 3, 0), 1);
  near("R(1天, S=3) = e^(-1/3)", retention("active", 3, 1 * DAY_MS), Math.exp(-1 / 3), 1e-9);
  // long 的 S 放大 LAMBDA_LONG 倍
  near("long 衰减慢 4 倍",
    retention("long", 3, 30 * DAY_MS), Math.exp(-30 / (3 * LAMBDA_LONG)), 1e-9);
  ok("R 单调递减", retention("active", 3, 10 * DAY_MS) < retention("active", 3, 5 * DAY_MS));
  // 边界
  eq("S=0 时 R=1（避免除零）", retention("active", 0, 1000), 1);
  eq("dt<=0 时 R=1", retention("active", 3, -100), 1);

  // grow：R=1 时增益必须恰为 0（间隔效应的核心性质）
  eq("R=1 时无增益", grow(10, 1.0), 10);
  // R 越低增益越大
  const gHighR = grow(10, 0.9);
  const gLowR = grow(10, 0.1);
  ok("R 越低增益越大", gLowR > gHighR, `${gLowR} vs ${gHighR}`);
  // 公式核对
  near("grow 公式", grow(10, 0.5), 10 * (1 + G_BASE * (Math.exp(SPACING_K * 0.5) - 1)), 1e-9);
  // 封顶
  eq("S 封顶 S_MAX", grow(S_MAX * 0.99, 0.05), S_MAX);
  // 心情增益
  ok("fMood>1 时增益更大", grow(10, 0.5, 1.05) > grow(10, 0.5, 1.0));
  ok("fMood<1 时增益更小", grow(10, 0.5, 0.9) < grow(10, 0.5, 1.0));

  // weight 仅展示
  near("weight = imp × R", weight(0.7, "active", 3, 0), 0.7, 1e-9);
}

group("[2] 三量模型：settle 状态转移");
{
  const now = Date.now();
  // 刚创建 → 无事件
  eq("新记忆无事件", settle({ tier: "active", stability: 3, createdAt: now }, now).event, null);

  // active 且 R < R_FORGET → forget
  const oldActive = { tier: "active", stability: 3, createdAt: now - 30 * DAY_MS };
  const st1 = settle(oldActive, now);
  eq("active 过期 → forget", st1.event, "forget");
  eq("forget 后 tier=dormant", st1.tier, "dormant");
  ok("forget 带 forgotAt", typeof st1.forgotAt === "number");

  // long 且 R < R_DEMOTE → demote
  const oldLong = { tier: "long", stability: 3, createdAt: now - 100 * DAY_MS };
  const st2 = settle(oldLong, now);
  eq("long 过期 → demote", st2.event, "demote");
  eq("demote 后 tier=active", st2.tier, "active");
  eq("demote 后 S=S_DEMOTE", st2.s, S_DEMOTE);

  // dormant 不再处理
  eq("dormant 无事件", settle({ tier: "dormant", stability: 0.1 }, now).event, null);

  // 字段名兼容：stability 与 s 都应被识别
  const viaStability = settle({ tier: "active", stability: 3, createdAt: now - 30 * DAY_MS }, now);
  const viaS = settle({ tier: "active", s: 3, createdAt: now - 30 * DAY_MS }, now);
  eq("stability 与 s 结果一致", viaStability.event, viaS.event);
  ok("缺字段时用默认 S0 而非崩溃", !!settle({ tier: "active" }, now));
}

group("[3] 三量模型：revive / promote");
{
  // revive：trivial 唤醒后至少抬到 normal 档
  const r1 = revive(0.5, "trivial");
  eq("trivial 唤醒抬档到 normal", r1.level, "normal");
  eq("importance 同步抬到 normal", r1.importance, LEVELS.normal.imp);
  // 语义：减半，但不低于该档地板（normal 地板 = 3.0 × 0.5 = 1.5）
  eq("trivial 唤醒后落到 normal 地板", r1.s, LEVELS.normal.s0 * 0.5);

  // 高 S 唤醒是减半，不是无损复原（遗忘的代价）
  const rHi = revive(20, "important");
  eq("高 S 唤醒减半", rHi.s, 10);
  // 但反复唤醒收敛到地板，不会无限下沉
  let s = 20;
  for (let i = 0; i < 10; i += 1) s = revive(s, "important").s;
  near("反复唤醒收敛到该档地板", s, LEVELS.important.s0 * 0.5, 1e-9);

  // critical 唤醒保持档位
  const r2 = revive(60, "critical");
  eq("critical 唤醒保持档位", r2.level, "critical");
  eq("critical 唤醒减半", r2.s, 30);

  // reviveNode 兼容两种字段名
  const n1 = reviveNode({ stability: 0.5, importance: 0.15 });
  const n2 = reviveNode({ s: 0.5, importance: 0.15 });
  eq("reviveNode 两字段名结果一致", n1.stability, n2.stability);
  eq("reviveNode 后 tier=active", n1.tier, "active");
  // 锚点必须推进：否则唤醒后立刻又被判遗忘
  const nowMs = Date.now();
  const n3 = reviveNode({ stability: 1, importance: 0.4, lastDecayAt: 0 }, nowMs);
  eq("唤醒把 lastDecayAt 推进到 now", n3.lastDecayAt, nowMs);
  eq("唤醒把 lastRecallAt 推进到 now", n3.lastRecallAt, nowMs);
  eq("唤醒清除 forgotAt", n3.forgotAt, undefined);

  // promote：必须同时满足 S 与 recallCount
  ok("S 够但次数不够 → 不晋升",
    !shouldPromote({ tier: "active", stability: S_PROMOTE + 1, recallCount: RECALL_MIN_PROMOTE - 1 }));
  ok("次数够但 S 不够 → 不晋升",
    !shouldPromote({ tier: "active", stability: S_PROMOTE - 1, recallCount: RECALL_MIN_PROMOTE }));
  ok("两者都够 → 晋升",
    shouldPromote({ tier: "active", stability: S_PROMOTE, recallCount: RECALL_MIN_PROMOTE }));
  ok("long 不再重复晋升", !shouldPromote({ tier: "long", stability: 100, recallCount: 10 }));

  // initState
  eq("critical 初始 tier=long", initState("critical").tier, "long");
  eq("normal 初始 tier=active", initState("normal").tier, "active");
  eq("initState 返回 stability 字段", initState("normal").stability, LEVELS.normal.s0);
  ok("initState 不含 s 字段（防静默失效）", !("s" in initState("normal")));

  // 档位反查
  eq("levelOfImportance(0.95)", levelOfImportance(0.95), "critical");
  eq("levelOfImportance(0.40)", levelOfImportance(0.40), "normal");
  eq("levelOfStability(14)", levelOfStability(14), "important");
  eq("importanceFor(trivial)", importanceFor("trivial"), LEVELS.trivial.imp);
}

/* ================================================================== *
 * 二、心情模型
 * ================================================================== */

group("[4] 心情：坐标与聚合");
{
  eq("8 类心情", CATEGORIES.length, 8);
  // 单标签 = 坐标 × intensity/3
  const a1 = aggregate([{ category: "开心", intensity: 3 }]);
  near("开心3 → v=1", a1.v, 1.0, 1e-9);
  near("开心3 → a=0.55", a1.a, 0.55, 1e-9);

  const a2 = aggregate([{ category: "开心", intensity: 1 }]);
  near("开心1 → v=1/3", a2.v, 1 / 3, 1e-9);

  // 组合：既开心又疲惫 → 效价相消但唤醒不全消
  const a3 = aggregate([{ category: "开心", intensity: 3 }, { category: "疲惫", intensity: 3 }]);
  near("开心3+疲惫3 → v=0.5", a3.v, 0.5, 1e-9);
  near("开心3+疲惫3 → a=-0.45", a3.a, -0.45, 1e-9);
  ok("组合后与单一心情可区分", a3.a !== 0 && a3.v !== 1);

  // 高唤醒矛盾态：开心3 + 焦虑3
  const a4 = aggregate([{ category: "开心", intensity: 3 }, { category: "焦虑", intensity: 3 }]);
  near("开心3+焦虑3 → v=0（效价相消）", a4.v, 0, 1e-9);
  near("开心3+焦虑3 → a=1.85→clamp 1", a4.a, 1, 1e-9);
  ok("一维模型无法区分的高唤醒不被抹平", a4.a > 0.5);

  // clamp
  const a5 = aggregate([
    { category: "兴奋", intensity: 3 }, { category: "焦虑", intensity: 3 },
  ]);
  ok("v 被 clamp 到 [-1,1]", a5.v <= 1 && a5.v >= -1);
}

group("[5] 心情：校验与规整");
{
  eq("空输入拒绝", normalizeMood(null).ok, false);
  eq("置信度不足拒绝", normalizeMood({ confidence: 0.4, labels: [{ category: "开心", intensity: 2 }] }).ok, false);
  eq("未知类别拒绝", normalizeMood({ confidence: 0.9, labels: [{ category: "狂喜", intensity: 2 }] }).ok, false);

  const n1 = normalizeMood({ confidence: 0.9, labels: [{ category: "开心", intensity: 2 }] });
  eq("合法输入通过", n1.ok, true);
  eq("标签保留", n1.labels[0].category, "开心");

  // intensity 越界被 clamp / 缺失默认 2
  const n2 = normalizeMood({ confidence: 0.9, labels: [{ category: "开心", intensity: 99 }] });
  eq("intensity 上界 clamp 到 3", n2.labels[0].intensity, 3);
  const n3 = normalizeMood({ confidence: 0.9, labels: [{ category: "开心", intensity: -5 }] });
  eq("intensity 下界 clamp 到 1", n3.labels[0].intensity, 1);
  const n4 = normalizeMood({ confidence: 0.9, labels: [{ category: "开心" }] });
  eq("intensity 缺失默认 2", n4.labels[0].intensity, 2);

  // 最多 2 个标签
  const n5 = normalizeMood({
    confidence: 0.9,
    labels: [
      { category: "开心", intensity: 3 }, { category: "专注", intensity: 2 },
      { category: "疲惫", intensity: 1 },
    ],
  });
  eq("超出的标签被丢弃", n5.labels.length, 2);
  eq("记录丢弃数", n5.dropped, 1);
}

group("[6] 心情：EMA 与调制");
{
  // 单轮即有明显影响
  const e1 = updateEma({ v: 0, a: 0 }, { v: 1, a: 1 });
  near("单轮 EMA v", e1.v, 0.55, 1e-9);
  near("单轮 EMA a", e1.a, 0.55, 1e-9);

  // 收敛
  let ema = { v: 0, a: 0 };
  for (let i = 0; i < 20; i += 1) ema = updateEma(ema, { v: 1, a: 1 });
  near("多轮收敛到 1", ema.v, 1, 1e-6);

  // 过期回落
  const stale = { v: 1, a: 1, at: Date.now() - 60 * 60 * 1000 };
  eq("超时 EMA 回落中性", effectiveEma(stale).v, 0);
  const fresh = { v: 1, a: 1, at: Date.now() };
  eq("新鲜 EMA 保持", effectiveEma(fresh).v, 1);

  // 门槛：跨过档位线是关键
  const thetaNeutral = writeThreshold({ v: 0, a: 0 });
  const thetaHappy = writeThreshold({ v: 1, a: 0 });
  const thetaSad = writeThreshold({ v: -1, a: 0 });
  near("中性 θ", thetaNeutral, THETA_BASE, 1e-9);
  near("开心 θ 下限", thetaHappy, THETA_BASE * (1 - K_V), 1e-9);
  near("低落 θ 上限", thetaSad, THETA_BASE * (1 + K_V), 1e-9);
  ok("θ 随效价单调递减", thetaHappy < thetaNeutral && thetaNeutral < thetaSad);

  // 门槛真的跨过档位线（设计里的核心检验）
  ok("开心时 normal 可写入", LEVELS.normal.imp >= thetaHappy);
  ok("中性时 normal 被拦", LEVELS.normal.imp < thetaNeutral);
  ok("中性时 important 可写入", LEVELS.important.imp >= thetaNeutral);
  ok("低落时 important 被拦", LEVELS.important.imp < thetaSad);

  // 唤醒增益：不分正负
  ok("高唤醒增益 > 1", gainFactor({ v: 0, a: 1 }) > 1);
  ok("低唤醒增益 < 1", gainFactor({ v: 0, a: -1 }) < 1);
  near("a=0 时增益为 1", gainFactor({ v: 0, a: 0 }), 1, 1e-9);
  near("焦虑态也加深（a 正负同效）",
    Math.abs(gainFactor({ v: 0, a: 0.85 }) - (1 + K_A * 0.85)), 0, 1e-9);
}

/* ================================================================== *
 * 三、抽取与判定
 * ================================================================== */

group("[7] 抽取：分类与分档");
{
  eq("偏好识别", classifyKind("我习惯用 pnpm，不喜欢 npm"), "preference");
  eq("流程识别", classifyKind("步骤是先安装依赖，然后跑测试，最后打包"), "procedural");
  eq("语义识别", classifyKind("这个约定是：署名固定为别动蟹黄堡"), "semantic");
  eq("叙事识别", classifyKind("昨天那次故障是上游超时导致的"), "episodic");

  eq("两个强约束词 → critical", classifyLevel("记住必须加上数据覆盖说明", false), "critical");
  eq("一个强约束词 → important", classifyLevel("这一点务必写进报告里", false), "important");
  eq("闲聊词 → trivial", classifyLevel("好的谢谢", false), "trivial");
  eq("短文本 → trivial", classifyLevel("嗯嗯", false), "trivial");
  eq("普通问句 → normal", classifyLevel("这个接口的超时时间是多少呢", true), "normal");
  eq("长文本 → important", classifyLevel("这".repeat(100), false), "important");

  // extract 的整体行为
  const r1 = extract({ userText: "好的", assistantText: "嗯" }, null);
  eq("过短文本不产生候选", r1.candidates.length, 0);

  const r2 = extract({ userText: "记住，报告的作者署名固定为别动蟹黄堡", assistantText: "好" }, null);
  eq("有效文本产生候选", r2.candidates.length, 1);
  ok("候选带 importance", r2.candidates[0].importance > 0);
  eq("候选 importance 不受心情影响（此处无心情）",
    r2.candidates[0].importance, importanceFor(r2.candidates[0].level));

  // 超长截断
  const longText = "记住" + "内容".repeat(1000);
  const r3 = extract({ userText: longText }, null);
  ok("超长文本被截断", r3.candidates[0].text.length <= 800, `${r3.candidates[0].text.length}`);

  // shouldWrite
  ok("critical 绕过门槛", shouldWrite({ level: "critical", importance: 0.95 }, 0.99));
  ok("高于门槛写入", shouldWrite({ level: "normal", importance: 0.4 }, 0.3));
  ok("低于门槛拦截", !shouldWrite({ level: "normal", importance: 0.4 }, 0.5));

  // 标签
  const tags = extractTags("使用 dsh-plugin 与 sqlite 存储，注意 ABCDef");
  ok("抽到英文标签", tags.some((t) => t.includes("sqlite")), tags.join(","));
  ok("标签数量受限", tags.length <= 12);
}

/* ================================================================== *
 * 四、向量索引与召回
 * ================================================================== */

group("[8] 向量索引");
{
  const idx = new VectorIndex(256);
  idx.put("a", "用户偏好红轴机械键盘", { tier: "active", importance: 0.4 });
  idx.put("b", "用户在写 dsh 记忆插件", { tier: "active", importance: 0.7 });
  idx.put("c", "机械键盘的轴体选择", { tier: "active", importance: 0.4 });

  eq("索引条数", idx.size, 3);
  const hits = idx.search(embed("机械键盘", 256), 3);
  ok("相关文本排前", hits[0].id === "a" || hits[0].id === "c", hits.map((h) => h.id).join(","));

  // dormant 不进索引
  idx.put("d", "已被遗忘的条目", { tier: "dormant" });
  const hits2 = idx.search(embed("已被遗忘的条目", 256), 10);
  ok("dormant 不被向量召回", !hits2.some((h) => h.id === "d"), hits2.map((h) => h.id).join(","));

  // rebuild 跳过 dormant 与无文本
  const idx2 = new VectorIndex(256);
  const n = idx2.rebuild([
    { id: "x", text: "有文本的", tier: "active" },
    { id: "y", text: "已遗忘的", tier: "dormant" },
    { id: "z", tier: "active" },
  ]);
  eq("rebuild 只索引有效条目", n, 1);

  // embed 确定性
  const v1 = embed("同一段文本", 256);
  const v2 = embed("同一段文本", 256);
  eq("embed 可复现", Array.from(v1).join(",") === Array.from(v2).join(","), true);

  // dropout
  idx.drop("a");
  ok("drop 后不存在", idx.get("a") === undefined);
}

group("[9] 图扩展与重排");
{
  const edges = [
    { id: "e1", from: "a", to: "b", rel: "related", weight: 0.4 },
    { id: "e2", from: "b", to: "c", rel: "related", weight: 0.4 },
  ];
  const byId = new Map([
    ["a", { id: "a", tier: "active" }],
    ["b", { id: "b", tier: "dormant" }],
    ["c", { id: "c", tier: "active" }],
  ]);
  const hits = graphExpand(["a"], edges, byId, 1);
  eq("1 跳命中 1 个", hits.length, 1);
  eq("命中的是 dormant 邻居", hits[0].id, "b");
  eq("带出 srcTier", hits[0].srcTier, "dormant");

  const hits2 = graphExpand(["a"], edges, byId, 2);
  eq("2 跳命中 2 个", hits2.length, 2);

  // 重排：lookup 必须传入，否则 dormant 被静默丢弃
  const idx = new VectorIndex(256);
  idx.put("a", "活跃条目", { tier: "active", importance: 0.7 });
  const cands = [{ id: "a", sim: 0.9 }, { id: "b", sim: 0.3 }];
  const scoredNoLookup = rerank(cands, idx, Date.now(), WEIGHTS);
  eq("不传 lookup 时 dormant 被丢弃", scoredNoLookup.length, 1);
  const scored = rerank(cands, idx, Date.now(), WEIGHTS, byId);
  eq("传 lookup 后 dormant 保留", scored.length, 2);

  // 量化
  const q = quantize([{ score: 0.123 }, { score: 0.876 }], 0.05);
  eq("量化到 0.05 网格", q.map((r) => r.score), [0.1, 0.9]);
}

/* ================================================================== *
 * 五、管线端到端
 * ================================================================== */

group("[10] 管线：runJob 写入");
{
  const deps = makeDeps();
  const r = await runJob(deps, { userText: "记住，报告署名固定为别动蟹黄堡" }, { id: "j1" });
  eq("写入成功", r.ok, true);
  eq("写入 1 条", r.written, 1);

  const mems = [...deps.domain.table("memories").values()];
  eq("memories 有记录", mems.length, 1);
  const m = mems[0];
  ok("stability 已落盘（非 undefined）", typeof m.stability === "number", `${m.stability}`);
  eq("stability 等于档位 S0", m.stability, LEVELS[m.importance >= 0.88 ? "critical" : "important"].s0);
  ok("createdAt 已落盘", typeof m.createdAt === "number");
  ok("writeMood.theta 已落盘", typeof m.writeMood?.theta === "number");
  eq("索引已投影", deps.index.size, 1);

  // 重复写入同一事实 → upsert 而非新建
  const r2 = await runJob(deps, { userText: "记住，报告署名固定为别动蟹黄堡" }, { id: "j2" });
  const mems2 = [...deps.domain.table("memories").values()];
  eq("重复不提新增", mems2.length, 1);
  eq("走 recur 分支", r2.written, 1);
  ok("recallCount 增加", mems2[0].recallCount >= 1, `${mems2[0].recallCount}`);
  ok("recurred 计数", mems2[0].recurred >= 1);

  // 统计
  eq("stats.jobsDone", deps.domain.global.get().stats.jobsDone, 2);
}

group("[11] 管线：心情调制写入");
{
  // 低心情：normal 被拦
  const depsSad = makeDeps();
  await runJob(depsSad, {
    userText: "今天看了一些关于网关的资料，顺便了解了下游链路",
    mood: { confidence: 0.9, labels: [{ category: "低落", intensity: 3 }] },
  }, { id: "j1" });
  const sadWritten = [...depsSad.domain.table("memories").values()].length;
  eq("低落时 normal 被拦", sadWritten, 0);
  ok("EMA 已更新", depsSad.domain.global.get().emaV < 0, `${depsSad.domain.global.get().emaV}`);

  // 高心情：同一条 normal 可写入
  const depsHappy = makeDeps();
  await runJob(depsHappy, {
    userText: "今天看了一些关于网关的资料，顺便了解了下游链路",
    mood: { confidence: 0.9, labels: [{ category: "开心", intensity: 3 }] },
  }, { id: "j1" });
  const happyWritten = [...depsHappy.domain.table("memories").values()].length;
  eq("开心时 normal 可写入", happyWritten, 1);

  // critical 无视门槛
  const depsCritical = makeDeps();
  await runJob(depsCritical, {
    userText: "记住必须禁止在生产环境直接改配置",
    mood: { confidence: 0.9, labels: [{ category: "低落", intensity: 3 }] },
  }, { id: "j1" });
  eq("critical 绕过低落门槛", [...depsCritical.domain.table("memories").values()].length, 1);

  // 低置信度心情被拒但不阻断写入
  const depsLowConf = makeDeps();
  await runJob(depsLowConf, {
    userText: "记住必须禁止在生产环境直接改配置",
    mood: { confidence: 0.3, labels: [{ category: "开心", intensity: 3 }] },
  }, { id: "j1" });
  eq("低置信度不阻断写入", [...depsLowConf.domain.table("memories").values()].length, 1);
  eq("记录被拒计数", depsLowConf.domain.global.get().stats.moodRejected, 1);
}

group("[12] 管线：召回与加深");
{
  const deps = makeDeps();
  await runJob(deps, { userText: "记住，报告署名固定为别动蟹黄堡" }, { id: "j1" });
  await runJob(deps, { userText: "用户在写 dsh 记忆插件，用的是 sqlite 后端" }, { id: "j2" });

  const hits = recall(deps, "报告署名是什么", { limit: 5 });
  ok("召回有结果", hits.length > 0, `${hits.length}`);
  ok("召回带 text", hits[0].text.length > 0);
  ok("召回带 tier", typeof hits[0].tier === "string");
  ok("召回带 score", typeof hits[0].score === "number");

  // touchRecalled 加深
  const before = deps.domain.table("memories").get(hits[0].id);
  const sBefore = before.stability;
  await touchRecalled(deps, hits);
  const after = deps.domain.table("memories").get(hits[0].id);
  ok("召回后 recallCount 增加", after.recallCount > before.recallCount);
  ok("召回后 stability 不减", after.stability >= sBefore, `${sBefore} → ${after.stability}`);

  // 刚写入就召回：R≈1，增益应接近 0（间隔效应）
  const gap = after.stability / sBefore;
  ok("R≈1 时增益接近 1（无间隔则无巩固）", gap < 1.02, `倍率 ${gap.toFixed(4)}`);
}

group("[13] 管线：遗忘与唤醒（dormant 只能经图通道）");
{
  const deps = makeDeps();
  const mems = deps.domain.table("memories");
  const now = Date.now();

  // 造两条已过期的记忆，手工写入（绕过管线以便控制时间戳）
  await mems.put("mA", {
    id: "mA", text: "上游网关的超时阈值是 30 秒", tier: "active",
    importance: 0.4, stability: 3, recallCount: 1,
    createdAt: now - 60 * DAY_MS, lastRecallAt: now - 60 * DAY_MS, lastDecayAt: now - 60 * DAY_MS,
  });
  await mems.put("mB", {
    id: "mB", text: "故障取证需要保留原始请求日志", tier: "active",
    importance: 0.4, stability: 3, recallCount: 1,
    createdAt: now - 60 * DAY_MS, lastRecallAt: now - 60 * DAY_MS, lastDecayAt: now - 60 * DAY_MS,
  });
  // 手工补一条边：dormant 唤醒必须靠它
  await deps.domain.table("edges").put("e1", {
    id: "e1", from: "mA", to: "mB", rel: "related", weight: 0.32,
  });
  deps.index.rebuild([...mems.values()]);
  eq("索引有 2 条", deps.index.size, 2);

  // sweep 让它们遗忘
  const sw = await sweep(deps, 100);
  eq("遗忘 2 条", sw.forgot, 2);
  eq("mA 变 dormant", mems.get("mA").tier, "dormant");
  eq("mB 变 dormant", mems.get("mB").tier, "dormant");
  ok("forgotAt 已记录", typeof mems.get("mA").forgotAt === "number");
  eq("dormant 被剥离索引", deps.index.size, 0);
  ok("遗忘但不删除", mems.size === 2);

  // 再 sweep 不重复计数
  const sw2 = await sweep(deps, 100);
  eq("已 dormant 不重复遗忘", sw2.forgot, 0);

  // 向量召回拿不到 dormant
  const vecHits = recall(deps, "上游网关的超时阈值", { limit: 5 });
  ok("dormant 不被向量召回", !vecHits.some((h) => h.tier === "dormant"), JSON.stringify(vecHits.map((h) => h.id)));

  // 唤醒：先让 mA 活过来（直接改 tier 模拟它因别的原因被召回），
  // 再验证 mB 能否经图通道被带出来
  await mems.put("mA", { ...mems.get("mA"), tier: "active", stability: 3, lastRecallAt: now, lastDecayAt: now });
  deps.index.put("mA", "上游网关的超时阈值是 30 秒", mems.get("mA"));

  const hitsAfter = recall(deps, "上游网关的超时阈值", { limit: 5 });
  const viaGraph = hitsAfter.find((h) => h.id === "mB");
  ok("mB 经图通道被召回", !!viaGraph, JSON.stringify(hitsAfter.map((h) => `${h.id}(${h.via})`)));
  eq("mB 的通道标记", viaGraph?.via, "graph");

  // 唤醒后回到 active 并重新进入索引
  const beforeRevive = mems.get("mB");
  await touchRecalled(deps, hitsAfter);
  const afterRevive = mems.get("mB");
  eq("唤醒后 tier=active", afterRevive.tier, "active");
  ok("唤醒后 importance 抬到 normal 下限", afterRevive.importance >= LEVELS.normal.imp);
  // 语义：减半但不低于档位地板（normal 地板 1.5）
  eq("唤醒后 S 落到地板（减半语义）", afterRevive.stability, LEVELS.normal.s0 * 0.5);
  eq("唤醒后清除 forgotAt", afterRevive.forgotAt, undefined);
  ok("唤醒后重新进索引", deps.index.get("mB") !== undefined);

  // 关键回归：唤醒后不能立刻又被 sweep 判为遗忘。
  // 若 reviveNode 不把 lastDecayAt 推进到 now，这里会立刻再次遗忘，
  // 表现为「无限循环唤醒」——不报错，只在 stats.revived 里看到异常增长。
  const sw3 = await sweep(deps, 100);
  eq("唤醒后不会被立刻再遗忘", sw3.forgot, 0);
  eq("mB 仍是 active", mems.get("mB").tier, "active");
}

group("[14] 管线：晋升长期");
{
  const deps = makeDeps();
  const mems = deps.domain.table("memories");
  const now = Date.now();

  // 稳定度够高、召回次数够 → 下次召回晋升
  await mems.put("mL", {
    id: "mL", text: "别动蟹黄堡 是报告作者署名 约定", tier: "active",
    importance: 0.7, stability: S_PROMOTE + 5, recallCount: RECALL_MIN_PROMOTE,
    createdAt: now - 3 * DAY_MS, lastRecallAt: now - 3 * DAY_MS, lastDecayAt: now - 3 * DAY_MS,
  });
  deps.index.rebuild([...mems.values()]);

  const hits = recall(deps, "报告作者署名", { limit: 3 });
  ok("召回命中", hits.some((h) => h.id === "mL"), JSON.stringify(hits.map((h) => h.id)));
  const tr = await touchRecalled(deps, hits);
  eq("晋升 1 条", tr.promoted, 1);
  eq("晋升后 tier=long", mems.get("mL").tier, "long");
  eq("晋升计入 stats", deps.domain.global.get().stats.promoted, 1);

  // long 层衰减慢：同样时间后 R 更高
  const rec = mems.get("mL");
  const rActive = retention("active", rec.stability, 20 * DAY_MS);
  const rLong = retention("long", rec.stability, 20 * DAY_MS);
  ok("long 衰减更慢", rLong > rActive, `${rLong.toFixed(4)} > ${rActive.toFixed(4)}`);
}

group("[15] 管线：健壮性");
{
  // 空载荷不崩
  const deps = makeDeps();
  const r = await runJob(deps, {}, { id: "j0" });
  eq("空载荷安全返回", r.ok, true);
  eq("空载荷不写入", r.written, 0);

  // 缺字段的记录不崩
  const deps2 = makeDeps();
  await deps2.domain.table("memories").put("bad", { id: "bad" });
  deps2.index.rebuild([{ id: "bad" }]);
  const sw = await sweep(deps2, 10);
  ok("缺字段记录不崩溃", typeof sw.forgot === "number");

  // 召回空库
  const deps3 = makeDeps();
  const empty = recall(deps3, "任何查询", { limit: 5 });
  eq("空库召回返回空数组", empty.length, 0);

  // touchRecalled 空数组
  const tr = await touchRecalled(deps3, []);
  eq("空命中安全", tr.touched, 0);
}

/* ------------------------------------------------------------------ */

console.log(`\n${"=".repeat(56)}`);
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) {
  console.log("\n失败项：");
  for (const f of failures) console.log(`  · ${f}`);
}
console.log("");
process.exit(fail === 0 ? 0 : 1);

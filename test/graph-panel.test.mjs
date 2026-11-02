/**
 * 图谱面板（浏览器半）的纯逻辑测试。
 *
 * 宿主只认 `apply`，但布局与数据规整才是真正会出错的地方 —— 它们在没有
 * 浏览器时也必须可断言。这里沿用 sidebar-panel 的做法：用一个假的
 * `window.__ModuleLoader__` 把 client.js 跑起来，取出 `__internals`。
 *
 * 断言的重点不是「画得好看」，而是三条会静默出错的：(1) 脏数据不能让整份
 * 数据变形；(2) 布局不能产生 NaN / 塌缩成一点；(3) 分簇力必须真的把同组
 * 拉到一起，否则「一眼看出这是几团」这个前提不成立。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = "") {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log(`  ✗ ${name} ${extra}`);
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} / ${JSON.stringify(b)}`); }
function group(t) { console.log(`\n${t}`); }

/* ------------------------------------------------------------------ *
 * 沙箱加载
 * ------------------------------------------------------------------ */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "graph", "client.js"), "utf8");

let captured;
const reactStub = {
  createElement: () => null,
  useRef: () => ({ current: null }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(def) { captured = def; },
    },
    devicePixelRatio: 1,
  },
  document: { createElement: () => ({ getContext: () => null, style: {} }) },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "graph/client.js" });

ok("模块已登记", !!captured, "client.js 没有调用 __ModuleLoader__.load");
eq("模块 id 正确", captured?.id, "dsh-memory-graph");

const factory = captured.factory;
const mod = factory((name) => {
  if (name === "react") return reactStub;
  throw new Error(`unexpected require: ${name}`);
});

ok("导出 apply", typeof mod.apply === "function");
eq("侧栏面板 id", mod.PANEL_ID, "memory-graph");
eq("跨包通道名", mod.CHANNEL, "/memory-hybrid");

const { normalize, buildLayout, settle, boundsOf, neighborsOf } = mod.__internals || {};
ok("导出内部函数", typeof normalize === "function" && typeof buildLayout === "function");
ok("导出 neighborsOf", typeof neighborsOf === "function");

/* ------------------------------------------------------------------ *
 * [0] 源码卫生：同名样式键
 * ------------------------------------------------------------------ *
 * 这一条来自一次真实事故：`styles` 里同时存在 `bar`（顶栏）和 `bar`（进度条），
 * JS 对象字面量里后者静默覆盖前者，于是顶栏被压成 4px 高、标题与按钮全部
 * 不可见，而控制台一句话都没有。图还照常渲染，所以肉眼看只像「顶栏样式怪」。
 *
 * 浏览器半没法在 node 里渲染，但可以静态断言「这个对象里没有重复键」。
 */

group("[0] 源码卫生");

{
  const stylesBody = source.slice(source.indexOf("const styles = {"));
  const end = stylesBody.indexOf("\n    };");
  const block = stylesBody.slice(0, end > 0 ? end : stylesBody.length);

  // 只数顶层键：每行形如 `  key: ...`（四空格缩进），嵌套对象缩进更深。
  const topKeys = [...block.matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]);
  const dupes = topKeys.filter((k, i) => topKeys.indexOf(k) !== i);
  eq("styles 顶层键无重复", [...new Set(dupes)], []);
  ok("styles 含顶栏键 topbar", topKeys.includes("topbar"), topKeys.join(","));
  ok("styles 仍有进度条键 bar", topKeys.includes("bar"));
}

/* ------------------------------------------------------------------ *
 * [1] 规整
 * ------------------------------------------------------------------ */

group("[1] 数据规整");

{
  const data = normalize({
    rev: 3,
    nodes: [
      { id: "a", text: "有标签", tags: ["topic:部署", "x"] },
      { id: "b" },
      { id: "c", tags: [] },
      { id: "d", tags: ["随手记"] },
      null,
      { text: "没有 id" },
    ],
    edges: [
      { id: "e1", from: "a", to: "b", rel: "causal", weight: 0.4 },
      { id: "e2", from: "a", to: "ghost", rel: "related", weight: 0.3 },
      { id: "e3", from: "b", to: "b", rel: "related", weight: 0.3 },
      { id: "e4", from: "a", to: "c", rel: "莫名其妙的类型", weight: 5 },
    ],
  });

  eq("丢掉无 id 的节点", data.nodes.length, 4);
  eq("rev 透传", data.rev, 3);
  eq("topic: 前缀剥离成分组", data.nodes[0].group, "部署");
  eq("缺字段给默认 kind", data.nodes[1].kind, "semantic");
  eq("缺字段给默认 tier", data.nodes[1].tier, "active");
  eq("无 tag 时无分组", data.nodes[2].group, null);
  eq("第一个 tag 也可作分组", data.nodes[3].group, "随手记");
  eq("悬空边被过滤", data.edges.length, 2);
  eq("自环被过滤", data.edges.some((e) => e.from === e.to), false);
  eq("未知 rel 归为 related", data.edges.find((e) => e.to === "c").rel, "related");
  eq("权重夹到 0..1", data.edges.find((e) => e.to === "c").weight, 1);
}

/* ------------------------------------------------------------------ *
 * [2] 布局
 * ------------------------------------------------------------------ */

group("[2] 布局");

function synthetic(groups = 3, perGroup = 14) {
  const nodes = [];
  const edges = [];
  for (let g = 0; g < groups; g += 1) {
    for (let i = 0; i < perGroup; i += 1) {
      nodes.push({
        id: `g${g}n${i}`, text: `节点 ${g}-${i}`, kind: "semantic", tier: "active",
        importance: 0.5, retention: 1, weight: 0.5, stability: 3, recallCount: 1,
        tags: [`topic:组${g}`], degree: 2, group: `组${g}`,
      });
    }
    // 组内成环，保证有边可拉
    for (let i = 0; i < perGroup; i += 1) {
      edges.push({
        id: `g${g}e${i}`, from: `g${g}n${i}`, to: `g${g}n${(i + 1) % perGroup}`,
        rel: "related", weight: 0.5,
      });
    }
  }
  return { nodes, edges };
}

{
  const { nodes, edges } = synthetic();
  const layout = buildLayout(nodes, edges);
  settle(nodes, layout);

  ok("全部坐标有限", nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  const b = boundsOf(nodes, 0);
  ok("没有塌缩成一个点", b.maxX - b.minX > 50 && b.maxY - b.minY > 50,
    `跨度 ${Math.round(b.maxX - b.minX)}×${Math.round(b.maxY - b.minY)}`);

  // 分簇是否真的成立：组内平均距离应显著小于组间
  const dist = (a, c) => Math.hypot(a.x - c.x, a.y - c.y);
  let intra = 0, intraN = 0, inter = 0, interN = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const d = dist(nodes[i], nodes[j]);
      if (nodes[i].group === nodes[j].group) { intra += d; intraN += 1; }
      else { inter += d; interN += 1; }
    }
  }
  const ratio = (intra / intraN) / (inter / interN);
  ok("组内距离明显小于组间（分簇成立）", ratio < 0.7, `比值 ${ratio.toFixed(2)}（越小越分得开）`);
}

{
  // 规模不应该把布局拖死：500 节点要能在合理 tick 内收敛
  const { nodes, edges } = synthetic(5, 100);
  const t0 = Date.now();
  const layout = buildLayout(nodes, edges);
  const ticks = settle(nodes, layout);
  const ms = Date.now() - t0;
  ok("500 节点在 1.5 秒内收敛", ms < 1500, `${ms}ms / ${ticks} ticks`);
  ok("500 节点坐标有效", nodes.every((n) => Number.isFinite(n.x)));
}

{
  // 空数据不能抛
  const layout = buildLayout([], []);
  settle([], layout);
  eq("空图 bounds 为 null", boundsOf([], 0), null);
}

{
  // 同 id 的抖动可复现：重开面板不应该换一张图
  const a = synthetic(2, 6).nodes;
  const b = synthetic(2, 6).nodes;
  buildLayout(a, []);
  buildLayout(b, []);
  ok("初始位置可复现", Math.abs(a[0].x - b[0].x) < 1e-9 && Math.abs(a[0].y - b[0].y) < 1e-9);
}

/* ------------------------------------------------------------------ *
 * [3] 邻居列表
 * ------------------------------------------------------------------ *
 * 详情卡里的「直接邻居」是顺着关联走下去的入口，决定了它是能当导航用
 * 还是只能当装饰。这里断言三件事：排序、悬空邻居、空输入。
 */

group("[3] 邻居列表");

{
  const byId = new Map([
    ["a", { id: "a", text: "中心" }],
    ["b", { id: "b", text: "弱关联" }],
    ["c", { id: "c", text: "强关联" }],
  ]);
  const adj = new Map([
    ["a", [{ id: "b", rel: "related", weight: 0.2 }, { id: "c", rel: "causal", weight: 0.9 }]],
    ["b", [{ id: "a", rel: "related", weight: 0.2 }]],
    ["c", [{ id: "a", rel: "causal", weight: 0.9 }]],
  ]);

  const list = neighborsOf({ adj, byId }, byId.get("a"));
  eq("邻居数量正确", list.length, 2);
  eq("按边权降序", list.map((x) => x.id), ["c", "b"]);
  eq("关系类型透传", list[0].rel, "causal");
  eq("邻居节点对象可解析", list[0].node?.text, "强关联");
}

{
  // 边指向一个不存在的节点：不能让整张卡片抛错，只能让那一行退化成 id
  const byId = new Map([["a", { id: "a" }]]);
  const adj = new Map([["a", [{ id: "ghost", rel: "temporal", weight: 0.5 }]]]);
  const list = neighborsOf({ adj, byId }, byId.get("a"));
  eq("悬空邻居仍列出", list.length, 1);
  eq("悬空邻居 node 为 undefined", list[0].node, undefined);
  eq("悬空邻居 id 保留", list[0].id, "ghost");
}

{
  eq("未选中时返回空数组", neighborsOf({ adj: new Map(), byId: new Map() }, null), []);
  eq("邻居表缺该节点时返回空数组", neighborsOf({ adj: new Map(), byId: new Map() }, { id: "x" }), []);
  eq("model 不完整时不抛", neighborsOf(null, { id: "x" }), []);
}

{
  // 孤立节点（degree=0）是真实分布里的大头之一（样本 36/420），不能报错
  const byId = new Map([["iso", { id: "iso" }]]);
  eq("孤立节点邻居为空", neighborsOf({ adj: new Map([["iso", []]]), byId }, byId.get("iso")), []);
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log("");
if (fail > 0) {
  console.log(`失败 ${fail} 项：`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`graph-panel：通过 ${pass} 项`);

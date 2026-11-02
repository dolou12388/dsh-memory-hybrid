/**
 * 图谱快照与 RPC 封套测试。
 *
 * 这个套件守的是**跨包契约**：`dsh-memory-graph/1` 的字段语义、派生值口径、
 * 脏数据处理，以及 RPC 层的信封形状。附属面板按这份契约消费，
 * 任何一条静默变化都会让面板显示错误的图（而不是报错）。
 *
 * 全部用假 domain，不碰真实存储 —— 投影是纯函数，不该需要 IO 才能测。
 */

import { buildSnapshot, TEXT_MAX } from "../plugin/src/graph/snapshot.js";
import { registerGraphRpc, RPC_CHANNEL } from "../plugin/src/graph/rpc.js";
import { LEVELS, DAY_MS } from "../plugin/src/core/config.js";

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
function near(name, a, b, eps = 1e-4) { ok(name, Math.abs(a - b) <= eps, `${a} vs ${b}`); }
function group(t) { console.log(`\n${t}`); }

/**
 * 只实现快照用到的那两个方法：table().entries()。
 *
 * 注意每次都从原数组重建迭代器，而不是在构造时固化成 Map —— 否则测试里
 * 「往数组里再 push 一条，看 rev 会不会推进」永远看不到变化（踩过一次）。
 */
function fakeDomain(memories = [], edges = []) {
  return {
    table(name) {
      const src = name === "memories" ? memories : edges;
      // 直接给 [key, value] 迭代器；对数组调 .entries() 得到的是 [index, pair]
      return { entries: () => src.map((r) => [r.id, r])[Symbol.iterator](), size: src.length };
    },
  };
}

const NOW = 1_800_000_000_000;

/* ------------------------------------------------------------------ *
 * [1] 缺省值与派生量
 * ------------------------------------------------------------------ */

group("[1] 缺省值 / 派生量");

{
  const snap = buildSnapshot(fakeDomain([
    { id: "a", text: "刚写的", importance: 0.4, stability: 3, tier: "active", lastDecayAt: NOW, createdAt: NOW },
  ]), { now: NOW, rev: 7 });

  const n = snap.nodes[0];
  eq("schema 固定", snap.schema, "dsh-memory-graph/1");
  eq("rev 透传", snap.rev, 7);
  eq("generatedAt 用注入时刻", snap.generatedAt, NOW);
  eq("缺 kind → semantic", n.kind, "semantic");
  eq("缺 tier → active", n.tier, "active");
  eq("缺 tags → []", n.tags, []);
  eq("缺 recallCount → 0", n.recallCount, 0);
  near("锚点=now 时 retention=1", n.retention, 1);
  near("weight = importance × R", n.weight, 0.4);
  eq("缺边时 degree=0", n.degree, 0);
}

{
  // long 的衰减是 active 的 1/4：同样 S=4 天、过 4 天
  const mk = (tier) => buildSnapshot(fakeDomain([
    { id: "n", text: "x", importance: 0.5, stability: 4, tier, lastDecayAt: NOW - 4 * DAY_MS, createdAt: NOW - 4 * DAY_MS },
  ]), { now: NOW }).nodes[0];

  const active = mk("active");
  const lng = mk("long");
  near("active: R = e^-1", active.retention, Math.exp(-1));
  near("long: R = e^-0.25", lng.retention, Math.exp(-0.25));
  ok("long 比 active 衰减慢", lng.retention > active.retention);
}

{
  // dormant 不该借用 long 的 4 倍放慢，否则沉底的记忆比对册的还亮
  const base = { id: "d", text: "x", importance: 0.9, stability: 4, lastDecayAt: NOW - 4 * DAY_MS, createdAt: NOW - 4 * DAY_MS };
  const dormant = buildSnapshot(fakeDomain([{ ...base, tier: "dormant" }]), { now: NOW }).nodes[0];
  const active = buildSnapshot(fakeDomain([{ ...base, tier: "active" }]), { now: NOW }).nodes[0];
  near("dormant 走 active 斜率", dormant.retention, active.retention);
}

/* ------------------------------------------------------------------ *
 * [2] 脏数据
 * ------------------------------------------------------------------ */

group("[2] 脏数据");

{
  const snap = buildSnapshot(fakeDomain(
    [{ id: "a", text: "在册", lastDecayAt: NOW }, { id: "b", text: "也在册", lastDecayAt: NOW }],
    [
      { id: "e1", from: "a", to: "b", rel: "causal", weight: 0.4 },
      { id: "e2", from: "a", to: "ghost", rel: "related", weight: 0.3 }, // 悬空
      { id: "e3", from: "b", to: "b", rel: "related", weight: 0.2 },     // 自环
      { id: "e4", from: undefined, to: "a" },                            // 坏字段
    ],
  ), { now: NOW });

  eq("只留下两端都存在的边", snap.edges.map((e) => e.id), ["e1"]);
  eq("悬空边被丢弃", snap.stats.edges, 1);
  eq("degree 在过滤前累计（含悬空边）", snap.nodes.find((n) => n.id === "a").degree, 2);
  eq("自环不计入 degree", snap.nodes.find((n) => n.id === "b").degree, 1);
  eq("byRel 只统计保留的边", snap.stats.byRel, { causal: 1 });
}

{
  // 文本截断：长度上限 + 不劈开代理对
  const long = "记".repeat(TEXT_MAX + 20);
  const emoji = "a" + "🚀".repeat(TEXT_MAX);
  const snap = buildSnapshot(fakeDomain([
    { id: "a", text: long, lastDecayAt: NOW },
    { id: "b", text: emoji, lastDecayAt: NOW },
  ]), { now: NOW });

  eq("长文本截到 TEXT_MAX（含省略号）", snap.nodes[0].text.length, TEXT_MAX);
  ok("截断加省略号", snap.nodes[0].text.endsWith("…"));
  ok("不产生孤立代理项", !/[\uD800-\uDBFF]$/.test(snap.nodes[1].text.slice(0, -1)));
  ok("emoji 文本不超上限", snap.nodes[1].text.length <= TEXT_MAX);
}

{
  // 完全空的库也要能出图，而不是抛错
  const snap = buildSnapshot(fakeDomain(), { now: NOW });
  eq("空库 nodes=[]", snap.nodes, []);
  eq("空库 avgDegree=0", snap.stats.avgDegree, 0);
  eq("空库 isolated=0", snap.stats.isolated, 0);
}

/* ------------------------------------------------------------------ *
 * [3] 统计口径与分页
 * ------------------------------------------------------------------ */

group("[3] 统计口径 / 分页");

{
  const nodes = [
    { id: "a", text: "a", importance: 0.9, lastDecayAt: NOW },
    { id: "b", text: "b", importance: 0.5, lastDecayAt: NOW },
    { id: "c", text: "c", importance: 0.1, lastDecayAt: NOW },
  ];
  const edges = [
    { id: "e1", from: "a", to: "b", rel: "related", weight: 0.5 },
    { id: "e2", from: "b", to: "c", rel: "related", weight: 0.5 },
  ];
  const all = buildSnapshot(fakeDomain(nodes, edges), { now: NOW });
  const top = buildSnapshot(fakeDomain(nodes, edges), { now: NOW, limit: 2 });

  eq("全量返回 3 个节点", all.nodes.length, 3);
  eq("limit 只返回 2 个", top.nodes.length, 2);
  eq("limit 不改变全库计数", top.stats.memories, 3);
  eq("limit 不改变全库边数", top.stats.edges, 2);
  eq("limit 时返回子集的边（b-c 被切掉）", top.edges.map((e) => e.id), ["e1"]);
  eq("返回条数单独记在 returned", top.stats.returned, 2);
  eq("limit 取权重最高的", top.nodes.map((n) => n.id).sort(), ["a", "b"]);
}

/* ------------------------------------------------------------------ *
 * [4] RPC 封套
 * ------------------------------------------------------------------ */

group("[4] RPC 封套");

/**
 * 造一个假的 webServer，截获注册进来的路由。
 *
 * 这里刻意按**真实签名**模拟：`register({ kind, path, handler })`，handler 接收
 * Node 的 `req` / `res`。图谱通道自己挂前缀路由（原因见 rpc.js 里那段长注释），
 * 所以测试必须走 HTTP 形状，而不是 `rpc.handle` 那个已废弃的抽象 —— 否则
 * 「路由没挂上」这类错误在单元测试里永远是绿的。
 */
function harness(memories) {
  const routes = [];
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const i = routes.indexOf(route);
          if (i >= 0) routes.splice(i, 1);
        };
      },
    },
    effect(fn) { return fn(); },
  };
  const log = { info() {}, warn() {} };
  registerGraphRpc(ctx, { domain: fakeDomain(memories) }, log);
  const route = routes[0];
  return { routes, route, log };
}

/** 直接调 handler 的便捷入口：把 endpoint/payload 打包成 RPC 客户端请求。 */
function call(route, endpoint, payload, { method, rpcId, contentType } = {}) {
  const body = JSON.stringify({
    type: "client-request",
    rpcId: rpcId ?? "11111111-1111-4111-8111-111111111111",
    method: method ?? endpoint,
    payload,
  });
  return send(route, {
    url: `${RPC_CHANNEL}/${endpoint}`,
    method: "POST",
    headers: { "content-type": contentType ?? "application/json" },
    body,
  });
}

/** 用最小的 req/res 桩跑一遍 handler，返回 { status, json }。 */
async function send(route, { url, method, headers, body }) {
  const req = (async function* () {
    if (body) yield Buffer.from(body, "utf8");
  })();
  req.url = url;
  req.method = method;
  req.headers = headers;

  const out = { status: 0, headers: {}, text: "" };
  const res = {
    writeHead(status, extra) {
      out.status = status;
      if (extra) Object.assign(out.headers, extra);
      return res;
    },
    end(chunk) {
      if (chunk != null) out.text += String(chunk);
      return res;
    },
  };
  await route.handler(req, res);
  let json;
  try { json = JSON.parse(out.text); } catch { json = undefined; }
  return { ...out, json };
}

{
  const mem = [{ id: "a", text: "x", importance: 0.5, lastDecayAt: NOW, createdAt: NOW }];
  const { route, routes } = harness(mem);

  ok("注册了一个路由", routes.length === 1);
  eq("路由是前缀型", route?.kind, "prefix");
  eq("通道名是跨包契约", route?.path, RPC_CHANNEL);
  eq("通道名带前导斜杠且符合 CHANNEL_PATTERN", /^\/[A-Za-z0-9._~-]+$/.test(RPC_CHANNEL), true);

  const first = (await call(route, "graph", null)).json;
  eq("响应是 server-response 信封", first?.type, "server-response");
  eq("rpcId 原样回传", first?.rpcId, "11111111-1111-4111-8111-111111111111");
  eq("成功返回 ok 信封", first?.result?.ok, true);
  eq("信封里带 schema", first?.result?.value?.schema, "dsh-memory-graph/1");
  eq("首次 rev = 1", first?.result?.value?.rev, 1);

  const second = (await call(route, "graph", null)).json;
  eq("数据没变时 rev 不推进", second?.result?.value?.rev, 1);

  const bad = (await call(route, "nope", null)).json;
  eq("未知 endpoint 返回错误信封", bad?.result?.ok, false);
  eq("未知 endpoint 带 code", bad?.result?.error?.code, "unknown-endpoint");

  // 数据变化（新增一条）→ rev 推进
  mem.push({ id: "b", text: "y", importance: 0.5, lastDecayAt: NOW, createdAt: NOW + 1 });
  const third = (await call(route, "graph", null)).json;
  eq("数据变化后 rev 推进", third?.result?.value?.rev, 2);

  // ---- 传输层契约 ----
  // 这几条是踩出来的：面板只显示 "HTTP 405" 时，必须能一眼看出是哪一层错了。
  const wrongMethod = await send(route, {
    url: `${RPC_CHANNEL}/graph`, method: "GET", headers: {},
  });
  eq("GET 被拒为 405", wrongMethod.status, 405);
  eq("405 带 allow 头", wrongMethod.headers.allow, "POST");

  const wrongType = await send(route, {
    url: `${RPC_CHANNEL}/graph`, method: "POST",
    headers: { "content-type": "text/plain" }, body: "{}",
  });
  eq("非 JSON content-type 被拒为 415", wrongType.status, 415);

  const notJson = await send(route, {
    url: `${RPC_CHANNEL}/graph`, method: "POST",
    headers: { "content-type": "application/json" }, body: "not json",
  });
  eq("坏 JSON 被拒为 400", notJson.status, 400);

  const methodMismatch = (await call(route, "graph", null, { method: "other" })).json;
  eq("method 与 endpoint 不符走错误信封", methodMismatch?.result?.error?.code, "gateway/bad-request");

  // 多段路径必须 404：endpoint 只允许单段，否则 `graph/../../x` 这种能穿出去
  const deep = await send(route, {
    url: `${RPC_CHANNEL}/graph/extra`, method: "POST",
    headers: { "content-type": "application/json" }, body: "{}",
  });
  eq("多段 endpoint 被拒为 404", deep.status, 404);
}

{
  // domain 抛错时必须走信封，不能 throw —— 否则网关会包成 Internal error 丢掉 code
  const routes = [];
  registerGraphRpc(
    {
      webServer: { register(r) { routes.push(r); return () => {}; } },
      effect(fn) { return fn(); },
    },
    { domain: { table() { throw new Error("库炸了"); } } },
    { info() {}, warn() {} },
  );

  const res = (await call(routes[0], "graph", null)).json;
  eq("异常也返回信封", res?.result?.ok, false);
  eq("异常带稳定 code", res?.result?.error?.code, "snapshot-failed");
  ok("异常消息透传", res?.result?.error?.message?.includes("库炸了"));
}

{
  // 没有 webServer（headless）时只 warn，不抛
  let warned = 0;
  const log = { info() {}, warn() { warned += 1; } };
  const out = registerGraphRpc({}, { domain: fakeDomain() }, log);
  eq("无 webServer 返回 undefined", out, undefined);
  eq("无 webServer 记一条 warn", warned, 1);
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
console.log(`graph-snapshot：通过 ${pass} 项`);

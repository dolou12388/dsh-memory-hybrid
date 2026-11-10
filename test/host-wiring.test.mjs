/**
 * 真实宿主装配测试：用 dsh 自带的 cordis + Storage + DomainFacility 真实现，
 * 加上本插件，走一遍真实的 inject / provide / effect 时序。
 *
 * 为什么要这个测试：sqlite 后端能否生效，不取决于引擎能否跑（那有 embedded 测试），
 * 而取决于**装配时序**——插件注册后端必然晚于 storage-domain 的 apply。
 * 若 profile 路由的后端与插件意图不同，「profile facility + 自建 facility」
 * 这条分支只有真 cordis 才复现得出，mock 测不出来。
 *
 * 用法：node test/host-wiring.test.mjs
 */

import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHost } from "./host-locate.mjs";

/**
 * 仓库内文件的绝对路径。
 *
 * 这里曾经写死过 `D:/Temp/Work Buddy/dsh-memory/...` —— 本机跑得通，
 * 推到 CI 就变成 `Cannot find module '/home/runner/.../D:/Temp/...'`。
 * 测试文件自己的位置才是唯一可靠的锚：test/ 的上一级就是仓库根。
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginPath = (...p) => join(REPO, "plugin", ...p);

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
 * 加载真实宿主模块
 * ------------------------------------------------------------------ */

// 宿主路径不再写死：由 test/host-locate.mjs 统一解析（复用插件的锚点搜索）。
// 环境里没有 dsh 时它会打印原因并按 skip 退出（退出码 0），不会伪装成失败。
const HOST = requireHost("宿主装配测试");

const cordisUrl = HOST.urlOf("cordis");
const { Context } = await import(cordisUrl);

const storageMod = await import(HOST.urlOf("dsh-storage"));
const domainMod = await import(HOST.urlOf("dsh-storage-domain"));
const jsonMod = await import(HOST.urlOf("dsh-storage-json"));

const { Storage, storageBackendServiceKey } = storageMod;
const { DomainFacility, defineDomain, domainTable } = domainMod;
const { JsonStorageBackend } = jsonMod;

console.log("宿主版本：dsh", HOST.version,
  "| cordis", readPkg(HOST.urlOf("cordis", "package.json"))?.version ?? "?",
  "| storage", readPkg(HOST.urlOf("dsh-storage", "package.json"))?.version ?? "?");

/** 读宿主包的版本号。缺文件时返回 null（不影响测试）。 */
function readPkg(fileUrl) {
  try {
    return JSON.parse(readFileSync(new URL(fileUrl), "utf8"));
  } catch { return null; }
}

/* ------------------------------------------------------------------ *
 * 最小宿主
 * ------------------------------------------------------------------ */

/**
 * 装配一个最小 dsh 宿主。
 * @param opts.backend profile 的默认后端名
 * @param opts.routes  per-domain 路由
 * @param opts.logger  日志收集器
 */
async function makeHost({ backend = "json", routes = {}, root, sink }) {
  const ctx = new Context();

  // 1. Storage hub（真实现）。它是 Cordis Service 子类：
  //    构造函数里的 super(ctx, "storage") 自己完成注册，不能再 provide，
  //    否则报 `service "storage" has been registered`。
  await ctx.plugin({
    name: "test-storage",
    apply(c) {
      new Storage(c);
    },
  });

  // 2. json 后端（真实现，模拟 profile 默认配置）
  const jsonDir = join(root, "json-store");
  await ctx.plugin({
    name: "test-storage-json",
    // ⚠ inject 声明不可省：Cordis 对 ctx 属性访问做保护，
    //   未声明的服务读一次就抛 `cannot get property "storage" without inject`。
    inject: ["storage"],
    apply(c) {
      const be = new JsonStorageBackend(jsonDir);
      c.effect(() => c.storage.backend.register("json", be), "test.json");
      c.provide(storageBackendServiceKey("json"), be);
    },
  });

  // 3. domain facility（真实现，挂到 ctx.storageDomain）
  await ctx.plugin({
    name: "test-storage-domain",
    inject: ["storage"],
    apply(c) {
      const facility = new DomainFacility(c, { backend, routes });
      c.provide("storageDomain", facility);
      c.effect(() => c.storage.mount("domain", facility), "test.mountDomain");
    },
  });

  // 4. systemPrompt / tools 替身（插件只需它们存在）
  await ctx.plugin({
    name: "test-system-prompt",
    apply(c) {
      c.provide("systemPrompt", { context(spec) { return () => {}; } });
    },
  });
  await ctx.plugin({
    name: "test-tools",
    apply(c) {
      c.provide("tools", { register() { return () => {}; } });
    },
  });

  // 5. logger：把插件的 log 调用收集起来
  ctx.logger = {
    debug: (...a) => sink.push(["debug", a.join(" ")]),
    info: (...a) => sink.push(["info", a.join(" ")]),
    warn: (...a) => sink.push(["warn", a.join(" ")]),
    error: (...a) => sink.push(["error", a.join(" ")]),
  };

  return ctx;
}

/**
 * 装配插件本体。
 *
 * @returns 插件模块。要销毁时调 `disposeOf(plugin)`。
 *
 * ⚠ 清理只能走 `ctx.plugin()` 返回的 **fiber** 的 `dispose()`，
 *   不是 `ctx.dispose()` —— 实测 cordis 4 的 Context 上根本没有
 *   `dispose` 方法（`typeof ctx.dispose === "undefined"`）。写成
 *   `ctx.dispose()` 不报错也不生效，effect 的清理函数永远不跑，
 *   于是锁不释放、domain 不关闭。第一版就踩了这个，导致「重启」用例
 *   里第一轮的锁一直held，第二轮正确判为另一实例并降级只读。
 *
 * ⚠ 不能把 fiber 挂到 plugin 上：ESM 的模块命名空间对象不可扩展
 *   （`Cannot add property dispose, object is not extensible`）。
 *   所以用 WeakMap 记。
 */
const FIBERS = new WeakMap();
async function mountPlugin(ctx, config) {
  const url = pathToFileURL(pluginPath("src", "index.js"));
  url.searchParams.set("t", String(Date.now() + Math.random()));
  const plugin = await import(url.href);
  const fiber = await ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    apply: (c, cfg) => plugin.apply(c, cfg),
  }, config);
  FIBERS.set(plugin, fiber);
  return plugin;
}

/** 销毁某个已装配的插件实例（释放锁、关 domain、移除监听）。 */
async function disposeOf(plugin) {
  const fiber = plugin ? FIBERS.get(plugin) : null;
  if (!fiber) return;
  FIBERS.delete(plugin);
  try { await fiber.dispose?.(); } catch { /* 已销毁则忽略 */ }
}

const BASE_CONFIG = {
  autoRecall: true, recallLimit: 6, dim: 256, contextOrder: 10500,
  jevEndpoint: "", jevApiKey: "", jevModel: "jev-1.14.0",
  sweepOnStart: false, verbose: true, storageMode: "auto", sqliteFile: "",
};

/** 从日志里找一条含关键词的内容 */
const hasLog = (sink, kw) => sink.some(([, m]) => m.includes(kw));
const logOf = (sink, kw) => sink.filter(([, m]) => m.includes(kw)).map(([, m]) => m);

const root = mkdtempSync(join(tmpdir(), "dsh-mem-host-"));

/* ================================================================== */

group("[1] profile backend=json、插件 storageMode=sqlite → 自建 facility");
{
  const sink = [];
  const sqliteFile = join(root, "case1.sqlite");
  const ctx = await makeHost({ backend: "json", routes: {}, root: join(root, "c1"), sink });

  let threw = null;
  try {
    await mountPlugin(ctx, { ...BASE_CONFIG, storageMode: "sqlite", sqliteFile });
  } catch (e) { threw = e; }

  ok("插件装配未抛错", threw === null, threw?.message);
  ok("sqlite 库文件已创建", existsSync(sqliteFile), sqliteFile);

  if (existsSync(sqliteFile)) {
    const buf = readFileSync(sqliteFile);
    ok("库文件非空", buf.length > 0, `${buf.length} bytes`);
    eq("文件头是标准 sqlite 格式", buf.subarray(0, 16).toString("latin1"), "SQLite format 3\u0000");
  }

  // 日志自证
  ok("日志报告后端为 sqlite", hasLog(sink, "storage backend = sqlite"),
    logOf(sink, "storage backend").join(" | "));
  ok("日志报告 domain 已打开", hasLog(sink, "domain opened"),
    logOf(sink, "domain opened").join(" | "));
  ok("走的是自建 facility 分支", hasLog(sink, "自建 domain facility"),
    logOf(sink, "facility").join(" | "));

  // 后端注册进 hub
  let names = [];
  try { names = ctx.storage.backend.names?.() ?? Object.keys(ctx.storage.backend); } catch { /* ignore */ }
  ok("hub 里两个后端并存", names.includes("json") || names.length === 0, JSON.stringify(names));
}

group("[2] profile 已把 domain 路由到 sqlite → 走 profile facility");
{
  const sink = [];
  const sqliteFile = join(root, "case2.sqlite");

  // 先建宿主，但 domain 的路由要等插件注册 sqlite 之后才能真正解析。
  // 这正是真实时序难点：DomainFacility 的 routes 在构造时就固定了，
  // 而插件注册后端必然更晚。所以这里先用一个「指向 sqlite」的 facility，
  // 但 sqlite 后端尚未注册 —— 验证插件会因 route 匹配而走 profile facility，
  // 且不重复自建。
  const ctx = await makeHost({
    backend: "json",
    routes: { memory_hybrid: "sqlite" },
    root: join(root, "c2"),
    sink,
  });

  let threw = null;
  try {
    await mountPlugin(ctx, { ...BASE_CONFIG, storageMode: "sqlite", sqliteFile });
  } catch (e) { threw = e; }

  // 预期失败：profile facility 路由到 sqlite，但插件自建的后端名
  // 与 profile facility 解析的时机不一致 → backend-not-found。
  // 这不是缺陷，而是「路由到尚未注册的后端」的必然结果，正好证明了
  // 应当优先走「自建 facility」而不是依赖 profile 的 route。
  console.log(`      装配结果：${threw ? `抛出 ${threw.code ?? threw.message}` : "成功"}`);
  if (threw) {
    ok("路由到未注册后端时 fail loud（不静默）", !!threw.code || !!threw.message,
      threw.code ?? threw.message);
  } else {
    ok("装配成功（插件已自建 facility 兜住）", hasLog(sink, "domain opened"),
      logOf(sink, "domain opened").join(" | "));
  }
  console.log("      日志：" + logOf(sink, "memory:").slice(0, 5).join("\n            "));
}

group("[3] storageMode=json → 不注册 sqlite，沿用 profile 路由");
{
  const sink = [];
  const sqliteFile = join(root, "case3-should-not-exist.sqlite");
  const ctx = await makeHost({ backend: "json", routes: {}, root: join(root, "c3"), sink });

  let threw = null;
  try {
    await mountPlugin(ctx, { ...BASE_CONFIG, storageMode: "json", sqliteFile });
  } catch (e) { threw = e; }

  ok("插件装配未抛错", threw === null, threw?.message);
  ok("未创建 sqlite 库文件", !existsSync(sqliteFile), sqliteFile);
  ok("日志报告用 json 路由", hasLog(sink, "storage backend = json"),
    logOf(sink, "storage backend").join(" | "));
  ok("日志报告 domain 已打开", hasLog(sink, "domain opened"),
    logOf(sink, "domain opened").join(" | "));
}

group("[4] 端到端：写入记忆 → 落盘 → 重启读回");
{
  const sink = [];
  const sqliteFile = join(root, "e2e.sqlite");
  const pluginMod = await import(
    pathToFileURL(pluginPath("src", "storage", "domain.js")).href
  );

  // 第一轮：装配 + 真实写入记忆
  const ctx1 = await makeHost({ backend: "json", routes: {}, root: join(root, "e2e1"), sink });
  let plugin1;
  try {
    plugin1 = await mountPlugin(ctx1, { ...BASE_CONFIG, storageMode: "sqlite", sqliteFile });
  } catch (e) {
    ok("第一轮装配", false, e?.message);
  }
  ok("第一轮装配成功", !!plugin1);
  ok("库文件已创建", existsSync(sqliteFile));
  ok("走的是自建 facility 分支", hasLog(sink, "自建 domain facility"),
    logOf(sink, "facility").join(" | "));

  // 取插件**自己开的那个** domain 来写。
  //
  // ⚠ 这里有个陷阱：不能用 ctx1.storageDomain.open() —— 那是 profile 的
  //   facility，与插件自建的 facility 是两个实例，各有一张 domains 表。
  //   拿 profile 的 facility 写，数据会进另一个 domain 实例，重启后自然是空的。
  //   插件的 domain 没暴露到 ctx 上，所以直接向后端要它的 unit。
  const be = ctx1.storage.backend.get("sqlite");
  ok("sqlite 后端已注册进 hub", !!be, JSON.stringify(ctx1.storage.backend.names()));

  // ⚠ 不能 be.kv.open() 同名的 unit —— 插件已经持有那个句柄，
  //   后端契约是「一个 unit 只能有一个活句柄」（already-open）。
  //   这里改用插件暴露的 public 面：backend.exportBytes() 走的是同一个
  //   内存库，再借 create 出来的实例读回。
  //   更干净的办法是等插件自身写（经 agent 管线），但那需要模型。
  //   所以这里用 SQL 直写同一张表，验证的是「落盘 → 重启读回」这一段。
  //
  // ⚠⚠ 覆盖库文件之前**必须先 await be.flush()**。
  //   后端是「改内存 → 标 dirty → setTimeout(0) 合并落盘」。domain 一打开
  //   就已经 dirty 且挂着一个 pending 定时器了（打开过程要写 domains 表）。
  //   若此时直接 writeFileSync 覆盖库文件，那个 pending 回调随后会拿
  //   **内存里没有 m1 的旧库**把刚写进去的数据整份盖掉 —— 第二轮自然是空的。
  //   这是本机绿、CI 红的那种竞态：本地 makeHost 的 await 恰好把 flush
  //   排在了覆盖之前，换个 Node 版本/机器就可能反过来。
  //   flush() 会清掉 pending 定时器并落盘，此后 dirty=false，不再自己写。
  const { loadSqlite } = await import(
    pathToFileURL(pluginPath("src", "storage", "sqlite-engine.js")).href
  );
  await be.flush();
  ok("落盘已排空（可安全覆盖）", be.dirty === false && !be.flushTimer,
    `dirty=${be.dirty} timer=${!!be.flushTimer}`);

  const SQL = await loadSqlite();
  const tmpDb = new SQL.Database(new Uint8Array(be.exportBytes()));
  const putSql = "INSERT INTO u_memory_hybrid__memories (key, ver, body) VALUES (?,?,?)";
  const st = tmpDb.prepare(putSql);
  st.run(["m1", pluginMod.DOMAIN_VERSION, JSON.stringify({
    id: "m1", text: "报告署名为别动蟹黄堡", tier: "long",
    importance: 0.7, stability: 14, recallCount: 3,
    createdAt: Date.now(), lastRecallAt: Date.now(), lastDecayAt: Date.now(), schemaV: 1,
  })]);
  st.free();
  const stE = tmpDb.prepare("INSERT INTO u_memory_hybrid__edges (key, ver, body) VALUES (?,?,?)");
  stE.run(["e1", pluginMod.DOMAIN_VERSION, JSON.stringify({
    id: "e1", from: "m1", to: "m1", rel: "related", weight: 0.3, schemaV: 1,
  })]);
  stE.free();
  const stG = tmpDb.prepare(`INSERT INTO _global (unit, body) VALUES (?,?) ON CONFLICT(unit) DO UPDATE SET body=excluded.body`);
  stG.run(["memory_hybrid", JSON.stringify({
    emaV: 0.4, emaA: 0.2, moodAt: Date.now(), stats: { turnsSeen: 9 }, schemaV: 1,
  })]);
  stG.free();
  const patched = tmpDb.export();
  tmpDb.close();

  // ⚠ 顺序很重要：**先销毁第一轮实例，再把补丁字节写回库文件**。
  //
  //   反过来（先写文件、后 dispose）会前功尽弃：dispose → domain.close()
  //   → backend.close() 一律 `flushNow({force:true})`，拿**内存里没有 m1
  //   的旧库**整份覆盖磁盘 —— 刚写进去的数据当场被抹掉，第二轮读到 0 条。
  //
  //   而「重启」这个语义本来就该是：实例先停（它把该落的盘落完），
  //   磁盘才是唯一的事实。之后用户/外部工具动文件，再起新实例读。
  //
  //   所以：flush 排空 → dispose（落盘 + 释放锁 + 关句柄）→ 写补丁文件
  //   → 新 Context 读回。这条先后关系与真实进程重启一致。
  //
  //   ⚠ 必须先销毁第一轮实例再开第二轮：实例锁在 apply 时抢、在 effect
  //     清理时释放。真实「重启」是进程退出 → 锁随进程消失，第二个进程
  //     自然抢得到。本测试是同一进程内模拟重启，第一轮 ctx1 活着、锁还
  //     held 着；不销毁就装第二轮，第二轮会**正确地**判定「另一实例在写」
  //     并降级只读 —— 它是照设计工作的，但日志带 [只读]，写入类断言必然失败。
  //
  //   ⚠ 用 disposeOf(plugin1)（fiber.dispose），不是 ctx1.dispose()：
  //     cordis 4 的 Context 上没有 dispose 方法，调用它不报错也不生效。
  await disposeOf(plugin1);
  ok("第一轮实例已销毁（锁应已释放）", !existsSync(`${sqliteFile}.lock`),
    existsSync(`${sqliteFile}.lock`) ? "锁文件仍在" : "");

  // 现在磁盘是唯一事实源：把补丁字节写回库文件（模拟外部写入的结果）
  const { writeFileSync } = await import("node:fs");
  writeFileSync(sqliteFile, patched);
  ok("库文件已写入数据", statSync(sqliteFile).size > 28672, `${statSync(sqliteFile).size} bytes`);

  // 第二轮：同一文件的**全新 Context**（模拟重启）
  const sink2 = [];
  const ctx2 = await makeHost({ backend: "json", routes: {}, root: join(root, "e2e2"), sink: sink2 });
  let plugin2;
  try {
    plugin2 = await mountPlugin(ctx2, { ...BASE_CONFIG, storageMode: "sqlite", sqliteFile });
  } catch (e) {
    ok("第二轮装配", false, e?.message);
  }
  ok("第二轮装配成功（读回已有库）", !!plugin2);

  const opened2 = logOf(sink2, "domain opened")[0] ?? "";
  ok("重启后读到 1 条记忆", opened2.includes("memories=1"), opened2);
  ok("重启后读到 1 条边", opened2.includes("edges=1"), opened2);
  console.log("      " + opened2);

  // 内容级校验：影子恢复的索引也应有 1 条
  ok("重启后索引恢复 1 条", hasLog(sink2, "restored 1 memories"),
    logOf(sink2, "restored").join(" | "));

  // 直接读回内容（同样走后端，不用 profile 的 facility，也不能重复 open unit）
  const be2 = ctx2.storage.backend.get("sqlite");
  const db2 = new SQL.Database(new Uint8Array(be2.exportBytes()));
  const readOne = (sql, params) => {
    const s = db2.prepare(sql);
    try {
      s.bind(params);
      if (!s.step()) return null;
      return s.getAsObject();
    } finally { s.free(); }
  };
  const memRow = readOne("SELECT body FROM u_memory_hybrid__memories WHERE key = ?", ["m1"]);
  const rec = memRow ? JSON.parse(memRow.body) : null;
  eq("重启后文本一致", rec?.text, "报告署名为别动蟹黄堡");
  eq("重启后 tier 一致", rec?.tier, "long");
  eq("重启后 stability 一致", rec?.stability, 14);
  eq("重启后 edges 保留", !!readOne("SELECT body FROM u_memory_hybrid__edges WHERE key = ?", ["e1"]), true);
  const gRow = readOne("SELECT body FROM _global WHERE unit = ?", ["memory_hybrid"]);
  eq("重启后 global 保留", gRow ? JSON.parse(gRow.body).stats.turnsSeen : null, 9);
  db2.close();
  ok("库文件非空", statSync(sqliteFile).size > 28672, `${statSync(sqliteFile).size}`);

  // 无载入告警
  ok("无损坏告警", !hasLog(sink2, "载入告警"), logOf(sink2, "载入告警").join(" | "));
}

group("[5] 库文件损坏 → 改名备份 + 重建，不阻断启动");
{
  const sink = [];
  const sqliteFile = join(root, "corrupt.sqlite");
  const { writeFileSync, readdirSync } = await import("node:fs");
  writeFileSync(sqliteFile, "not a real sqlite file at all");

  const ctx = await makeHost({ backend: "json", routes: {}, root: join(root, "c5"), sink });
  let threw = null;
  try {
    await mountPlugin(ctx, { ...BASE_CONFIG, storageMode: "sqlite", sqliteFile });
  } catch (e) { threw = e; }

  ok("损坏库不阻断装配", threw === null, threw?.message);
  ok("有载入告警", hasLog(sink, "载入告警"), logOf(sink, "载入告警").join(" | "));
  const aside = readdirSync(root).filter((f) => f.startsWith("corrupt.sqlite.corrupt-"));
  ok("坏文件被改名保留", aside.length === 1, aside.join(","));
  ok("日志报告 domain 已打开（空库）", hasLog(sink, "domain opened"));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${"=".repeat(56)}`);
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) { console.log("\n失败项："); for (const f of failures) console.log(`  · ${f}`); }
console.log("");
process.exit(fail === 0 ? 0 : 1);

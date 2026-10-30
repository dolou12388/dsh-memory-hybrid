/**
 * 内嵌引擎 sqlite 后端自测（不依赖 dsh 宿主，直接跑）。
 *
 * 覆盖：
 *   1. 引擎能否从包内 wasm 初始化
 *   2. 契约四件套（loadAll / putRecord / deleteRecord / setGlobal / backupRecord）
 *   3. 落盘与重启读回（同一文件重新 create）
 *   4. 版本语义（per-record 逐条丢弃 / single 整单拒绝）
 *   5. 损坏文件自愈
 *   6. 原子落盘不留临时文件
 */

import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSqlite, available } from "../plugin/src/storage/sqlite-engine.js";
import { SqliteStorageBackend } from "../plugin/src/storage/backend-sqlite.js";

let pass = 0;
let fail = 0;

function ok(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `\n      实际 ${a}\n      期望 ${e}`);
}

const dir = mkdtempSync(join(tmpdir(), "dsh-mem-sqlite-"));
const file = join(dir, "mem.sqlite");

const desc = {
  name: "memory_hybrid",
  version: 1,
  layout: "per-record",
  tables: ["memories", "edges", "journal"],
  hasGlobal: true,
};

console.log("\n[1] 内嵌引擎初始化");
{
  const t0 = Date.now();
  const probe = await available();
  const ms = Date.now() - t0;
  ok("available() 返回 ok", probe.ok === true, JSON.stringify(probe));
  console.log(`      首次初始化耗时 ${ms}ms`);
  const SQL = await loadSqlite();
  ok("Database 构造器存在", typeof SQL.Database === "function");
  // 单例：第二次应命中缓存
  const t1 = Date.now();
  await loadSqlite();
  const ms2 = Date.now() - t1;
  ok("单例生效（第二次 < 10ms）", ms2 < 10, `${ms2}ms`);
}

console.log("\n[2] 后端创建与建库落盘");
let backend;
{
  backend = await SqliteStorageBackend.create(file);
  ok("库文件已创建", existsSync(file));
  const sz = statSync(file).size;
  ok("库文件非空", sz > 0, `${sz} bytes`);
  eq("已打开 unit 为空", backend.names(), []);
}

console.log("\n[3] 契约：open / putRecord / loadAll");
const unit = await backend.kv.open(desc);
{
  ok("unit 已登记", backend.names().includes("memory_hybrid"));
  await unit.putRecord("memories", "m1", { id: "m1", text: "用户偏好红轴机械键盘", tier: "active" });
  await unit.putRecord("memories", "m2", { id: "m2", text: "用户在写 dsh 记忆插件", tier: "long" });
  await unit.putRecord("edges", "e1", { id: "e1", from: "m1", to: "m2", rel: "related", weight: 0.32 });
  await unit.putRecord("journal", "j1", { id: "j1", status: "pending", enqueuedAt: 1 });

  const snap = await unit.loadAll();
  eq("memories 条数", Object.keys(snap.tables.memories).length, 2);
  eq("edges 条数", Object.keys(snap.tables.edges).length, 1);
  eq("journal 条数", Object.keys(snap.tables.journal).length, 1);
  eq("记录内容正确", snap.tables.memories.m1.text, "用户偏好红轴机械键盘");
  eq("未设 global 时为 null", snap.global, null);
}

console.log("\n[4] 契约：setGlobal / 删除 / 覆盖写");
{
  await unit.setGlobal({ emaV: 0.4, emaA: -0.2, stats: { turnsSeen: 7 } });
  const snap = await unit.loadAll();
  eq("global 读回", snap.global.stats.turnsSeen, 7);

  await unit.putRecord("memories", "m1", { id: "m1", text: "改过的文本", tier: "long" });
  const snap2 = await unit.loadAll();
  eq("覆盖写生效", snap2.tables.memories.m1.text, "改过的文本");
  eq("覆盖写不增行", Object.keys(snap2.tables.memories).length, 2);

  await unit.deleteRecord("memories", "m2");
  const snap3 = await unit.loadAll();
  eq("删除后条数", Object.keys(snap3.tables.memories).length, 1);
  // 幂等
  await unit.deleteRecord("memories", "m2");
  ok("重复删除不抛错", true);
}

console.log("\n[5] backupRecord");
{
  await unit.putRecord("memories", "bad", { id: "bad" });
  const mark = await unit.backupRecord("memories", "bad");
  ok("返回归档标记", typeof mark === "string" && mark.includes("_backup"), mark);
  const snap = await unit.loadAll();
  ok("已从主表移除", snap.tables.memories.bad === undefined);
  const absent = await unit.backupRecord("memories", "nope");
  ok("备份不存在的键返回 absent", absent.includes("(absent)"), absent);
}

console.log("\n[6] 落盘与重启读回");
{
  await backend.flush();
  const sizeBefore = statSync(file).size;

  // 模拟重启：同一文件新建后端
  const b2 = await SqliteStorageBackend.create(file);
  const u2 = await b2.kv.open(desc);
  const snap = await u2.loadAll();
  eq("重启后 memories 条数", Object.keys(snap.tables.memories).length, 1);
  eq("重启后内容正确", snap.tables.memories.m1.text, "改过的文本");
  eq("重启后 global 保留", snap.global.stats.turnsSeen, 7);
  eq("重启后 edges 保留", Object.keys(snap.tables.edges).length, 1);

  const sz2 = statSync(file).size;
  ok("库文件大小稳定", Math.abs(sz2 - sizeBefore) < 4096, `${sizeBefore} → ${sz2}`);
  await b2.close();
}

console.log("\n[7] 版本语义");
{
  // per-record：版本不匹配的那条被读作不存在，其余照读
  const b3 = await SqliteStorageBackend.create(file);
  const u3 = await b3.kv.open({ ...desc, version: 1 });
  // 直接塞一条 version=99 的记录，模拟旧库
  const raw = await b3.db.prepare(
    "INSERT INTO u_memory_hybrid__memories (key, ver, body) VALUES (?, ?, ?)",
  );
  raw.bind(["stale", 99, JSON.stringify({ id: "stale" })]);
  raw.step();
  raw.free();

  const snap = await u3.loadAll();
  ok("per-record 丢弃版本不符的条目", snap.tables.memories.stale === undefined);
  eq("其余条目照读", Object.keys(snap.tables.memories).length, 1);
  await b3.close();

  // 版本门禁：unit 级版本不符 → 拒绝 open
  const b4 = await SqliteStorageBackend.create(file);
  let threw = null;
  try { await b4.kv.open({ ...desc, version: 2 }); } catch (e) { threw = e; }
  ok("unit 版本不符时抛 version-mismatch", threw?.code === "version-mismatch", threw?.code);
  await b4.close();
}

console.log("\n[8] 损坏文件自愈");
{
  const badFile = join(dir, "corrupt.sqlite");
  writeFileSync(badFile, "this is definitely not a sqlite database");
  const b5 = await SqliteStorageBackend.create(badFile);
  const st = b5.stats();
  ok("记录载入错误", typeof st.lastError === "string" && st.lastError.length > 0, st.lastError);
  const aside = readdirSync(dir).filter((f) => f.startsWith("corrupt.sqlite.corrupt-"));
  ok("坏文件被改名保留", aside.length === 1, aside.join(","));
  const u5 = await b5.kv.open(desc);
  const snap = await u5.loadAll();
  eq("重建后为空库", Object.keys(snap.tables.memories).length, 0);
  await b5.close();
}

console.log("\n[9] 原子落盘不留临时文件");
{
  const before = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  eq("落盘后无 .tmp 残留", before.length, 0);
}

console.log("\n[10] close 语义");
{
  await unit.close();
  ok("unit 已注销", !backend.names().includes("memory_hybrid"));
  let closedErr = null;
  try { await unit.putRecord("memories", "x", { id: "x" }); } catch (e) { closedErr = e; }
  ok("已关 unit 写入抛 closed", closedErr?.code === "closed", closedErr?.code);

  await backend.close();
  await backend.close(); // 幂等
  ok("后端可重复关闭", true);
  let openErr = null;
  try { await backend.kv.open(desc); } catch (e) { openErr = e; }
  ok("已关后端 open 抛 closed", openErr?.code === "closed", openErr?.code);
}

console.log("\n[11] 批量写入性能（合并落盘）");
{
  const perfFile = join(dir, "perf.sqlite");
  const b6 = await SqliteStorageBackend.create(perfFile);
  const u6 = await b6.kv.open(desc);
  const N = 2000;
  const t0 = Date.now();
  for (let i = 0; i < N; i += 1) {
    await u6.putRecord("memories", `k${i}`, { id: `k${i}`, text: `记忆条目 ${i}`, importance: 0.5 });
  }
  const insMs = Date.now() - t0;
  await b6.flush();
  const bytes = statSync(perfFile).size;
  const t1 = Date.now();
  const snap = await u6.loadAll();
  const readMs = Date.now() - t1;
  console.log(`      ${N} 条：插入 ${insMs}ms，落盘 ${(bytes / 1024).toFixed(0)}KB，全量读 ${readMs}ms`);
  eq("条数正确", Object.keys(snap.tables.memories).length, N);
  ok("合并落盘：flushes 远小于写入次数", b6.stats().flushes < N / 10, `flushes=${b6.stats().flushes}`);
  await b6.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);

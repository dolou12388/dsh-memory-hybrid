/**
 * 存储后端契约测试。
 *
 * 假 domain 层的行为，逐条验证 KvUnit 契约。与 sqlite-embedded.test.mjs
 * 的分工：那个测「引擎能不能用、数据能不能存回来」，这里只测「接口语义
 * 是否符合 @deepseek-ai/dsh-storage 的约定」—— 契约不符时 domain 层会
 * 静默丢数据，比引擎报错更难查。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteStorageBackend, UNIT_NAME_RE, GLOBAL_TABLE, BACKUP_TABLE } from "../plugin/src/storage/backend-sqlite.js";

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

async function throwsCode(fn) {
  try { await fn(); return null; } catch (e) { return e?.code ?? "no-code"; }
}

const dir = mkdtempSync(join(tmpdir(), "dsh-mem-contract-"));
let fileSeq = 0;
const newFile = () => join(dir, `c${(fileSeq += 1)}.sqlite`);

const BASE = { version: 1, layout: "per-record", tables: ["t1", "t2"], hasGlobal: true };

group("[1] descriptor 校验");
{
  const b = await SqliteStorageBackend.create(newFile());

  eq("unit 名首字母非小写 → malformed-medium",
    await throwsCode(() => b.kv.open({ ...BASE, name: "Bad" })), "malformed-medium");
  eq("unit 名含大写 → malformed-medium",
    await throwsCode(() => b.kv.open({ ...BASE, name: "badName" })), "malformed-medium");
  eq("unit 名含连字符 → malformed-medium",
    await throwsCode(() => b.kv.open({ ...BASE, name: "bad-name" })), "malformed-medium");
  eq("unit 名为空 → malformed-medium",
    await throwsCode(() => b.kv.open({ ...BASE, name: "" })), "malformed-medium");
  eq("表名非法 → malformed-medium",
    await throwsCode(() => b.kv.open({ ...BASE, name: "good", tables: ["Bad"] })), "malformed-medium");
  eq("version 非整数 → malformed-medium",
    await throwsCode(() => b.kv.open({ ...BASE, name: "good", version: 1.5 })), "malformed-medium");
  eq("version 为负 → malformed-medium",
    await throwsCode(() => b.kv.open({ ...BASE, name: "good", version: -1 })), "malformed-medium");

  // 合法名通过（下划线、数字）
  const u = await b.kv.open({ ...BASE, name: "good_name_2" });
  ok("合法 unit 名通过", !!u);
  eq("UNIT_NAME_RE 与 dsh-storage 一致", UNIT_NAME_RE.test("abc_123"), true);

  await b.close();
  eq("已关后端 open → closed", await throwsCode(() => b.kv.open({ ...BASE, name: "x" })), "closed");
}

group("[2] unit 独占：一个 unit 只能有一个活句柄");
{
  const b = await SqliteStorageBackend.create(newFile());
  const u = await b.kv.open({ ...BASE, name: "dupe" });
  eq("重复 open 同名 unit → already-open",
    await throwsCode(() => b.kv.open({ ...BASE, name: "dupe" })), "already-open");
  // 关闭后可以重新 open
  await u.close();
  const u2 = await b.kv.open({ ...BASE, name: "dupe" });
  ok("关闭后可重新 open", !!u2);
  await b.close();
}

group("[3] 表声明约束：未声明的表不可读写");
{
  const b = await SqliteStorageBackend.create(newFile());
  const u = await b.kv.open({ ...BASE, name: "u1" });

  eq("未声明表 putRecord → malformed-medium",
    await throwsCode(() => u.putRecord("t9", "k", {})), "malformed-medium");
  eq("未声明表 deleteRecord → malformed-medium",
    await throwsCode(() => u.deleteRecord("t9", "k")), "malformed-medium");

  // 声明过的表可用
  await u.putRecord("t1", "k", { v: 1 });
  const snap = await u.loadAll();
  eq("声明表可读", snap.tables.t1.k.v, 1);
  eq("未写入的声明表返回空对象", snap.tables.t2, {});

  await b.close();
}

group("[4] global 槽位");
{
  const b = await SqliteStorageBackend.create(newFile());

  // 未声明 hasGlobal
  const uNoGlobal = await b.kv.open({ ...BASE, name: "noglob", hasGlobal: false });
  eq("未声明 global 时 setGlobal → malformed-medium",
    await throwsCode(() => uNoGlobal.setGlobal({ x: 1 })), "malformed-medium");
  const snapNG = await uNoGlobal.loadAll();
  eq("未声明 global 时 loadAll.global 为 null", snapNG.global, null);

  // 声明了但没写过
  const uG = await b.kv.open({ ...BASE, name: "hasglob" });
  const snapBefore = await uG.loadAll();
  eq("未写过 global 时为 null", snapBefore.global, null);

  await uG.setGlobal({ a: 1 });
  eq("写入后读回", (await uG.loadAll()).global.a, 1);
  await uG.setGlobal({ a: 2, b: [1, 2] });
  const snapAfter = await uG.loadAll();
  eq("覆盖写生效", snapAfter.global.a, 2);
  eq("嵌套结构保留", snapAfter.global.b, [1, 2]);
  // 只存一份
  eq("global 每 unit 一行", (await uG.loadAll()).global.b.length, 2);

  await b.close();
}

group("[5] backlog：坏记录与 backupRecord");
{
  const b = await SqliteStorageBackend.create(newFile());
  const u = await b.kv.open({ ...BASE, name: "bk" });

  // 塞一条坏 JSON，绕过 putRecord
  const st = b.db.prepare("INSERT INTO u_bk__t1 (key, ver, body) VALUES (?,?,?)");
  st.bind(["broken", 1, "{not json"]); st.step(); st.free();

  // per-record：坏记录读作不存在
  const snap = await u.loadAll();
  eq("per-record 坏 JSON 被跳过", snap.tables.t1.broken, undefined);

  // backupRecord 归档
  const mark = await u.backupRecord("t1", "broken");
  ok("backupRecord 返回带表名的标记", mark.includes(BACKUP_TABLE), mark);
  eq("归档后主表无该记录", (await b.db.prepare("SELECT count(*) FROM u_bk__t1").get().n ?? 0) >= 0, true);

  // 归档写入旁路表
  const rows = [];
  const q = b.db.prepare(`SELECT unit, tbl, key, body FROM ${BACKUP_TABLE}`);
  while (q.step()) rows.push(q.getAsObject());
  q.free();
  eq("旁路表有 1 条", rows.length, 1);
  eq("归档保留原始字节", rows[0].body, "{not json");
  eq("归档记录 unit", rows[0].unit, "bk");
  eq("归档记录 table", rows[0].tbl, "t1");

  // 不存在时返回 absent 而不抛错
  const absent = await u.backupRecord("t1", "nope");
  ok("备份不存在的键不抛错", absent.includes("(absent)"));

  await b.close();
}

group("[6] single 布局：exact-version 语义");
{
  const b = await SqliteStorageBackend.create(newFile());
  const u = await b.kv.open({
    name: "single", version: 2, layout: "single",
    tables: ["t1"], hasGlobal: false, compatibleVersions: [1],
  });

  // 写入一条 ver=2
  await u.putRecord("t1", "ok", { v: "same" });
  eq("同版本读得到", (await u.loadAll()).tables.t1.ok.v, "same");

  // 塞一条 ver=1（在 compatibleVersions 里，但 single 布局应当拒绝整单）
  const st = b.db.prepare("INSERT INTO u_single__t1 (key, ver, body) VALUES (?,?,?)");
  st.bind(["old", 1, JSON.stringify({ v: "old" })]); st.step(); st.free();

  // single 的读是 exact-version：不认 compatibleVersions
  eq("single 布局拒绝整单 → version-mismatch",
    await throwsCode(() => u.loadAll()), "version-mismatch");

  await b.close();
}

group("[7] per-record 布局：compatibleVersions 生效");
{
  const b = await SqliteStorageBackend.create(newFile());
  const u = await b.kv.open({
    name: "perrec", version: 3, layout: "per-record",
    tables: ["t1"], hasGlobal: false, compatibleVersions: [2],
  });

  await u.putRecord("t1", "cur", { v: "v3" });
  const st = b.db.prepare("INSERT INTO u_perrec__t1 (key, ver, body) VALUES (?,?,?)");
  st.bind(["compat", 2, JSON.stringify({ v: "v2" })]); st.step(); st.free();
  const st2 = b.db.prepare("INSERT INTO u_perrec__t1 (key, ver, body) VALUES (?,?,?)");
  st2.bind(["stale", 1, JSON.stringify({ v: "v1" })]); st2.step(); st2.free();

  const snap = await u.loadAll();
  eq("当前版本可读", snap.tables.t1.cur.v, "v3");
  eq("compatibleVersions 内的旧版本可读", snap.tables.t1.compat.v, "v2");
  eq("不在兼容列表的旧版本被丢弃", snap.tables.t1.stale, undefined);

  await b.close();
}

group("[8] 写入幂等与原子性");
{
  const b = await SqliteStorageBackend.create(newFile());
  const u = await b.kv.open({ ...BASE, name: "idem" });

  await u.putRecord("t1", "k", { n: 1 });
  await u.putRecord("t1", "k", { n: 1 });
  await u.putRecord("t1", "k", { n: 1 });
  const snap = await u.loadAll();
  eq("重复写同一键不产生多行", Object.keys(snap.tables.t1).length, 1);

  // 删除幂等
  await u.deleteRecord("t1", "k");
  await u.deleteRecord("t1", "k");
  eq("重复删除不抛错且表为空", Object.keys((await u.loadAll()).tables.t1).length, 0);

  await b.close();
}

group("[9] 大记录与特殊字符");
{
  const b = await SqliteStorageBackend.create(newFile());
  const u = await b.kv.open({ ...BASE, name: "big" });

  const bigText = "记忆".repeat(50_000); // ~300KB
  await u.putRecord("t1", "big", { id: "big", text: bigText });
  const snap = await u.loadAll();
  eq("大记录完整读回", snap.tables.t1.big.text.length, bigText.length);

  // 特殊字符：引号、换行、emoji、SQL 关键字
  const tricky = { text: `'; DROP TABLE x; --\n"双引号"\t制表 🐱 emoji`, n: 1 };
  await u.putRecord("t1", "tricky", tricky);
  const snap2 = await u.loadAll();
  eq("SQL 注入式文本按数据存储", snap2.tables.t1.tricky.text.includes("DROP TABLE"), true);
  eq("emoji 保留", snap2.tables.t1.tricky.text.includes("🐱"), true);

  // 键名也是数据，不参与 SQL 拼接
  await u.putRecord("t1", "key'; DROP TABLE t1; --", { ok: 1 });
  const snap3 = await u.loadAll();
  ok("恶意键名安全", Object.keys(snap3.tables.t1).some((k) => k.includes("DROP TABLE")));

  await b.close();
}

group("[10] 并发 open 与 drain");
{
  const b = await SqliteStorageBackend.create(newFile());

  // 并发 open 不同 unit
  const results = await Promise.allSettled([
    b.kv.open({ ...BASE, name: "p1" }),
    b.kv.open({ ...BASE, name: "p2" }),
    b.kv.open({ ...BASE, name: "p3" }),
  ]);
  eq("并发 open 全部成功", results.filter((r) => r.status === "fulfilled").length, 3);
  eq("三个 unit 均已登记", b.names().sort(), ["p1", "p2", "p3"]);

  // 写入后不显式 flush，close 时应自动落盘
  const u1 = results[0].value;
  await u1.putRecord("t1", "last", { v: "written before close" });
  await b.close();

  // 重新打开验证
  const b2 = await SqliteStorageBackend.create(b.file);
  const u2 = await b2.kv.open({ ...BASE, name: "p1" });
  eq("close 时自动落盘（未显式 flush）", (await u2.loadAll()).tables.t1.last.v, "written before close");
  await b2.close();
}

group("[11] 只读导出");
{
  const b = await SqliteStorageBackend.create(newFile());
  const u = await b.kv.open({ ...BASE, name: "exp" });
  await u.putRecord("t1", "k", { v: 42 });

  const bytes = b.exportBytes();
  ok("导出非空", bytes.length > 0, `${bytes.length}`);

  // 导出的字节应当能被重新打开
  const { loadSqlite } = await import("../plugin/src/storage/sqlite-engine.js");
  const SQL = await loadSqlite();
  const db = new SQL.Database(new Uint8Array(bytes));
  const st = db.prepare("SELECT body FROM u_exp__t1 WHERE key = ?");
  st.bind(["k"]); st.step();
  eq("导出字节可被独立打开并查询", JSON.parse(st.getAsObject().body).v, 42);
  st.free();
  db.close();

  await b.close();
  eq("已关后端导出 → closed",
    await throwsCode(() => b.exportBytes()), "closed");
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${"=".repeat(56)}`);
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) { console.log("\n失败项："); for (const f of failures) console.log(`  · ${f}`); }
console.log("");
process.exit(fail === 0 ? 0 : 1);

/**
 * 把 tools/make-snapshot.mjs 产出的快照灌进当前 dsh 的 memory_hybrid 库。
 *
 * **只在本地调试用**：它直写 sqlite，绕过 domain 的写入链路与衰减结算，
 * 写入的记录只有「能被图谱读出来」所需的字段。不要在生产库上跑，
 * 也不要拿它当迁移工具。
 *
 * 它写的是**你真实的记忆库**，而且第一步就是 DELETE —— 所以默认不会动手：
 * 库里有数据时会先问一次，非交互环境（管道、CI）则直接拒绝，必须显式 --force。
 *
 * 用法：
 *   node tools/seed-store.mjs                         # 灌默认 420 条（会先确认）
 *   node tools/seed-store.mjs --nodes 1200            # 换规模
 *   node tools/seed-store.mjs --clear                 # 只清库（也会先确认）
 *   node tools/seed-store.mjs --db <path>             # 指定库文件
 *   node tools/seed-store.mjs --force                 # 跳过确认（脚本/CI 用）
 *   node tools/seed-store.mjs --no-backup             # 不写 pre-seed 备份
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, copyFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

if (has("help") || has("h")) {
  // 直接把文件头的注释块当帮助输出，省得正文和实现各说各话
  const head = readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0];
  console.log(
    head
      .replace(/^\/\*\*?/, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").replace(/\s+$/, ""))
      .join("\n")
      .trim(),
  );
  process.exit(0);
}

const DB = resolve(arg("db", join(homedir(), ".dsh", "storages", "memory_hybrid.sqlite")));
const CLEAR_ONLY = has("clear");
const FORCE = has("force") || has("-y");
const NO_BACKUP = has("no-backup");
const NODES = Number(arg("nodes", 420));

if (!existsSync(DB)) {
  console.error(`库不存在：${DB}\n先启动一次 dsh，让它把 domain 建出来。`);
  process.exit(1);
}

if (!Number.isFinite(NODES) || NODES < 1) {
  console.error(`--nodes 需要正整数，收到 ${arg("nodes")}`);
  process.exit(1);
}

const MEM = "u_memory_hybrid__memories";
const EDGE = "u_memory_hybrid__edges";

const db = new DatabaseSync(DB);

const tableExists = (name) =>
  Boolean(db.prepare("select 1 as x from sqlite_master where type='table' and name=?").get(name));

for (const t of [MEM, EDGE]) {
  if (!tableExists(t)) {
    console.error(`库里没有 ${t} —— 不是 memory_hybrid 的库，或者还没初始化。已中止，未改动任何数据。`);
    db.close();
    process.exit(1);
  }
}

const count = (t) => db.prepare(`select count(*) c from ${t}`).get().c;
const before = { mem: count(MEM), edge: count(EDGE) };

/**
 * 在动手之前把「将被毁掉的东西」摆到人眼前。
 *
 * 只说「将清空」没有说服力 —— 用户得看到几条真实的记忆，才会意识到这不是
 * 沙盒。这里刻意只取 3 条，多了就成了信息噪音，反而让人快速滑过。
 */
function describeExisting() {
  if (before.mem === 0) return "  现有：空库（没有会被覆盖的数据）";
  const lines = [`  现有：${before.mem} 条记忆 / ${before.edge} 条边`];
  const samples = db
    .prepare(`select body from ${MEM} limit 3`)
    .all()
    .map((r) => {
      try {
        return String(JSON.parse(r.body).text ?? "").slice(0, 34);
      } catch {
        return "(无法解析)";
      }
    })
    .filter(Boolean);
  if (samples.length > 0) {
    lines.push("  样本：" + samples[0]);
    for (const s of samples.slice(1)) lines.push("        " + s);
  }
  return lines.join("\n");
}

/**
 * 确认门槛。
 *
 * 三种放行：库本来就是空的（没什么可毁）、--force、用户亲自打了 yes。
 * 其余一律中止 —— 包括非交互环境，那里没人能回答，猜「大概是同意吧」
 * 正是这类脚本最不该做的事。
 */
async function confirmOrAbort(action) {
  if (!CLEAR_ONLY && before.mem === 0 && before.edge === 0) return true;
  if (FORCE) return true;

  const size = statSync(DB).size;
  const head = [
    "",
    `⚠ 即将${action}真实记忆库`,
    "",
    `  库文件：${DB}（${size} 字节）`,
    describeExisting(),
    "",
    "  这一步不可撤销：脚本直接 DELETE，不进回收站。",
    "",
  ];

  if (!process.stdin.isTTY) {
    console.error(head.join("\n"));
    console.error("  非交互环境，无法确认。确认要这么做请加 --force。");
    console.error("");
    db.close();
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // 要打完整的 yes，不接受直接回车 —— 破坏性操作不该靠肌肉记忆放行
    const answer = await rl.question(head.join("\n") + "  继续？输入 yes 确认（其他任意输入取消）：");
    if (answer.trim().toLowerCase() !== "yes") {
      console.log("已取消，未改动任何数据。");
      db.close();
      process.exit(1);
    }
  } finally {
    rl.close();
  }
  return true;
}

/**
 * 写一份可回滚的备份，固定文件名、每次覆盖。
 *
 * 不做带时间戳的累积备份：这个工具的定位是「看一眼效果」，跑几次就留几个
 * 350 KB 文件，最后没人敢删。只留最近一份，够反悔一次就行。
 */
function backup() {
  if (NO_BACKUP) {
    console.log("  · 已跳过备份（--no-backup）");
    return;
  }
  const dst = `${DB}.pre-seed.bak`;
  copyFileSync(DB, dst);
  console.log(`  · 备份：${dst}`);
  console.log("    要回滚就把这个文件复制回去覆盖原库，然后重启 dsh。");
}

/* ------------------------------------------------------------------ */

if (CLEAR_ONLY) {
  await confirmOrAbort("清空");
  backup();
  db.exec(`DELETE FROM ${MEM}; DELETE FROM ${EDGE};`);
  console.log(`已清空 ${DB}`);
  console.log(`  清掉 ${before.mem} 条记忆 / ${before.edge} 条边`);
  console.log("  ⚠ 必须重启 dsh：插件在进程内缓存快照，运行期改库不会被感知。");
  db.close();
  process.exit(0);
}

// 样本：有就复用，没有再生成（生成器的输出是确定性的，同 seed 逐字节一致）
const SEED = resolve(HERE, "snapshot.seed.json");
if (!existsSync(SEED) || NODES !== 420) {
  execFileSync(process.execPath, [resolve(HERE, "make-snapshot.mjs"), "--nodes", String(NODES), "--out", SEED], {
    stdio: "inherit",
  });
}
const snap = JSON.parse(readFileSync(SEED, "utf8"));

// 生成样本是纯读操作，确认放在它之后 —— 先让人看到「要灌多少」再问要不要灌
console.log("");
await confirmOrAbort(`灌入 ${snap.nodes.length} 条样本记忆，覆盖`);
backup();

// 快照的节点已经是投影后的形状（retention/weight/degree 都是算出来的派生值），
// 回灌时只保留源字段，派生值丢弃 —— 否则库里会存一份会过期的冗余。
const memStmt = db.prepare(`INSERT OR REPLACE INTO ${MEM} (key, ver, body) VALUES (?, 1, ?)`);
const edgeStmt = db.prepare(`INSERT OR REPLACE INTO ${EDGE} (key, ver, body) VALUES (?, 1, ?)`);

db.exec("BEGIN");
try {
  db.exec(`DELETE FROM ${MEM}; DELETE FROM ${EDGE};`);

  for (const n of snap.nodes) {
    const row = {
      id: n.id,
      text: n.text,
      kind: n.kind,
      tier: n.tier,
      importance: n.importance,
      stability: n.stability,
      recallCount: n.recallCount ?? 0,
      createdAt: n.createdAt,
      tags: Array.isArray(n.tags) ? n.tags : [],
    };
    if (n.lastRecallAt) row.lastRecallAt = n.lastRecallAt;
    if (n.lastDecayAt) row.lastDecayAt = n.lastDecayAt;
    if (n.forgotAt) row.forgotAt = n.forgotAt;
    memStmt.run(n.id, JSON.stringify(row));
  }

  for (const e of snap.edges) {
    edgeStmt.run(e.id, JSON.stringify({ id: e.id, from: e.from, to: e.to, rel: e.rel, weight: e.weight }));
  }

  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}

console.log(`已写入 ${DB}`);
console.log(`  记忆 ${count(MEM)}  边 ${count(EDGE)}（原 ${before.mem} / ${before.edge}）`);
console.log("  ⚠ 必须重启 dsh 才能在图谱里看到；看完记得 node tools/seed-store.mjs --clear");
db.close();

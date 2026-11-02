/**
 * 把 tools/make-snapshot.mjs 产出的快照灌进当前 dsh 的 memory_hybrid 库。
 *
 * **只在本地调试用**：它直写 sqlite，绕过 domain 的写入链路与衰减结算，
 * 写入的记录只有「能被图谱读出来」所需的字段。不要在生产库上跑，
 * 也不要拿它当迁移工具。
 *
 * 用法：
 *   node tools/seed-store.mjs                         # 灌默认 420 条
 *   node tools/seed-store.mjs --nodes 1200            # 换规模
 *   node tools/seed-store.mjs --clear                # 只清库
 *   node tools/seed-store.mjs --db <path>            # 指定库文件
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const DB = resolve(arg("db", join(homedir(), ".dsh", "storages", "memory_hybrid.sqlite")));
const CLEAR_ONLY = argv.includes("--clear");
const NODES = Number(arg("nodes", 420));

if (!existsSync(DB)) {
  console.error(`库不存在：${DB}\n先启动一次 dsh，让它把 domain 建出来。`);
  process.exit(1);
}

const MEM = "u_memory_hybrid__memories";
const EDGE = "u_memory_hybrid__edges";

const db = new DatabaseSync(DB);

if (CLEAR_ONLY) {
  db.exec(`DELETE FROM ${MEM}; DELETE FROM ${EDGE};`);
  console.log(`已清空 ${DB}`);
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

const m = db.prepare(`SELECT count(*) c FROM ${MEM}`).get().c;
const ed = db.prepare(`SELECT count(*) c FROM ${EDGE}`).get().c;
console.log(`已写入 ${DB}`);
console.log(`  记忆 ${m}  边 ${ed}`);
db.close();

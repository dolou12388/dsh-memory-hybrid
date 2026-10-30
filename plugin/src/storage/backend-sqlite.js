/**
 * sqlite 存储后端 —— 引擎由插件自带（内嵌 wasm），零外部依赖。
 *
 * 契约来源：@deepseek-ai/dsh-storage 的 backend.d.ts。
 *   StorageBackend { kv?: KvFacet, close() }
 *   KvFacet        { open(descriptor) -> KvUnit }
 *   KvUnit         { loadAll, putRecord, deleteRecord, backupRecord?, setGlobal, close }
 *
 * 引擎来源见 sqlite-engine.js：SQLite 官方的 wasm 编译产物随包分发，
 * 用 `wasmBinary` 直接喂字节，不查系统路径、不联网、不看 Node 版本。
 *
 * 与 json 后端的取舍差异：
 *   · json 的 per-record 布局「一条记录一个文件」，10 万条记忆就是 10 万个 inode。
 *     sqlite 用一张表装一个 unit，写入是行级事务，不受文件数影响。
 *   · json 的 open 必须 readdir 整个目录才能 loadAll。sqlite 走主键索引。
 *   · 代价：sqlite 是单文件二进制，不能像 json 那样直接 cat 看内容。
 *     所以 backupRecord 落到旁路表而非移动文件，并额外提供只读导出口。
 *
 * 持久化模型的根本差异（wasm 引擎没有文件系统层）：
 *   库常驻内存，`db.export()` 才拿到完整文件字节。因此本后端的写路径是
 *   「改内存 → 标记 dirty → 一拍内合并落盘」。实测 1 万条约 2.5MB，
 *   export 约 1ms，所以每次写入后落盘是可接受的；合并窗口让突发写入
 *   （一个 turn 内连写十几条）只落盘一次。
 *
 *   代价：进程被 kill -9 会丢最后一次落盘之后的写入。这比 json 后端弱
 *   （json 是逐条 write 即持久）。对记忆系统而言可接受 —— 丢的是「最近
 *   几毫秒的加固」，不是全量。载入时若发现文件损坏（上次落盘被截断），
 *   后端会把它改名备份后从空库重建，而不是让 domain 打不开。
 *
 * 布局语义（严格按契约）：
 *   · 两种布局都接受。single 布局在 sqlite 里没有性能差异，但版本检查更严格：
 *     契约规定 single 的读是 exact-version，per-record 才看 compatibleVersions。
 *   · per-record 下版本不符的记录「读作不存在」（契约原文：an unaccepted
 *     version stamp discards only that record）。因此不抛错，直接跳过。
 *   · single 下版本不符「整个 unit 拒绝」，抛 version-mismatch。
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  renameSync, unlinkSync, openSync, fsyncSync, closeSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";

import { hostExport } from "../resolve.js";
import { loadSqlite } from "./sqlite-engine.js";

/** 工具名安全校验：与 dsh-storage 的 UNIT_NAME_RE 保持一致 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** global 槽位的固定表名。unit 表名一律带前缀，避免与业务表冲突。 */
const GLOBAL_TABLE = "_global";
/** 被 backupRecord 移出的记录落在这里，保留原始字节供事后检查 */
const BACKUP_TABLE = "_backup";

/** 建库 DDL。meta 表存 unit 版本戳。 */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  unit    TEXT PRIMARY KEY,
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ${GLOBAL_TABLE} (
  unit TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
  unit     TEXT NOT NULL,
  tbl      TEXT NOT NULL,
  key      TEXT NOT NULL,
  body     TEXT NOT NULL,
  moved_at TEXT NOT NULL,
  PRIMARY KEY (unit, tbl, key, moved_at)
);
`;

/**
 * 引擎 PRAGMA。
 *
 * journal_mode = OFF 是这里最关键的设置，理由不是「快」而是「不该有」：
 *   sqlite 的回滚日志是为了「进程崩溃时库文件仍一致」。但在本后端里，
 *   库常驻内存，磁盘上的文件只在 flushNow 时整体覆盖写 —— 每次都是
 *   完整新文件 → rename。所以进程崩溃时磁盘上的旧文件是完整的，内存里
 *   的回滚日志毫无用处，纯粹是每日上千次 创建/删除 空文件的开销。
 *
 *   实测 2000 条插入：默认 192ms，MEMORY 40ms，OFF 35ms。
 *   加上 synchronous=OFF（wasm 没有真实磁盘同步，该设置本就无意义）后 21ms。
 *
 *   这个取舍的安全性完全依赖 persistAtomically 的「临时文件 → fsync → rename」，
 *   不能单独拿掉任何一边。
 */
const PRAGMAS = [
  "PRAGMA journal_mode = OFF",
  "PRAGMA synchronous = OFF",
  "PRAGMA foreign_keys = ON",
  "PRAGMA temp_store = MEMORY",
];

/* ------------------------------------------------------------------ *
 * sql.js 语句辅助
 *
 * sql.js 的 Statement 没有 node:sqlite 的 .all()/.get() 快捷方法，只有
 * bind/step/getAsObject/free。这里统一包一层，并保证 finally 里 free ——
 * 泄漏的语句会在下一次 db.export() 时被强制释放，届时仍被引用的对象
 * 会变成空壳，再 step() 就抛 "Statement closed"。
 *
 * ⚠ 性能：每次 db.prepare() 都要把 SQL 文本编组进 wasm 堆，是整条写路径
 *   的瓶颈。实测 2000 条插入：每写 prepare/free 217ms，复用语句 6ms
 *   —— 差 36 倍。所以下面用语句缓存，只在 SQL 文本变化时重新 prepare。
 *
 * ⚠ 缓存必须能被 db.export() 失效：export 会释放所有语句并重开句柄，
 *   缓存里的旧 Statement 会变成空壳。flushNow 因此调用 dropStatementCache。
 * ------------------------------------------------------------------ */

/** db 实例 → (sql → Statement)。用 WeakMap 挂在 db 上，关闭后自然回收。 */
const stmtCache = new WeakMap();

/** 单库缓存上限。记忆系统的 SQL 文本种类是个位数量级，64 足够且能兜住异常。 */
const STMT_CACHE_MAX = 64;

function cachedStatement(db, sql) {
  let map = stmtCache.get(db);
  if (!map) {
    map = new Map();
    stmtCache.set(db, map);
  }
  let stmt = map.get(sql);
  if (stmt) return stmt;

  // 简单的 LRU：满了就释放最旧的一条
  if (map.size >= STMT_CACHE_MAX) {
    const [oldSql, oldStmt] = map.entries().next().value;
    try { oldStmt.free(); } catch { /* ignore */ }
    map.delete(oldSql);
  }

  stmt = db.prepare(sql);
  map.set(sql, stmt);
  return stmt;
}

/** export / close 之后调用：旧语句全部作废，缓存必须清空。 */
function dropStatementCache(db) {
  const map = db ? stmtCache.get(db) : null;
  if (!map) return;
  for (const stmt of map.values()) {
    try { stmt.free(); } catch { /* export 已代为释放 */ }
  }
  map.clear();
}

/** 取全部行。返回普通对象数组。 */
function queryAll(db, sql, params = []) {
  const stmt = cachedStatement(db, sql);
  stmt.reset();
  if (params.length > 0) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  return out;
}

/** 取首行。无行返回 undefined。 */
function queryOne(db, sql, params = []) {
  const rows = queryAll(db, sql, params);
  return rows.length > 0 ? rows[0] : undefined;
}

/** 执行写语句（INSERT/UPDATE/DELETE）。无返回值。 */
function execute(db, sql, params = []) {
  // 无参数时走 sqlite3_exec，可一次执行多条语句（建表 DDL 用到）。
  // 这类语句不进缓存：DDL 只在 open 时跑一次，缓存它们毫无意义。
  if (params.length === 0) {
    db.run(sql);
    return;
  }
  const stmt = cachedStatement(db, sql);
  stmt.reset();
  stmt.bind(params);
  stmt.step();
}

/**
 * 原子落盘：临时文件 → fsync → rename。
 *
 * rename 在同一文件系统内是原子的，因此读者要么看到旧文件、要么看到
 * 新文件，不会看到半个。先 fsync 再 rename 是关键顺序 —— 反过来的话，
 * 断电可能换来一个「已经改名成功但内容还是空」的文件，那是真正的数据
 * 丢失，比不落盘更糟。
 */
function persistAtomically(file, bytes) {
  const dir = dirname(file);
  const tmp = join(dir, `.${basename(file)}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);

  try {
    writeFileSync(tmp, bytes);
    try {
      const fd = openSync(tmp, "r+");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch {
      // 某些文件系统（网络盘、容器 overlay）不支持 fsync，忽略；
      // 此时原子性仍在，只是掉电后可能丢最后一次写入。
    }
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 清理失败不掩盖原错 */ }
    throw e;
  }
}

/** 取 StorageError 构造器。宿主一定有，缺失时退化为普通 Error。 */
function storageError() {
  try {
    return hostExport("@deepseek-ai/dsh-storage", "StorageError");
  } catch {
    return class Fallback extends Error {
      constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "StorageError";
      }
    };
  }
}

/** 表名映射：unit 名 → 实际表名。unit 名本身受 UNIT_NAME_RE 约束，故安全。 */
function tableName(unit, table) {
  return `u_${unit}__${table}`;
}

function validateDescriptor(descriptor, StorageError) {
  if (!UNIT_NAME_RE.test(descriptor.name)) {
    throw new StorageError("malformed-medium", `invalid unit name '${descriptor.name}'`);
  }
  for (const t of descriptor.tables) {
    if (!UNIT_NAME_RE.test(t)) {
      throw new StorageError("malformed-medium", `invalid table name '${t}' in unit '${descriptor.name}'`);
    }
  }
  if (!Number.isInteger(descriptor.version) || descriptor.version < 0) {
    throw new StorageError("malformed-medium", `unit '${descriptor.name}': version must be a non-negative integer`);
  }
}

/**
 * 单个已打开的 unit。
 *
 * 并发写不做序列化 —— 契约明确这是调用方（domain 层）的责任。
 * 这里只保证「每次调用在内存库上生效且已排队落盘」。
 */
class SqliteUnit {
  constructor(descriptor, backend, StorageError) {
    this.descriptor = descriptor;
    this.backend = backend;
    this.StorageError = StorageError;
    this.closed = false;

    const isPerRecord = descriptor.layout === "per-record";
    this.accepted = new Set([descriptor.version, ...(isPerRecord ? descriptor.compatibleVersions ?? [] : [])]);
    this.isPerRecord = isPerRecord;
  }

  /** 每次访问都从 backend 取当前 db —— export() 会重开句柄，不能缓存。 */
  get db() {
    return this.backend.db;
  }

  assertOpen() {
    if (this.closed) {
      throw new this.StorageError("closed", `unit '${this.descriptor.name}' is closed`);
    }
  }

  /** 写后统一走 backend 的合并落盘 */
  write(sql, params = []) {
    execute(this.db, sql, params);
    this.backend.scheduleFlush();
  }

  /**
   * 读全量快照。
   *
   * 版本校验分两路：
   *   · per-record：逐条看版本，不在 accepted 集合里就跳过（契约：discard only that record）
   *   · single：任一条版本不符即整单拒绝（契约：exact-version）
   */
  async loadAll() {
    this.assertOpen();
    const { name, tables } = this.descriptor;
    const out = { tables: {}, global: null };

    for (const t of tables) {
      const rows = queryAll(this.db, `SELECT key, ver, body FROM ${tableName(name, t)}`);
      const records = {};
      for (const row of rows) {
        if (!this.accepted.has(row.ver)) {
          if (this.isPerRecord) continue; // 该条作废，其余照读
          throw new this.StorageError(
            "version-mismatch",
            `unit '${name}': record '${row.key}' in table '${t}' has version ${row.ver}, expected ${this.descriptor.version}`,
          );
        }
        try {
          records[row.key] = JSON.parse(row.body);
        } catch (e) {
          if (this.isPerRecord) continue;
          throw new this.StorageError("malformed-medium", `unit '${name}': record '${row.key}' is not valid JSON`, { cause: e });
        }
      }
      out.tables[t] = records;
    }

    if (this.descriptor.hasGlobal) {
      const g = queryOne(this.db, `SELECT body FROM ${GLOBAL_TABLE} WHERE unit = ?`, [name]);
      if (g) {
        try {
          out.global = JSON.parse(g.body);
        } catch (e) {
          throw new this.StorageError("malformed-medium", `unit '${name}': global slot is not valid JSON`, { cause: e });
        }
      }
    }
    return out;
  }

  /** 单条 upsert。 */
  async putRecord(table, key, value) {
    this.assertOpen();
    if (!this.descriptor.tables.includes(table)) {
      throw new this.StorageError("malformed-medium", `unit '${this.descriptor.name}': undeclared table '${table}'`);
    }
    this.write(
      `INSERT INTO ${tableName(this.descriptor.name, table)} (key, ver, body)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET ver = excluded.ver, body = excluded.body`,
      [key, this.descriptor.version, JSON.stringify(value)],
    );
  }

  /** 单条删除。幂等。 */
  async deleteRecord(table, key) {
    this.assertOpen();
    if (!this.descriptor.tables.includes(table)) {
      throw new this.StorageError("malformed-medium", `unit '${this.descriptor.name}': undeclared table '${table}'`);
    }
    this.write(`DELETE FROM ${tableName(this.descriptor.name, table)} WHERE key = ?`, [key]);
  }

  /**
   * 把一条记录移到旁路表，保留字节。
   *
   * 契约允许行存储「省略这个方法」，此时调用方会走 reject-loud 路径。
   * 但我们实现它 —— 因为 memory domain 声明了 invalidRecords:'backup-and-skip'，
   * 没有这个方法坏记录就会让整个 domain 打不开。
   *
   * 两步写必须整体成立（先归档再删），否则会丢记录。这里用保存点
   * 包起来：中途抛错就回滚，内存库不会停在「删了但没归档」的状态。
   */
  async backupRecord(table, key) {
    this.assertOpen();
    const t = tableName(this.descriptor.name, table);
    const row = queryOne(this.db, `SELECT body FROM ${t} WHERE key = ?`, [key]);
    if (!row) return `${this.descriptor.name}/${table}/${key} (absent)`;

    const movedAt = new Date().toISOString();
    execute(this.db, "SAVEPOINT memory_backup");
    try {
      execute(
        this.db,
        `INSERT INTO ${BACKUP_TABLE} (unit, tbl, key, body, moved_at) VALUES (?, ?, ?, ?, ?)`,
        [this.descriptor.name, table, key, row.body, movedAt],
      );
      execute(this.db, `DELETE FROM ${t} WHERE key = ?`, [key]);
      execute(this.db, "RELEASE memory_backup");
    } catch (e) {
      execute(this.db, "ROLLBACK TO memory_backup");
      execute(this.db, "RELEASE memory_backup");
      throw e;
    }
    this.backend.scheduleFlush();
    return `sqlite:${BACKUP_TABLE}/${this.descriptor.name}/${table}/${key}@${movedAt}`;
  }

  /** 写 global 槽位。仅在 descriptor 声明 hasGlobal 时合法。 */
  async setGlobal(value) {
    this.assertOpen();
    if (!this.descriptor.hasGlobal) {
      throw new this.StorageError("malformed-medium", `unit '${this.descriptor.name}' does not declare a global slot`);
    }
    this.write(
      `INSERT INTO ${GLOBAL_TABLE} (unit, body) VALUES (?, ?)
       ON CONFLICT(unit) DO UPDATE SET body = excluded.body`,
      [this.descriptor.name, JSON.stringify(value)],
    );
  }

  /** 释放句柄。幂等。 */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.backend.open.delete(this.descriptor.name);
  }
}

/**
 * sqlite 后端。
 *
 * 一个后端实例拥有一个数据库文件，所有 unit 共存于其中。
 * 与 json 后端「一 unit 一目录」的区别在于：这里是「一文件多表」，
 * 因此 open 的开销与 unit 数量无关。
 *
 * 构造是异步的（要等 wasm 初始化），用 `SqliteStorageBackend.create()`。
 */
export class SqliteStorageBackend {
  /** @type {import("./sqlite-engine.js").loadSqlite extends never ? never : any} */
  db = null;

  constructor(file, sql) {
    this.file = file;
    this.sql = sql;
    this.open = new Map();
    this.opening = new Map();
    this.closed = false;
    this.dirty = false;
    this.flushTimer = null;
    this.lastError = null;
    this.flushes = 0;
    this.StorageError = storageError();

    /**
     * 进程退出兜底。
     *
     * 合并落盘用的是 setTimeout(0)，正常情况下下一拍就写完了。但若进程
     * 恰好在那一拍内退出（Ctrl+C、宿主 shutdown、单次 CLI 运行结束），
     * 最后一批写入会丢。beforeExit 在事件循环空转时触发，此时还来得及
     * 同步落盘。
     *
     * 不用 exit：exit 回调里只能做同步操作，而且此时 stdout 可能已关。
     * beforeExit 可以安全地做同步写（我们本来就是同步写）。
     *
     * listener 必须能被释放，否则多个后端实例会累积。close() 里移除。
     */
    this.onBeforeExit = () => {
      if (this.closed || !this.dirty) return;
      try { this.flushNow(); } catch { /* 退出阶段尽力而为 */ }
    };
    process.on?.("beforeExit", this.onBeforeExit);
  }

  /**
   * 打开（或新建）库文件。
   *
   * 载入失败的处理很关键：损坏的库文件不能让 domain 打不开 —— 那会让
   * 整个记忆功能消失，用户还得自己去删文件。改名备份后从空库重建，
   * 并在 lastError 里留下原因。
   *
   * ⚠ sql.js 的 `new SQL.Database(bytes)` 是惰性加载：坏字节不会在构造时
   *   抛错，要等第一次真正读表才报 "file is not a database"。所以必须
   *   主动探一次 sqlite_master，把错误提前到可控位置。
   */
  static async create(file) {
    const sql = await loadSqlite();
    const backend = new SqliteStorageBackend(file, sql);

    if (existsSync(file)) {
      let cause = null;
      try {
        const bytes = readFileSync(file);
        if (bytes.length === 0) throw new Error("库文件为空（上次落盘被截断）");
        backend.db = new sql.Database(new Uint8Array(bytes));
        // 主动探活：这一步才会真正解析文件头
        queryOne(backend.db, "SELECT count(*) AS n FROM sqlite_master");
      } catch (e) {
        cause = e;
        try { backend.db?.close(); } catch { /* 坏句柄，忽略 */ }
        backend.db = null;
        backend.recoverFromCorrupt(file, cause);
        backend.db = new sql.Database();
      }
    } else {
      mkdirSync(dirname(file), { recursive: true });
      backend.db = new sql.Database();
    }

    // PRAGMA 要在任何写入之前设：journal_mode 是库级持久设置，
    // 建表之后再改会让已经写过的页停在旧模式下。
    backend.applyPragmas();
    execute(backend.db, SCHEMA_DDL);

    // 建库后立刻落盘：让「库文件存在」与「open 成功」同步。
    // 否则用户看到 domain 打开了，磁盘上却没有文件，会误判成没生效。
    // 必须 force —— 此时还没走过 scheduleFlush，dirty 仍是 false。
    backend.flushNow({ force: true });
    return backend;
  }

  /**
   * 把损坏的库文件挪到旁边，保留证据。
   *
   * 只改名，绝不删除 —— 万一我们的「损坏」判断是错的（比如只是引擎版本
   * 兼容问题），用户的记忆还在那个文件里。改名失败时直接把错误抛出去，
   * 让上层走「后端不可用 → 降级 json」的路径，而不是 silence 掉再覆盖写。
   */
  recoverFromCorrupt(file, cause) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const aside = `${file}.corrupt-${stamp}`;
    renameSync(file, aside);
    this.lastError = `库文件载入失败，已备份为 ${basename(aside)}：${cause?.message ?? cause}`;
  }

  /** kv facet：只构造一次，保持引用稳定 */
  get kv() {
    return this.facet;
  }

  facet = {
    open: async (descriptor) => {
      if (this.closed) {
        throw new this.StorageError("closed", "sqlite backend is closed");
      }
      validateDescriptor(descriptor, this.StorageError);

      const name = descriptor.name;
      if (this.open.has(name) || this.opening.has(name)) {
        throw new this.StorageError(
          "already-open",
          `unit '${name}' is already open; a unit has exactly one live handle`,
        );
      }

      const opening = this.openUnit(descriptor);
      this.opening.set(name, opening);
      try {
        return await opening;
      } finally {
        this.opening.delete(name);
      }
    },
  };

  async openUnit(descriptor) {
    const { name, version } = descriptor;

    // 版本戳校验：库里已存在该 unit 且版本不同 → 拒绝。
    // 注意 per-record 语义下「unit 级版本」仍是硬门禁，逐条版本只在读记录时判。
    const existing = queryOne(this.db, "SELECT version FROM meta WHERE unit = ?", [name]);
    if (existing && existing.version !== version) {
      throw new this.StorageError(
        "version-mismatch",
        `unit '${name}': stored version ${existing.version} != expected ${version}`,
      );
    }

    // 建表。列固定为 (key, ver, body)，不随记录结构变化 —— 记录体对后端是
    // 不透明 JSON，schema 由 domain 层用 zod 负责。
    for (const t of descriptor.tables) {
      execute(this.db, `
        CREATE TABLE IF NOT EXISTS ${tableName(name, t)} (
          key  TEXT PRIMARY KEY,
          ver  INTEGER NOT NULL,
          body TEXT NOT NULL
        )
      `);
    }

    if (!existing) {
      execute(this.db, "INSERT INTO meta (unit, version) VALUES (?, ?)", [name, version]);
    }
    // 建表也算结构变更，必须落盘：否则重启后表不见了，loadAll 会撞
    // 「no such table」。这是最容易漏的一处。
    this.scheduleFlush();

    const unit = new SqliteUnit(descriptor, this, this.StorageError);
    if (this.closed) {
      await unit.close();
      throw new this.StorageError("closed", "sqlite backend is closed");
    }
    this.open.set(name, unit);
    return unit;
  }

  /**
   * 标记待落盘，并在一拍内合并。
   *
   * 为什么用 setTimeout(0) 而不是同步落盘：一个 turn 收尾可能连写十几条
   * （memories + edges + journal + global），逐条 export+write 会重复
   * 序列化整库。合并成一拍只落盘一次。
   *
   * 为什么不 unref 定时器：unref 会让进程在 pending 时直接退出，丢掉
   * 最后一批写入。这个定时器只有 0ms，留着它只会让事件循环多跑一拍。
   */
  scheduleFlush() {
    if (this.closed) return;
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        this.flushNow();
      } catch (e) {
        // 磁盘满/权限问题：保留 dirty，下次写入再试，不抛到事件循环顶层
        this.lastError = e?.message ?? String(e);
      }
    }, 0);
  }

  /**
   * 应用引擎 PRAGMA。
   *
   * 必须在两个时机调用：
   *   1. 载入/建库之后、任何写入之前
   *   2. **每次 db.export() 之后** —— sql.js 的 export 会关掉并重新打开
   *      底层句柄，连接级 PRAGMA 全部打回默认（journal_mode 从 off 变回
   *      delete，synchronous 从 0 变回 2）。只在启动时设一次等于没设，
   *      这是实测踩出来的：写入耗时一直停在 200ms 量级，查 PRAGMA 才发现。
   */
  applyPragmas() {
    if (!this.db) return;
    for (const p of PRAGMAS) {
      try { this.db.run(p); } catch { /* PRAGMA 不致命，退化默认继续 */ }
    }
  }

  /** 立即落盘。幂等；未 dirty 时跳过（除首次建库）。 */
  flushNow({ force = false } = {}) {
    if (this.closed) return;
    if (!this.dirty && !force) return;

    // export() 会释放所有语句并重开句柄，缓存里的 Statement 会变空壳。
    // 顺序不能反：先清缓存再 export，否则清的时候已经在操作失效对象。
    dropStatementCache(this.db);
    const bytes = this.db.export();
    // export 之后 PRAGMA 被重置，必须立刻补回来，否则后续写入退化为
    // 「每个 INSERT 一个带 journal 的事务」。
    this.applyPragmas();
    persistAtomically(this.file, bytes);
    this.dirty = false;
    this.flushes += 1;
    this.fileBytes = bytes.length;
  }

  /** 供测试与工具同步等待落盘 */
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushNow();
  }

  /** 诊断用：已打开的 unit 名 */
  names() {
    return [...this.open.keys()];
  }

  /** 诊断快照：domain 打开日志与 tools 里都会用到 */
  stats() {
    return {
      file: this.file,
      fileBytes: this.fileBytes ?? null,
      dirty: this.dirty,
      flushes: this.flushes,
      units: this.names(),
      lastError: this.lastError,
    };
  }

  /** 关闭后端：先落盘、再 drain、最后关库。幂等。 */
  async close() {
    if (this.closed) return;

    // 移除 beforeExit 监听：不释放会让多个实例累积，且退出时操作已关的库
    if (this.onBeforeExit) {
      try { process.off?.("beforeExit", this.onBeforeExit); } catch { /* ignore */ }
      this.onBeforeExit = null;
    }

    // 顺序不能反：flushNow 里有 `if (this.closed) return`，
    // 先置 closed 就再也不会落盘，最后一批写入直接蒸发。
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.flushNow({ force: true });
    } catch (e) {
      this.lastError = `关闭时落盘失败：${e?.message ?? e}`;
    }

    this.closed = true;
    await Promise.allSettled([...this.opening.values()]);
    for (const unit of [...this.open.values()]) {
      try { await unit.close(); } catch { /* drain 阶段的失败不阻断关闭 */ }
    }
    this.open.clear();
    dropStatementCache(this.db);
    try { this.db.close(); } catch { /* 已关则忽略 */ }
    this.db = null;
  }

  /** 只读导出：把整库字节交出去，供用户备份/用别的工具查。 */
  exportBytes() {
    if (this.closed) throw new this.StorageError("closed", "sqlite backend is closed");
    return this.db.export();
  }
}

/**
 * 以 Cordis 插件形式注册 sqlite 后端。
 *
 * 与 dsh-storage-json 的做法保持一致：
 *   1. ctx.storage.backend.register("sqlite", backend)  —— 让 domain 能按名字路由
 *   2. ctx.provide("storage.backend.sqlite", backend)   —— 让 ctx.inject 的延迟激活能看到
 *
 * 缺第 2 步，storage-domain 的 ctx.inject(backendServices) 永远不会触发，
 * 表现为 ctx.storageDomain 恒为 undefined。
 *
 * 注意是 async：内嵌 wasm 的初始化是异步的（约 100~300ms，单例只付一次）。
 */
export async function registerSqliteBackend(ctx, file) {
  const backend = await SqliteStorageBackend.create(file);

  try {
    ctx.effect(() => {
      const unregister = ctx.storage.backend.register("sqlite", backend);
      return async () => {
        unregister();
        await backend.close();
      };
    }, "memory.sqliteBackend");
  } catch (e) {
    // 注册失败必须把已开的库关掉，否则 bg worker 里的句柄会泄漏
    await backend.close();
    throw e;
  }

  ctx.provide(storageBackendServiceKey("sqlite"), backend);
  return backend;
}

/** 与 dsh-storage 的 storageBackendServiceKey 同构。宿主未导出时也能用。 */
export function storageBackendServiceKey(name) {
  try {
    const fn = hostExport("@deepseek-ai/dsh-storage", "storageBackendServiceKey");
    return fn(name);
  } catch {
    return `storage.backend.${name}`;
  }
}

/**
 * 探测内嵌引擎是否可用。不抛错。
 *
 * 语义已变：检查的是「插件自带的 wasm 能否初始化」，与用户系统里
 * 有没有 sqlite、Node 版本多少完全无关。返回 Promise。
 */
export async function available() {
  try {
    await loadSqlite();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

export { UNIT_NAME_RE, GLOBAL_TABLE, BACKUP_TABLE, SCHEMA_DDL };

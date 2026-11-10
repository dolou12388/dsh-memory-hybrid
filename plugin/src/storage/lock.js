/**
 * 单实例锁：防止两个进程互相覆盖记忆库。
 *
 * ## 为什么必须有
 *
 * 引擎是 sql.js（整库常驻内存），落盘是 `db.export()` 全量字节 + 原子
 * rename。两个 DSH 实例（典型场景：web 常驻 + CLI 临时打开）同时打开
 * 同一个 `memory_hybrid.sqlite` 时：
 *
 *   进程 A 启动 → 载入全库到内存
 *   进程 B 启动 → 也载入同一份快照
 *   A 写入 → 落盘（含 A 的新记录）
 *   B 写入 → 落盘（B 的内存里没有 A 的记录）→ **A 的写入被静默抹掉**
 *
 * 没有任何报错，只是记忆凭空消失。这类问题最难排查，因为它看起来
 * 像"记忆系统时灵时不灵"。
 *
 * ## 为什么是 advisory lock 而不是强制
 *
 * 我们控制不了宿主的启动方式，无法保证每个人都走这个入口。所以锁的作用
 * 是：**能检测到时降级为只读**，而不是"抢不到就崩"。
 *
 * 抢不到锁时有两种策略：
 *   · read-only（默认）：仍能召回，但拒绝写入。宁可这次不记，不要覆盖。
 *   · wait：等锁释放（有超时）。适合 CLI 这类短生命周期进程。
 *
 * 默认 read-only：记忆是旁路设施，第二个实例不该为了记一条而冒丢全部的风险。
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";

/** 锁文件多久没心跳就算失效（进程被 kill -9 时不会自动删锁）。 */
const STALE_MS = 60_000;
/** 心跳间隔。必须显著小于 STALE_MS。 */
const HEARTBEAT_MS = 20_000;

export class InstanceLock {
  /**
   * @param {string} dbFile 记忆库文件路径。锁文件与它同级。
   * @param {object} [opts] { log, staleMs, heartbeatMs }
   */
  constructor(dbFile, opts = {}) {
    this.dbFile = dbFile;
    this.lockFile = `${dbFile}.lock`;
    this.log = opts.log ?? {};
    this.staleMs = opts.staleMs ?? STALE_MS;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.held = false;
    this.timer = null;
    this.conflict = null;
  }

  /**
   * 尝试获取锁。
   *
   * @returns {{ acquired: boolean, holder?: object }} holder 是占用者信息，
   *   供日志与用户提示「谁占着」。
   */
  acquire() {
    try {
      mkdirSync(dirname(this.lockFile), { recursive: true });
    } catch { /* 目录已在则忽略 */ }

    const existing = this.readHolder();
    if (existing && !this.isStale(existing)) {
      this.conflict = existing;
      return { acquired: false, holder: existing };
    }
    if (existing) {
      // 陈旧锁：上一个持有者被强杀。清掉再抢。
      this.log.warn?.(`memory: 清理陈旧的实例锁（pid ${existing.pid}，${Math.round((Date.now() - existing.at) / 1000)}s 无心跳）`);
      try { unlinkSync(this.lockFile); } catch { /* 竞争中被别人删了也无妨 */ }
    }

    try {
      writeFileSync(this.lockFile, JSON.stringify(this.holderInfo()), { mode: 0o600 });
      this.held = true;
      this.startHeartbeat();
      return { acquired: true };
    } catch (e) {
      this.log.warn?.(`memory: 无法创建实例锁 ${this.lockFile}：${e?.message ?? e}`);
      return { acquired: false, holder: null };
    }
  }

  holderInfo() {
    return {
      pid: process.pid,
      host: hostname(),
      at: Date.now(),
      db: this.dbFile,
    };
  }

  readHolder() {
    try {
      if (!existsSync(this.lockFile)) return null;
      const raw = readFileSync(this.lockFile, "utf8");
      const j = JSON.parse(raw);
      if (!j || typeof j.pid !== "number") return null;
      return j;
    } catch {
      // 读不出来或坏 JSON：当作陈旧锁。写入方是原子的，坏内容只可能是
      // 磁盘问题或另一个进程正在写（极窄窗口）。
      try { return { pid: -1, at: statSync(this.lockFile).mtimeMs, host: "?" }; } catch { return null; }
    }
  }

  isStale(holder) {
    if (!holder) return true;
    if (holder.pid === process.pid) return false; // 自己的锁
    if (holder.host === hostname() && !isPidAlive(holder.pid)) return true;
    // 跨机（共享盘）或无法判活时按心跳时间
    return Date.now() - (holder.at ?? 0) > this.staleMs;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      if (!this.held) return;
      try { writeFileSync(this.lockFile, JSON.stringify(this.holderInfo()), { mode: 0o600 }); } catch { /* 心跳失败不影响运行 */ }
    }, this.heartbeatMs);
    // 不要让心跳定时器拖住进程退出
    this.timer.unref?.();
  }

  stopHeartbeat() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 是否持有写权限。 */
  get writable() { return this.held; }

  /** 释放。只删自己写的锁，避免误删别人的。 */
  release() {
    this.stopHeartbeat();
    if (!this.held) return;
    const h = this.readHolder();
    if (h && h.pid === process.pid) {
      try { unlinkSync(this.lockFile); } catch { /* 已被删 */ }
    }
    this.held = false;
  }
}

/** 同机判活。Windows 用 kill(pid,0) 也可用（Node 内部走 OpenProcess）。 */
function isPidAlive(pid) {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 表示进程存在但无权限 —— 仍然算活着
    return e?.code === "EPERM";
  }
}

export { isPidAlive, STALE_MS };

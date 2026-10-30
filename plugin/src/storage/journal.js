/**
 * 写入队列：落盘 + 单 worker 串行消费。
 *
 * 为什么必须异步：agent/turn-stopping 是 serial 终止检查点，官方文档明确
 * 「do not start long work here」。写入链路含模型调用 + Jev + embedding，
 * 长尾可能超过 1.5s，内联会拖慢每一轮收尾。
 *
 * 队列粒度：一个 turn 一个任务。心情判定与记忆抽取同批一次调用，
 * 省一半 token，且保证两件事的时间戳严格对齐。
 */

import { JOB_MAX_ATTEMPTS } from "../core/config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Journal {
  constructor(domain, logger) {
    this.domain = domain;
    this.log = logger;
    this.running = false;
    this.stopped = false;
    this.seq = 0;
  }

  get table() { return this.domain.table("journal"); }

  /** 毫秒级入队，调用方立即返回 */
  async enqueue(payload, meta = {}) {
    this.seq += 1;
    const id = `job_${Date.now().toString(36)}_${this.seq.toString(36)}`;
    await this.table.put(id, {
      id,
      turnId: meta.turnId,
      sessionId: meta.sessionId,
      payload,
      status: "pending",
      attempts: 0,
      enqueuedAt: Date.now(),
    });
    return id;
  }

  pending() {
    const out = [];
    for (const [key, rec] of this.table.entries()) {
      if ((rec?.status ?? "pending") === "pending") out.push(rec);
    }
    out.sort((a, b) => (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0));
    return out;
  }

  async mark(key, patch) {
    await this.table.update(key, (cur) => ({ ...cur, ...patch }));
  }

  async remove(key) {
    try { await this.table.delete(key); return true; } catch { return false; }
  }

  /**
   * 启动消费循环。process 是本模块外的管线函数：
   *   async (payload) => ({ ok: true } | { ok: false, error })
   */
  start(process) {
    if (this.running) return;
    this.running = true;
    void this.loop(process);
  }

  async loop(process) {
    let idle = 0;
    while (!this.stopped) {
      let job;
      try {
        job = this.pending()[0];
      } catch (e) {
        this.log?.warn?.("memory: journal scan failed", e);
        await sleep(2000);
        continue;
      }

      if (!job) {
        idle = Math.min(idle + 1, 12);
        await sleep(Math.min(500 * idle, 5000));
        continue;
      }
      idle = 0;

      const attempts = (job.attempts ?? 0) + 1;
      try {
        await this.mark(job.id, { status: "running", attempts });
        await process(job.payload, job);
        await this.remove(job.id);
      } catch (e) {
        const msg = e?.message ?? String(e);
        this.log?.warn?.(`memory: job ${job.id} failed (${attempts}/${JOB_MAX_ATTEMPTS}): ${msg}`);
        try {
          if (attempts >= JOB_MAX_ATTEMPTS) {
            // 失败三次转 failed 而非无限重试：阻塞队列比丢一条记忆更糟
            await this.mark(job.id, { status: "failed", attempts, error: msg });
          } else {
            await this.mark(job.id, { status: "pending", attempts, error: msg });
            await sleep(300 * attempts);
          }
        } catch { /* 队列自身异常不再传播 */ }
      }
    }
  }

  stop() { this.stopped = true; }

  async drainAsync() {
    this.stop();
    for (let i = 0; i < 40 && this.running; i += 1) await sleep(50);
  }
}

/**
 * domain 声明。
 *
 * ⚠ 硬性约束：storage-domain 的版本机制只做「接受或拒绝」，不做迁移。
 *   - single 布局：整库版本不匹配 → open 直接失败
 *   - per-record 布局：单条版本不在 compatibleVersions → 该条被读作不存在
 * 因此除主键外，所有字段一律 optional；新增字段不得设为 required。
 */

import { hostExport } from "../resolve.js";

// 静态 import 会在 profile 的 link 安装下直接 ERR_MODULE_NOT_FOUND，
// 且失败点早于 apply，整行插件变 never-started。必须走宿主解析。
const defineDomain = hostExport("@deepseek-ai/dsh-storage-domain", "defineDomain");
const domainTable = hostExport("@deepseek-ai/dsh-storage-domain", "domainTable");
const z = hostExport("zod", "z");

const TIERS = ["active", "long", "dormant"];
const KINDS = ["episodic", "semantic", "procedural", "preference"];
const RELS = ["related", "causal", "temporal", "contradicts"];

/** 记忆节点。除 id 外全部 optional。 */
export const memorySchema = z.object({
  id: z.string(),
  text: z.string().optional(),
  kind: z.enum(KINDS).optional(),
  tier: z.enum(TIERS).optional(),
  importance: z.number().min(0).max(1).optional(),
  stability: z.number().min(0).optional(),
  recallCount: z.number().int().min(0).optional(),
  createdAt: z.number().optional(),
  lastRecallAt: z.number().optional(),
  lastDecayAt: z.number().optional(),
  forgotAt: z.number().optional(),
  sourceTurn: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** 写入时刻心情快照。可证伪性埋点：用于事后归因分析。 */
  writeMood: z.object({
    v: z.number().optional(),
    a: z.number().optional(),
    labels: z.array(z.object({
      category: z.string().optional(),
      intensity: z.number().optional(),
    })).optional(),
    theta: z.number().optional(),
  }).optional(),
  recurred: z.number().int().min(0).optional(),
  schemaV: z.number().optional(),
});

/** 关联边。contradicts 刻意保留：新旧冲突不覆盖，建边使演化可被召回。 */
export const edgeSchema = z.object({
  id: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  rel: z.enum(RELS).optional(),
  weight: z.number().min(0).max(1).optional(),
  createdAt: z.number().optional(),
  schemaV: z.number().optional(),
});

/** 写入队列。per-record 布局，逐条消费、可单独丢弃。 */
export const journalSchema = z.object({
  id: z.string(),
  turnId: z.string().optional(),
  sessionId: z.string().optional(),
  payload: z.object({
    userText: z.string().optional(),
    assistantText: z.string().optional(),
  }).optional(),
  status: z.enum(["pending", "running", "done", "failed"]).optional(),
  attempts: z.number().int().min(0).optional(),
  enqueuedAt: z.number().optional(),
  error: z.string().optional(),
});

/** 全局状态：双轴 EMA 与内省计数 */
export const globalSchema = z.object({
  emaV: z.number().optional(),
  emaA: z.number().optional(),
  moodAt: z.number().optional(),
  stats: z.object({
    turnsSeen: z.number().optional(),
    jobsDone: z.number().optional(),
    jobsFailed: z.number().optional(),
    multiLabel: z.number().optional(),
    moodRejected: z.number().optional(),
    moodTotal: z.number().optional(),
    recalled: z.number().optional(),
    promoted: z.number().optional(),
    forgotten: z.number().optional(),
    revived: z.number().optional(),
    jevDegraded: z.number().optional(),
  }).optional(),
  schemaV: z.number().optional(),
});

export const DOMAIN_VERSION = 1;

export const memoryDomain = defineDomain({
  name: "memory_hybrid",
  version: DOMAIN_VERSION,
  // 混合布局：memories/edges 用 single（读多写少、需整体一致），journal 用 per-record。
  // storage-domain 的 layout 是 per-domain 的，因此统一用 per-record：
  // 让单条坏记录只丢一条，且版本检查按记录粒度生效——这对本场景更安全。
  layout: "per-record",
  invalidRecords: "backup-and-skip",
  global: {
    schema: globalSchema,
    initial: {
      emaV: 0,
      emaA: 0,
      moodAt: 0,
      stats: {
        turnsSeen: 0, jobsDone: 0, jobsFailed: 0,
        multiLabel: 0, moodRejected: 0, moodTotal: 0,
        recalled: 0, promoted: 0, forgotten: 0, revived: 0, jevDegraded: 0,
      },
      schemaV: DOMAIN_VERSION,
    },
  },
  tables: {
    memories: domainTable(memorySchema),
    edges: domainTable(edgeSchema),
    journal: domainTable(journalSchema),
  },
});

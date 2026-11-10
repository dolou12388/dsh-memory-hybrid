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
const SOURCES = ["user", "assistant", "tool"];
const SPACES = ["lex", "sem"];

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

  /**
   * 作用域。`global` 表示对人不分项目的约定（如「以后都用中文」），
   * 非 global 时按项目/会话隔离召回。
   *
   * 为什么是 optional 而不是 default("global")：storage-domain 不做迁移，
   * 老记录没有这个字段。读取侧必须自己写 `rec.scope ?? "global"`，
   * 这与 decay.js 里 `stability ?? s` 是同一条纪律 —— 默认值放在读取处，
   * 不放在写入处，否则老数据永远拿不到默认值。
   */
  scope: z.string().optional(),

  /** 内容来源。用户口述与模型总结的可信度不同，界面要能区分。 */
  source: z.enum(SOURCES).optional(),

  /** 威胁扫描命中 warn 级时置位。注入时附风险提示。 */
  tainted: z.boolean().optional(),
  taintReason: z.string().optional(),

  /** 命中的敏感信息类别（值本身已掩码，这里只是类别名）。 */
  secrets: z.array(z.string()).optional(),

  /** 写入时刻心情快照。可证伪性埋点：用于事后归因分析。 */
  writeMood: z.object({
    v: z.number().optional(),
    a: z.number().optional(),
    labels: z.array(z.object({
      category: z.string().optional(),
      intensity: z.number().optional(),
    })).optional(),
    theta: z.number().optional(),
    /** 心情来自内置推断还是外部插件。判据不同，可信度不同。 */
    inferred: z.boolean().optional(),
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
  /** 这条边由哪个向量空间建立。词袋命中与语义命中的可信度不同。 */
  via: z.enum(SPACES).optional(),
  createdAt: z.number().optional(),
  schemaV: z.number().optional(),
});

/** 写入队列。per-record 布局，逐条消费、可单独丢弃。 */
export const journalSchema = z.object({
  id: z.string(),
  turnId: z.string().optional(),
  sessionId: z.string().optional(),
  /** 工作目录派生的作用域。入队时确定，不依赖消费时的工作目录。 */
  scope: z.string().optional(),
  payload: z.object({
    userText: z.string().optional(),
    assistantText: z.string().optional(),
    /**
     * 心情判定。可来自外部心情插件，也可留空由内置推断补。
     *
     * ⚠ 早期这个字段不在 schema 里，而消费端一直在读它 —— 于是
     * "有没有 mood" 取决于入队方是否越界写入了未声明字段，
     * 实际上永远是 undefined。声明出来是为了让契约显式。
     */
    mood: z.object({
      confidence: z.number().optional(),
      labels: z.array(z.object({
        category: z.string().optional(),
        intensity: z.number().optional(),
      })).optional(),
    }).optional(),
  }).optional(),
  status: z.enum(["pending", "running", "done", "failed"]).optional(),
  attempts: z.number().int().min(0).optional(),
  enqueuedAt: z.number().optional(),
  error: z.string().optional(),
});

/**
 * 语义向量持久化。
 *
 * 为什么单独一张表而不是塞进 memories：向量是 1024～1536 个 float，
 * 一条就是 4～6KB JSON。塞进 memories 会让每次读记忆都反序列化它，
 * 而绝大多数读取（列表、统计、衰减扫描）根本不需要向量。
 *
 * 分开后：写入侧写一次，启动时一次性加载，之后只在内存里用。
 */
export const semvecSchema = z.object({
  id: z.string(),
  vec: z.array(z.number()).optional(),
  dim: z.number().optional(),
  schemaV: z.number().optional(),
});

/** 全局状态：双轴 EMA 与内省计数 */
export const globalSchema = z.object({
  emaV: z.number().optional(),
  emaA: z.number().optional(),
  moodAt: z.number().optional(),
  /** 用户显式设置的默认作用域。空则按工作目录派生。 */
  defaultScope: z.string().optional(),
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
    /** 被安全扫描拒绝写入的条数。 */
    blocked: z.number().optional(),
    /** dormant 超 TTL 被物理清除的条数。 */
    purged: z.number().optional(),
    /** 孤儿边清理数。 */
    edgesPruned: z.number().optional(),
    /** 超容量淘汰数。 */
    evicted: z.number().optional(),
    /** 用户批量清除的条数。 */
    cleared: z.number().optional(),
    /** 过期 failed journal 清理数。 */
    jobsFailedPruned: z.number().optional(),
  }).optional(),
  schemaV: z.number().optional(),
});

export const DOMAIN_VERSION = 2;

/**
 * 版本兼容表。
 *
 * DOMAIN_VERSION 从 1 升到 2 的原因是新增了 semvec 表且 memories 多了
 * scope/tainted/source 等字段。per-record 布局下 version 是 unit 级硬门禁：
 * 库里存的 1 与期望的 2 不等会直接拒绝打开 —— 那等于用户升级后记忆全丢。
 *
 * 因此显式声明 1 兼容：v1 记录缺的字段全是 optional，读取侧都已写好默认值。
 * semvec 表是新增的，老库没有它，`CREATE TABLE IF NOT EXISTS` 会补上，
 * 语义向量从空开始（表现为升级后语义召回率逐步回升），数据零丢失。
 */
export const DOMAIN_COMPATIBLE_VERSIONS = [1];

export const memoryDomain = defineDomain({
  name: "memory_hybrid",
  version: DOMAIN_VERSION,
  compatibleVersions: DOMAIN_COMPATIBLE_VERSIONS,
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
        blocked: 0, purged: 0, edgesPruned: 0, evicted: 0, cleared: 0, jobsFailedPruned: 0,
      },
      schemaV: DOMAIN_VERSION,
    },
  },
  tables: {
    memories: domainTable(memorySchema),
    edges: domainTable(edgeSchema),
    journal: domainTable(journalSchema),
    semvec: domainTable(semvecSchema),
  },
});

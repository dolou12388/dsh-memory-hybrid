/**
 * dsh-memory-hybrid — 混合架构大模型记忆。
 *
 * 三个平面：
 *   · 存储面：ctx.storageDomain 的 KV domain（memories / edges / journal + global）
 *   · 检索面：进程内向量索引（可随时由 KV 重建），向量 + 词法 + 图扩展三路
 *   · 呈现面：systemPrompt.context() 注入召回，tools 暴露主动管理接口
 *
 * 关键时序约束：
 *   · agent/turn-stopping 是 serial 收尾点，官方明确禁止在此做长任务
 *     → 这里只入队（毫秒级），真正的抽取/判定/落盘在 Journal worker 里跑
 *   · 记忆系统是旁路设施，任何自身异常都只能降级，不能影响对话
 */

import { hostExport, hostRequire } from "./resolve.js";
import {
  RECALL_TOP_K, SCORE_QUANTUM, DAY_MS, JOB_MAX_ATTEMPTS,
} from "./core/config.js";
import { memoryDomain, DOMAIN_VERSION } from "./storage/domain.js";
import { registerSqliteBackend } from "./storage/backend-sqlite.js";
import { VectorIndex } from "./storage/vector.js";
import { Journal } from "./storage/journal.js";
import { runJob, recall, touchRecalled, sweep, bumpStats } from "./pipeline/pipeline.js";
import { buildTools } from "./tools/memory.js";
import { effectiveEma, gainFactor } from "./mood/model.js";
import { Embedder, probeEmbedding } from "./storage/embed-client.js";
import { resolveEmbedConfig, describeEmbedConfig } from "./storage/embed-config.js";
import { embed as bagOfWordsEmbed } from "./storage/vector.js";

// schemastery 的 CJS 导出本身就是 z（既可直接调用，也带 .object/.string），
// 没有 default 包装。取模块本体，不要再找 .default。
const z = hostRequire("@deepseek-ai/schemastery");

/** Cordis 插件名 */
export const name = "dsh-memory-hybrid";

/**
 * 依赖声明。
 *
 * ⚠ 这里有两个反直觉之处，都是实测踩出来的。
 *
 * 1. `storage` 必须声明，即使只是「可能用不到」。
 *    Cordis 对 ctx 属性访问做 inject 保护：未在 inject 里声明的服务，
 *    读 `ctx.storage` 会抛 "cannot get property ... without inject"。
 *    所以只要代码里出现 ctx.storage（哪怕在 try 里），就必须声明。
 *
 * 2. `storageDomain` 必须声明，但不能当作「必须就绪」来用。
 *    Cordis 的 inject 是「属性访问许可」，不是「跳过启动的开关」：
 *    声明后 apply 才会在服务就绪时被调用；但服务可能因自身依赖未满足
 *    而永远不就绪，此时插件就静默 pending。
 *
 *    实测遇到的具体死结：storage-domain 用
 *    `ctx.inject([...backendNames])` 延迟挂载，backendNames 在它自身
 *    apply 时就固定了（来自 profile 的 backend/routes）。本插件注册
 *    sqlite 必然晚于它，于是「profile backend=json + 我要 sqlite」这个
 *    组合下，profile 的 facility 永远不会就绪。
 *
 *    两难：
 *      · 声明 storageDomain → 插件进不了 apply，没机会自建 facility
 *      · 不声明           → 读 ctx.storageDomain 直接抛 without inject
 *
 *    解法：声明它（拿到访问许可），但用「不依赖它」的方式写逻辑 ——
 *    自建 facility 只需要 ctx.storage，不需要 ctx.storageDomain。
 *    即声明是为了能安全探测，而不是为了等它。
 */
export const inject = ["storage", "storageDomain", "systemPrompt", "tools"];

/** 配置 */
export const Config = z.object({
  /**
   * 每个字段都必须 `.volatile()`，否则设置页拿不到它。
   *
   * 宿主的 `dsh-settings.describe()` 先用 `volatileForm(schema)` 过滤 schema：
   * 只保留标了 `meta.volatile` 的字段，一个都没标时返回 `undefined`，该条目
   * 被**整条跳过**。跳过之后 `configForms.get(ns)` 永远是 `unavailable`，
   * 前端 `whileServed` 不会触发，tab 根本不出现 —— 而这不会报任何错。
   *
   * 反过来，`.volatile()` 的语义正是我们要的：配置改变时**不重挂插件**，
   * 由插件自己响应（本插件的 embedder 每次解析都重读 config，天然满足）。
   *
   * 未标记的字段仍会作为普通配置存在，只是不出现在设置页里。
   */

  /** 是否启用自动召回注入。关掉后模型只能靠 memory_recall 工具主动翻。 */
  autoRecall: z.boolean().default(true).volatile(),
  /** 每次注入的最大条数 */
  recallLimit: z.number().default(RECALL_TOP_K).volatile(),
  /** 向量维度。改这个会让已有索引失效（索引可重建，数据不受影响） */
  dim: z.number().default(256).volatile(),
  /** 召回注入的 prompt context 排序 */
  contextOrder: z.number().default(10500).volatile(),
  /** Jev 判别端点。留空则只用规则判定（P1 行为） */
  jevEndpoint: z.string().default("").volatile(),
  /**
   * Jev 判别凭据。同样刻意不给 `default("")`，理由见 embedApiKey。
   */
  jevApiKey: z.string().role("secret").volatile(),
  jevModel: z.string().default("jev-1.14.0").volatile(),

  // ---- 嵌入模型（语义召回）----
  //
  // 语义召回需要一个 embedding 端点：它把文本映射成向量，让「那家店」这类
  // 与「望京小腰」字面无重叠的表述仍能被算作相近。宿主 dsh-llm 只提供
  // 生成接口、没有 embedding，因此这里单独配置。
  //
  // 默认 inherit：不填任何东西，直接沿用当前 dsh 客户端正在用的
  // baseURL / apiKey / model。用户装完即可用，不必重复填一遍已有配置。
  //
  // 注意 embedding 与生成是**两种不同的模型**。继承来的生成模型（如
  // deepseek-v4-1-flash）通常不提供 /embeddings，此时探测会报
  // unsupported，界面会提示改用 custom 填一个真正的嵌入模型。

  /** 嵌入来源：inherit 沿用 dsh 客户端配置；custom 用下面三项；off 关闭语义召回 */
  embedSource: z.union(["inherit", "custom", "off"]).default("inherit").volatile(),

  /** 自定义嵌入端点，形如 https://api.example.com/v1（不要带 /embeddings） */
  embedBaseURL: z.string().default("").volatile(),

  /**
   * 自定义嵌入密钥。
   *
   * ⚠ 刻意**不给 default("")**。宿主的 `describe()` 用
   * `value !== undefined` 判断「配过没有」，一旦有默认空串，"没配过" 就
   * 永远报成"配过"，设置页会一直显示「已配置」。实测：
   *
   *     有 default("")  → 没填也 set=true
   *     无 default      → 没填 set=false，填了 set=true   ✓
   *
   * 代价是读配置时要自己兜 undefined，见 `embedApiKeyOf()`。
   */
  embedApiKey: z.string().role("secret").volatile(),

  /** 自定义嵌入模型 id，形如 bge-m3 / text-embedding-3-small */
  embedModel: z.string().default("").volatile(),
  /** 启动时是否立即跑一次结算扫描 */
  sweepOnStart: z.boolean().default(true).volatile(),
  /** 日志级别：silent | debug */
  verbose: z.boolean().default(false).volatile(),

  /**
   * 存储后端：auto | sqlite | json
   *
   *   auto   —— 优先用自带 sqlite（内嵌 wasm 引擎），失败时退回 profile 路由
   *   sqlite —— 强制用自带 sqlite，不可用则拒绝启动（fail loud，不静默降级）
   *   json   —— 不注册 sqlite，完全沿用 profile 的 storage-domain 路由
   *
   * 引擎随包分发，因此不存在「用户机器没装 sqlite」这种降级理由；
   * auto 的降级分支只用于包文件损坏或磁盘不可写这类环境故障。
   *
   * 注意 select 之后还有一层：即便选了 sqlite，若 profile 把本 domain
   * 路由到了别的后端，插件会自建一个 facility 以 sqlite 打开，而不去改
   * profile 的全局配置 —— 那是用户的层，插件不该越权。
   *
   * 这一项与 sqliteFile 在语义上要等插件重挂才真正切换后端，但这里仍标
   * `volatile()`：`isVolatilePath` 会拒绝未标字段的写入，不标就变成「界面
   * 上能填、一保存就被拒」。宿主 `describe()` 又把 `applies` 一律报成
   * `live`，所以标注与否不影响宿主行为 —— 差别只在能否写入。取「能写 +
   * 界面注明需重启」，好过留一个填了没用的输入框。
   */
  storageMode: z.union(["auto", "sqlite", "json"]).default("auto").volatile(),

  /** sqlite 库文件。留空则放在 <storages>/memory_hybrid.sqlite（改动需重启） */
  sqliteFile: z.string().default("").volatile(),
});

/**
 * 把 Config 里的 volatile 包装拆成普通值。
 *
 * ## 为什么需要这一步
 *
 * 标了 `.volatile()` 的字段在解析后的 config 里**不是原始值**，而是一个
 * `{ get() }` 包装对象 —— schemastery 用它在不重挂插件的前提下传递新值。
 * 于是 `config.contextOrder` 拿到的是对象，`Number.isFinite()` 直接判假，
 * systemPrompt 会抛 `order must be a finite number`。
 *
 * 宿主的 `dsh-settings` 里有个同名的 `plainConfig()` 干的就是这件事，
 * 但它没导出、也不该跨包引用，所以这里自己写一份。
 *
 * ## 为什么在 apply 开头一次性解开
 *
 * volatile 的语义是「值会变」。本插件采取的策略是**每次读配置都重新解包**，
 * 而不是缓存成普通对象 —— 设置页保存后宿主会推送新值，只有重新解包才
 * 读得到。所以这里返回的是一个带 getter 的浅层对象，而不是快照。
 *
 * @param {object} raw schemastery 校验后的 config
 * @returns {object} 每个字段都返回当前真实值的对象
 */
function plainConfig(raw) {
  if (raw === null || typeof raw !== "object") return raw;
  const out = {};
  for (const key of Object.keys(raw)) {
    // 用一个 getter 而不是现在取值：配置可能在运行中被设置页改掉，
    // 每次读都走一遍解包才能拿到最新值。
    Object.defineProperty(out, key, {
      enumerable: true,
      get() {
        const value = raw[key];
        // 判据是「只有一个 get 方法、别无自有键」——这是 schemastery 的
        // Volatile 包装的确切形状（实测：Object.keys(v) === ["get"]，
        // 且包装上并没有 volatile 标记）。不按 `instanceof` 判是因为
        // 包装是普通对象，没有可用的类身份。
        if (isVolatileValue(value)) return value.get();
        return value;
      },
    });
  }
  return out;
}

/** 是否是 schemastery 的 Volatile 包装（形如 `{ get }` 的单键对象）。 */
function isVolatileValue(value) {
  if (value === null || typeof value !== "object") return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "get" && typeof value.get === "function";
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {object} config 已验证的配置（含 volatile 包装）
 */
export async function apply(ctx, rawConfig) {
  const config = plainConfig(rawConfig);

  const log = {
    debug: config.verbose ? (...a) => ctx.logger?.debug?.(...a) : () => {},
    info: (...a) => ctx.logger?.info?.(...a),
    warn: (...a) => ctx.logger?.warn?.(...a),
  };

  // ---- 存储后端选择 ----
  // 注意是 await：sqlite 后端要等内嵌 wasm 初始化（单例，只付一次）。
  const storage = await resolveStorage(ctx, config, log);

  // ---- 打开 domain ----
  // 版本不匹配时 storage-domain 只拒绝不迁移：per-record 布局下坏记录被
  // 备份跳过，整库仍可用。这是选 per-record 而非 single 的主因。
  let domain;
  try {
    domain = await openMemoryDomain(ctx, storage, log);
  } catch (e) {
    log.warn("memory: domain open failed, feature disabled", e?.code ?? e?.message);
    return;
  }
  ctx.effect(() => () => domain.close(), "memory.domainClose");

  // 显式自证：确认 domain 真的开出来了，而不是靠「后续步骤没报错」反推。
  // 生产环境走 info 级别，便于用户排查存储路径。
  log.info(
    `memory: domain opened name=${domain?.name ?? "?"} via=${storage.effective} ` +
    `memories=${domain.table("memories").size} ` +
    `edges=${domain.table("edges").size} ` +
    `journal=${domain.table("journal").size}`,
  );

  // ---- 依赖容器 ----
  //
  // embedder 负责"把文本变成语义向量"。它拿不到配置时不抛错，而是退回
  // 词袋哈希 —— 记忆是旁路设施，嵌入不可用只应降低关联质量，不该让
  // 写入链路失败。解析函数每次调用都重读配置，用户在设置页改完即生效。
  const embedder = new Embedder({
    resolve: () => {
      const r = resolveEmbedConfig(config, ctx);
      if (!r.url || !r.apiKey || !r.model) return null;
      return { url: r.url, apiKey: r.apiKey, model: r.model };
    },
    fallback: bagOfWordsEmbed,
    log,
  });
  embedder.probe = async () => {
    const r = resolveEmbedConfig(config, ctx);
    if (!r.url) return { ok: false, reason: r.reason || "未配置嵌入端点" };
    return probeEmbedding({ baseURL: r.baseURL, apiKey: r.apiKey, model: r.model });
  };

  const deps = {
    domain,
    index: new VectorIndex(config.dim),
    dim: config.dim,
    log,
    config,
    ctx,
    embedder,
    currentTurnId: undefined,
  };

  // ---- 由 KV 重建索引 ----
  const rows = [...domain.table("memories").entries()].map(([, r]) => r);
  const indexed = deps.index.rebuild(rows);
  log.info(`memory: restored ${rows.length} memories, indexed ${indexed}`);

  // ---- 启动结算 ----
  if (config.sweepOnStart) {
    try { await sweep(deps, 5000); } catch (e) { log.warn("memory: initial sweep failed", e); }
  }

  // ---- 写入队列 ----
  const journal = new Journal(domain, log);
  journal.start(async (payload, job) => {
    deps.currentTurnId = job?.turnId;
    return runJob(deps, payload, job);
  });
  ctx.effect(() => () => { journal.stop(); }, "memory.journalStop");

  // ---- 捕获 turn：只入队，不做事 ----
  // session/event 是 post-commit fire-and-forget，正好用于旁路采集。
  //
  // 注意事件体结构（已核对 types.d.ts）：
  //   turn/start        → { turn }
  //   user/message      → UserMessage 本身，**不带 turn 字段**
  //   assistant/message → { turn, step, message, ... }
  // 因此 user/message 只能归到「最近打开的那个 turn」，用 activeTurn 记。
  const turnBuf = new Map(); // turn -> { user?, assistant? }
  let activeTurn = 0;

  ctx.on("session/event", (session, event) => {
    try {
      const type = event?.type;

      if (type === "turn/start") {
        activeTurn = event.turn;
        turnBuf.set(event.turn, {});
        return;
      }

      if (type === "user/message") {
        const buf = turnBuf.get(activeTurn) ?? {};
        const text = textOf(event);
        if (text) buf.user = buf.user ? `${buf.user}\n${text}` : text;
        turnBuf.set(activeTurn, buf);
        return;
      }

      if (type === "assistant/message") {
        const buf = turnBuf.get(event.turn) ?? {};
        const text = textOf(event.message);
        if (text) buf.assistant = text;
        turnBuf.set(event.turn, buf);
        return;
      }

      if (type === "turn/end") {
        const buf = turnBuf.get(event.turn) ?? {};
        turnBuf.delete(event.turn);
        // 修剪：长会话里 turn 号单调涨，缓存必须有界
        if (turnBuf.size > 32) {
          let oldest = Infinity;
          for (const k of turnBuf.keys()) if (k < oldest) oldest = k;
          if (Number.isFinite(oldest)) turnBuf.delete(oldest);
        }
        if (!buf.user) return;
        void journal
          .enqueue({ userText: buf.user, assistantText: buf.assistant }, {
            turnId: `${session?.id ?? "s"}:${event.turn}`,
            sessionId: session?.id,
          })
          .then(() => bumpStats(domain, { turnsSeen: 1 }))
          .catch((e) => log.warn("memory: enqueue failed", e?.message));
      }
    } catch (e) {
      // 采集失败绝不影响对话
      log.warn("memory: session event handler failed", e?.message);
    }
  });

  // ---- 捕获本轮用户输入，供召回查询 ----
  // AssembleContext 只有 { scope, signal }，拿不到消息；
  // 唯一可靠的来源是 agent/pre-step 的 payload.messages。
  let currentQuery = "";

  ctx.on("agent/pre-step", (payload, next) => {
    try {
      const msgs = payload?.messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          const t = textOf(msgs[i]);
          if (t) { currentQuery = t; break; }
        }
      }
    } catch { /* 捕获失败不影响 step */ }
    return next();
  });

  // ---- 自动召回注入 ----
  if (config.autoRecall) {
    let lastInjected = "";

    ctx.effect(() => ctx.systemPrompt.context({
      name: "memory:recall",
      order: config.contextOrder,
      // provider 拿到的 AssembleContext 只有 { scope, signal }，
      // 查询词由 agent/pre-step 提前存入 currentQuery。
      text: () => {
        try {
          const query = currentQuery;
          if (!query) return "";
          const hits = recall({ ...deps, dim: config.dim }, query, { limit: config.recallLimit });
          if (hits.length === 0) return "";

          // 量化后再比对：投喂上下文的快照只在内容变化时记录，
          // 每轮微小的分数抖动会撑爆上下文长度
          const sig = hits.map((h) => `${h.id}:${Math.round(h.score / SCORE_QUANTUM)}`).join("|");
          if (sig === lastInjected) return "";
          lastInjected = sig;

          const lines = hits.map((h) => `- [${h.tier}] ${h.text}`);
          return [
            "## 长期记忆（自动召回）",
            "以下条目来自过往会话，属于你已有的记忆，不是用户本轮说的话。",
            "需要更多可调用 memory_recall；需要留存新事实可调用 memory_remember。",
            "",
            ...lines,
          ].join("\n");
        } catch (e) {
          log.warn("memory: recall injection failed", e?.message);
          return "";
        }
      },
    }), "memory.recallContext");
  }

  // ---- 工具 ----
  for (const tool of buildTools({ ...deps, dim: config.dim })) {
    ctx.effect(() => ctx.tools.register(tool), `memory.tool.${tool.name}`);
  }

  // ---- 收尾：召回命中后异步加深 ----
  // turn-stopping 是 serial 收尾点，这里只做微秒级的入队/统计，
  // 真正的 grow 在 worker 里跑（见 runJob 的 recur 分支）
  ctx.on("agent/turn-stopping", () => {
    // 有意留空：此处不做任何可能阻塞的事。
    // 保留这个订阅点是为了将来接入「轮末主动巩固」，现在不承担工作。
  });

  log.info(`memory: ready (dim=${config.dim}, autoRecall=${config.autoRecall})`);

  // ---- 嵌入配置自检 ----
  // 只在启动时报告一次"现在用的是哪套配置"，不做网络探测（那会拖慢启动，
  // 且离线环境下必然超时）。用户要验证连通性可调
  // memory_manage(action=embed_status, probe=true)。
  try {
    const info = describeEmbedConfig(config, ctx);
    if (info.ready) {
      log.info(`memory: embed ${info.mode} → ${info.model} @ ${info.baseURL}`);
    } else {
      log.warn(`memory: embed 未就绪（${info.mode}）—— ${info.note || "将退回词袋哈希，语义关联能力受限"}。` +
        `可在设置页配置嵌入模型，或调用 memory_manage(action="embed_status") 查看详情。`);
    }
  } catch (e) {
    log.warn("memory: embed 自检失败", e?.message);
  }
}

/** 从 message 取纯文本。传入的可以是 message 本身，也可以是带 .message 的事件体。 */
function textOf(message) {
  const m = message?.message ?? message;
  const blocks = m?.content;
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n").trim();
}

/**
 * 决定本次用哪个存储后端。
 *
 * 返回 { mode, effective, backend }：
 *   mode      —— 配置的原始意图（auto/sqlite/json）
 *   effective —— 实际可用的后端名（sqlite/json），写日志用
 *   backend   —— 已注册的 sqlite 后端实例；未注册则为 null
 *
 * 降级策略分两档：
 *   auto   静默降级，只 warn —— 内嵌引擎理论上必可用，失败只可能是
 *          包文件被裁掉或磁盘不可写，此时退回 profile 路由比拒绝启动好
 *   sqlite fail loud —— 用户显式要求 sqlite 却不可用，静默退回 json 会
 *          让「我明明配了 sqlite」变成难查的悬案，所以直接抛
 */
async function resolveStorage(ctx, config, log) {
  const mode = config.storageMode ?? "auto";

  if (mode === "json") {
    log.info("memory: storage backend = json (profile 路由)");
    return { mode, effective: "json", backend: null };
  }

  if (typeof ctx.storage?.backend?.register !== "function") {
    if (mode === "sqlite") {
      throw new Error("memory: storageMode=sqlite 但 ctx.storage 不可用，无法注册后端");
    }
    log.warn("memory: ctx.storage 不可用，退回 profile 路由");
    return { mode, effective: "json", backend: null };
  }

  let backend;
  let file = null;
  try {
    file = resolveSqliteFile(config, ctx);
    backend = await registerSqliteBackend(ctx, file);
    const st = backend.stats();
    log.info(`memory: storage backend = sqlite (${file}, ${st.fileBytes ?? 0} bytes)`);
    if (st.lastError) log.warn(`memory: sqlite 载入告警：${st.lastError}`);
  } catch (e) {
    if (mode === "sqlite") throw e;
    log.warn(`memory: sqlite 后端不可用，退回 profile 路由（${e?.code ?? e?.message}）`);
    return { mode, effective: "json", backend: null };
  }

  return { mode, effective: "sqlite", backend, file };
}

/** 推导 sqlite 库文件路径。默认落在 dsh 的 storages 目录下。 */
function resolveSqliteFile(config, ctx) {
  if (config.sqliteFile) return config.sqliteFile;
  try {
    const { dshHomePath } = hostRequire("@deepseek-ai/dsh-home-paths");
    return dshHomePath("storages", "memory_hybrid.sqlite");
  } catch {
    // home-paths 拿不到时退回 ctx 上的路径信息，最后兜底 cwd
    const base = ctx?.baseDir ?? ctx?.cwd ?? process.cwd();
    return hostRequire("node:path").join(base, "memory_hybrid.sqlite");
  }
}

/**
 * 打开 memory domain。
 *
 * 这里要处理一个实际的装配问题：profile 的 storage-domain 只认一个
 * 全局 backend 加若干 routes，而 routes 属于「用户的层」。插件若去改写
 * profile 配置，就是把用户的意图覆盖掉，install 一次之后再卸载会留下脏配置。
 *
 * 做法：
 *   · 若 profile 已把本 domain 路由到 sqlite（或全局 backend 就是 sqlite），
 *     直接用 ctx.storageDomain.open() —— 常规路径，零特殊处理。
 *   · 否则自建一个 DomainFacility，把它路由到 sqlite。
 *     DomainFacility 是公开导出的，构造只需 (ctx, config)，可以并存：
 *     它有自己的 domains/reserved 表，与 profile 的那个实例互不干扰，
 *     而底层 backend 是同一个，所以数据是同一份。
 */
async function openMemoryDomain(ctx, storage, log) {
  // 读 ctx.storageDomain 可能抛错（inject 保护 / inactive context），
  // 所以统一包一层探测，把「拿不到」当成「未就绪」而不是异常。
  const facilityOf = () => {
    try {
      const f = ctx.storageDomain;
      return typeof f?.open === "function" ? f : null;
    } catch {
      return null;
    }
  };

  // 常规路径：profile 的 facility 可用，且它路由到的正是我们要用的后端。
  const facility = facilityOf();
  if (facility) {
    const routeOfFacility =
      facility.config?.routes?.[memoryDomain.name] ?? facility.config?.backend;

    if (storage.effective !== "sqlite" || routeOfFacility === "sqlite") {
      return facility.open(memoryDomain);
    }
    log.info(`memory: profile facility 路由到 ${routeOfFacility}，改走自建 facility`);
  } else if (storage.effective !== "sqlite") {
    // json 模式且 facility 未就绪：等一拍再试（装配顺序问题）
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const f = facilityOf();
      if (f) return f.open(memoryDomain);
    }
    throw new Error("memory: storageDomain 始终未就绪（json 模式依赖 profile 的 facility）");
  }

  // 自建 facility：profile 未路由到 sqlite，而我们要用 sqlite。
  // DomainFacility 是公开导出的，构造只需 (ctx, config)，可与 profile 那个
  // 实例并存 —— 它有自己的 domains/reserved 表，底层 backend 是同一个，
  // 因此数据仍是同一份。
  const DomainFacility = hostExport("@deepseek-ai/dsh-storage-domain", "DomainFacility");
  const own = new DomainFacility(ctx, {
    backend: "sqlite",
    routes: { [memoryDomain.name]: "sqlite" },
  });
  log.info("memory: 自建 domain facility（profile 未路由到 sqlite）");
  return own.open(memoryDomain);
}

export { memoryDomain, DOMAIN_VERSION };

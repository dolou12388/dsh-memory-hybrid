/**
 * 模型可见工具：记忆检索、记忆写入、记忆管理、状态内省。
 *
 * 设计取舍：工具数量刻意克制。工具越多，模型越容易在无必要时调用，
 * 反而把上下文塞满。检索默认自动注入（systemPrompt.context），
 * 这里的 recall 工具只用于「主动翻找」的场景。
 */

import { hostExport } from "../resolve.js";
import { RECALL_TOP_K, LEVELS, LEVEL_ORDER, levelOfImportance } from "../core/config.js";
import {
  recall, touchRecalled, sweep, bumpStats, clearMemories,
  pruneOrphanEdges, pruneJournal, upsertByTool,
} from "../pipeline/pipeline.js";
import { describeEmbedConfig } from "../storage/embed-config.js";
import { MOOD_INFERENCE_NOTE } from "../mood/probe.js";

/**
 * 把嵌入配置摘要渲染成人能读的几行。
 *
 * @param {object} info describeEmbedConfig 的返回
 * @param {object|null} probe 探测结果；null 表示没探测
 * @param {object} [index] 向量索引，用于报告语义覆盖率
 */
function formatEmbedStatus(info, probe, index) {
  const lines = [
    `嵌入来源：${info.mode}  (${info.origin})`,
    `API 地址：${info.baseURL}`,
    `模型 id ：${info.model}`,
    `API Key ：${info.apiKey}`,
    `配置    ：${info.ready ? "完整" : "不完整"}`,
  ];
  if (info.note) lines.push(`说明    ：${info.note}`);

  // 关键：区分「配置完整」与「真的在用」。
  // 历史版本只报配置，用户以为语义召回在工作，实际走的仍是词袋哈希。
  if (index) {
    const total = index.size;
    const withSem = index.semanticCount;
    lines.push("");
    lines.push(`索引    ：${total} 条，其中 ${withSem} 条带语义向量（${total ? Math.round((withSem / total) * 100) : 0}%）`);
    if (total > 0 && withSem === 0) {
      lines.push("         语义空间为空 —— 召回目前只用字面匹配。");
      lines.push("         新写入会自动补齐；存量条目可用 memory_manage(action=\"reembed\") 一次性重算。");
    }
  }

  if (probe) {
    lines.push("");
    if (probe.ok) {
      lines.push(`探测    ：✓ 可用，向量维度 ${probe.dim}`);
    } else {
      lines.push(`探测    ：✗ ${probe.reason}`);
      if (probe.status === 404) {
        lines.push("         该地址没有 /embeddings 接口。");
        lines.push("         继承来的多是生成模型，要做语义召回需另填嵌入模型（embedSource=custom）。");
      }
    }
  } else if (info.ready) {
    lines.push("");
    lines.push("（加 probe:true 可实际调用一次端点验证）");
  }

  if (info.mode === "inherit" && info.inherited) {
    lines.push("");
    lines.push(`继承自：${info.inherited.provider}/${info.inherited.model}，密钥引用 ${info.inherited.apiKeyEnv}`);
  }
  return lines.join("\n");
}

const defineTool = hostExport("@deepseek-ai/dsh-tools", "defineTool");

/** 构造工具集。deps 里需要 domain / index / dim / log / config。 */
export function buildTools(deps) {
  const memoryRecall = defineTool({
    name: "memory_recall",
    description:
      "Search long-term memory for what you know about a topic. " +
      "Returns ranked memories with their tier (active/long/dormant) and score. " +
      "Use when the user references something from an earlier session that is not in the current context.",
    parameters: {
      query: {
        type: "string",
        description: "What to look for. Natural language or keywords.",
        required: true,
      },
      limit: {
        type: "integer",
        description: `Maximum results (default ${RECALL_TOP_K}).`,
      },
      includeDormant: {
        type: "boolean",
        description: "Include forgotten memories reached through association. Default true.",
      },
      scope: {
        type: "string",
        description: "Restrict to one project scope. Omit to search the current session's scope.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "integer" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                tier: { type: "string" },
                kind: { type: "string" },
                score: { type: "number" },
                via: { type: "string" },
                scope: { type: "string" },
                tainted: { type: "boolean" },
              },
            },
          },
          revived: { type: "integer" },
        },
      },
      render(args, value) {
        if (value.count === 0) {
          return [{ type: "text", text: `No memory matched "${args.query}".` }];
        }
        const lines = value.items.map(
          (m, i) => `${i + 1}. [${m.tier}/${m.kind ?? "?"}] ${m.text}`
            + `  (score ${m.score.toFixed(2)}, via ${m.via}, scope ${m.scope})`
            + (m.tainted ? "  ⚠ 内容含可疑片段" : ""),
        );
        const head = `Found ${value.count} memory item(s)${value.revived ? `, ${value.revived} revived from dormant` : ""}:`;
        return [{ type: "text", text: [head, ...lines].join("\n") }];
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(args.limit ?? RECALL_TOP_K, 1), 50);
      const scope = args.scope ?? deps.defaultScope ?? null;
      const hits = recall(deps, args.query, { limit, scope });
      const filtered = args.includeDormant === false
        ? hits.filter((h) => h.tier !== "dormant")
        : hits;
      const touched = await touchRecalled(deps, filtered);
      return {
        count: filtered.length,
        items: filtered.map((h) => ({
          id: h.id,
          text: h.text,
          tier: h.tier,
          kind: h.kind ?? "episodic",
          score: Number(h.score.toFixed(3)),
          via: h.via,
          scope: h.scope,
          tainted: Boolean(h.tainted),
        })),
        revived: touched.revived,
      };
    },
  });

  const memoryRemember = defineTool({
    name: "memory_remember",
    description:
      "Explicitly store something the user asked you to remember. " +
      "Only use when the user says to remember something, or states a durable rule or preference. " +
      "Do not store ordinary conversation — it is captured automatically.",
    parameters: {
      text: {
        type: "string",
        description: "The fact, rule, or preference to store, in one self-contained sentence.",
        required: true,
      },
      level: {
        type: "string",
        enum: ["trivial", "normal", "important", "critical"],
        description:
          "How long it should be kept. trivial≈1.5d, normal≈9d, important≈42d, critical≈180d without recall. " +
          "Default important.",
      },
      kind: {
        type: "string",
        enum: ["episodic", "semantic", "procedural", "preference"],
        description: "Memory type. Default semantic.",
      },
      scope: {
        type: "string",
        description:
          "Project scope. Omit to use the current session's scope. " +
          "Use \"global\" for preferences that apply to every project.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          tier: { type: "string" },
          level: { type: "string" },
          survivalDays: { type: "number" },
          action: { type: "string" },
        },
      },
      render(_args, v) {
        const verb = v.action === "recur" ? "Updated existing memory" : "Stored";
        return [{
          type: "text",
          text: `${verb} as ${v.level} (${v.tier} tier), survives ~${v.survivalDays} days without recall. id=${v.id}`,
        }];
      },
    },
    async execute(args) {
      const level = LEVEL_ORDER.includes(args.level) ? args.level : "important";
      const kind = args.kind ?? "semantic";
      const scope = args.scope ?? deps.defaultScope ?? "global";

      /**
       * 走 upsert 而不是直插。
       *
       * 早期这里是 `memories.put(newId, rec)` —— 完全不去重。模型重复调用
       * 同一句「记住 X」会造出 N 条几乎相同的记录，召回时同质化严重。
       * 现在走与自动写入同一条路径，语义/词法双重去重都生效。
       */
      const r = await upsertByTool(deps, {
        text: String(args.text ?? "").slice(0, 800),
        kind,
        level,
        importance: LEVELS[level].imp,
        tags: [],
        source: "tool",
      }, scope);

      const cfg = LEVELS[level];
      return {
        id: r.id,
        tier: r.tier,
        level,
        action: r.action,
        survivalDays: Number((2.996 * cfg.s0 * (r.tier === "long" ? 4 : 1)).toFixed(1)),
      };
    },
  });

  const memoryManage = defineTool({
    name: "memory_manage",
    description:
      "Inspect or adjust stored memory. Actions: " +
      "`stats` (counts by tier and diagnostics), `list` (recent items, filterable by scope/tier), " +
      "`sleep` (move one item to dormant — recoverable; this is the right choice when the user says to forget something), " +
      "`delete` (permanently remove one item — irreversible, requires confirm:true), " +
      "`clear` (bulk delete by scope/tier/age — irreversible, requires confirm:true), " +
      "`promote` (move to long-term), `sweep` (apply decay now), " +
      "`reembed` (recompute semantic vectors for existing items), " +
      "`embed_status` (show the embedding configuration actually in effect and, " +
      "with `probe: true`, test the endpoint live).",
    parameters: {
      action: {
        type: "string",
        enum: [
          "stats", "list", "sleep", "delete", "clear", "promote",
          "sweep", "reembed", "embed_status",
        ],
        required: true,
        description: "The operation to perform.",
      },
      id: {
        type: "string",
        description: "Target memory id. Required for sleep, delete and promote.",
      },
      limit: {
        type: "integer",
        description: "For list: how many items (default 20, max 200).",
      },
      scope: {
        type: "string",
        description: "For list/clear: restrict to this project scope.",
      },
      tier: {
        type: "string",
        enum: ["active", "long", "dormant"],
        description: "For list/clear: restrict to this tier.",
      },
      before: {
        type: "number",
        description: "For clear: Unix epoch milliseconds. Only delete items created before this.",
      },
      confirm: {
        type: "boolean",
        description:
          "Required `true` for delete and clear. Both are irreversible. " +
          "For a reversible removal use `sleep` instead.",
      },
      probe: {
        type: "boolean",
        description: "For embed_status: actually call the endpoint to verify it works.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          ok: { type: "boolean" },
          detail: { type: "string" },
          tally: {
            type: "object",
            additionalProperties: false,
            properties: {
              active: { type: "integer" },
              long: { type: "integer" },
              dormant: { type: "integer" },
              total: { type: "integer" },
            },
          },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                tier: { type: "string" },
                level: { type: "string" },
                scope: { type: "string" },
                createdAt: { type: "number" },
                tainted: { type: "boolean" },
              },
            },
          },
        },
      },
      render(_args, v) {
        const parts = [];
        if (v.detail) parts.push(v.detail);
        if (v.tally) {
          parts.push(
            `active ${v.tally.active} / long ${v.tally.long} / dormant ${v.tally.dormant} (total ${v.tally.total})`,
          );
        }
        if (v.items?.length) {
          parts.push(...v.items.map(
            (m) => `- [${m.tier}/${m.level}/${m.scope}] ${m.text}  ${m.id}`
              + (m.tainted ? " ⚠" : ""),
          ));
        }
        return [{ type: "text", text: parts.join("\n") || "done" }];
      },
    },
    async execute(args) {
      const memories = deps.domain.table("memories");

      if (args.action === "embed_status") {
        // 回答"现在到底在用哪套嵌入配置"。用户改完配置页最常问这个，
        // 与其让他去翻日志，不如直接给结论。
        const info = describeEmbedConfig(deps.config, deps.ctx);
        if (args.probe && info.ready) {
          const r = await deps.embedder?.probe?.();
          return {
            action: "embed_status",
            ok: Boolean(r?.ok),
            detail: formatEmbedStatus(info, r, deps.index),
          };
        }
        return {
          action: "embed_status",
          ok: info.ready,
          detail: formatEmbedStatus(info, null, deps.index),
        };
      }

      if (args.action === "reembed") {
        const r = await reembedAll(deps);
        return { action: "reembed", ok: r.ok, detail: r.detail };
      }

      if (args.action === "sweep") {
        const r = await sweep(deps, 100000);
        const edges = await pruneOrphanEdges(deps);
        const jobs = await pruneJournal(deps);
        return {
          action: "sweep",
          ok: true,
          detail:
            `scanned ${r.scanned}, forgot ${r.forgot}, demoted ${r.demoted}, ` +
            `purged ${r.purged}, edges pruned ${edges + r.orphans}, ` +
            `evicted ${r.evicted}, failed jobs pruned ${jobs}`,
        };
      }

      /**
       * sleep：转到 dormant，保留记录与关联边。
       *
       * 这是「遗忘」的正确语义 —— README 一直写的是「遗忘但不删除」，
       * 而早期实现是 `memories.delete()` + `DELETE FROM`，物理删除且无二次确认。
       * 模型一次工具调用就能永久毁掉一条记忆，用户以为只是「让它别那么活跃」。
       */
      if (args.action === "sleep") {
        if (!args.id) return { action: "sleep", ok: false, detail: "id is required" };
        const cur = memories.get(args.id);
        if (!cur) return { action: "sleep", ok: false, detail: `no memory with id ${args.id}` };
        const now = Date.now();
        await memories.put(args.id, {
          ...cur,
          tier: "dormant",
          forgotAt: now,
          lastDecayAt: now,
        });
        deps.index.drop(args.id);
        try { await deps.domain.table("semvec")?.delete?.(args.id); } catch { /* 加速层 */ }
        await bumpStats(deps.domain, { forgotten: 1 });
        return {
          action: "sleep",
          ok: true,
          detail: `${args.id} 已转入 dormant（保留记录与关联边，可经关联唤醒；彻底删除请用 delete + confirm）`,
        };
      }

      /** delete：物理删除，不可恢复。必须显式 confirm。 */
      if (args.action === "delete") {
        if (!args.id) return { action: "delete", ok: false, detail: "id is required" };
        const had = memories.get(args.id);
        if (!had) return { action: "delete", ok: false, detail: `no memory with id ${args.id}` };
        if (args.confirm !== true) {
          return {
            action: "delete",
            ok: false,
            detail:
              `永久删除 ${args.id} 需要 confirm:true。此操作不可恢复。` +
              `若只想让它不再被自动召回，用 action="sleep"。`,
          };
        }
        await memories.delete(args.id);
        deps.index.drop(args.id);
        try { await deps.domain.table("semvec")?.delete?.(args.id); } catch { /* 加速层 */ }
        // 顺带清掉它的边，否则边表只增不减
        const edges = deps.domain.table("edges");
        for (const [key, e] of [...edges.entries()]) {
          if (e?.from === args.id || e?.to === args.id) await edges.delete(key);
        }
        return { action: "delete", ok: true, detail: `已永久删除 ${args.id}（含其关联边）` };
      }

      /** clear：批量删除。用户行使「删除我的数据」必须能一次做完。 */
      if (args.action === "clear") {
        if (args.confirm !== true) {
          const preview = await clearMemories(deps, {
            scope: args.scope,
            before: args.before,
            tier: args.tier,
            dryRun: true,
          });
          return {
            action: "clear",
            ok: false,
            detail:
              `将永久删除 ${preview.matched} 条记忆，此操作不可恢复。确认请加 confirm:true` +
              (args.scope ? `（scope=${args.scope}）` : "") +
              (args.tier ? `（tier=${args.tier}）` : ""),
          };
        }
        const r = await clearMemories(deps, {
          scope: args.scope,
          before: args.before,
          tier: args.tier,
        });
        return {
          action: "clear",
          ok: true,
          detail: `已删除 ${r.deleted} 条记忆、${r.edges} 条关联边`,
        };
      }

      if (args.action === "promote") {
        if (!args.id) return { action: "promote", ok: false, detail: "id is required" };
        const cur = memories.get(args.id);
        if (!cur) return { action: "promote", ok: false, detail: `no memory with id ${args.id}` };
        await memories.put(args.id, { ...cur, tier: "long", lastDecayAt: Date.now() });
        await bumpStats(deps.domain, { promoted: 1 });
        return { action: "promote", ok: true, detail: `${args.id} is now long-term` };
      }

      if (args.action === "list") {
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
        // 全文而非 120 字截断：用户想确认「到底记了什么」，
        // 只给开头会让他更困惑。上限由 200 条与上下文预算共同决定。
        const rows = [...memories.entries()]
          .map(([, r]) => r)
          .filter((r) => !args.scope || (r.scope ?? "global") === args.scope)
          .filter((r) => !args.tier || (r.tier ?? "active") === args.tier)
          .sort((a, b) => (b.lastRecallAt ?? b.createdAt ?? 0) - (a.lastRecallAt ?? a.createdAt ?? 0))
          .slice(0, limit);
        return {
          action: "list",
          ok: true,
          items: rows.map((r) => ({
            id: r.id,
            text: r.text ?? "",
            tier: r.tier ?? "active",
            level: levelOfImportance(r.importance ?? 0.4),
            scope: r.scope ?? "global",
            createdAt: r.createdAt ?? 0,
            tainted: Boolean(r.tainted),
          })),
        };
      }

      // stats
      const tally = { active: 0, long: 0, dormant: 0, total: 0 };
      const byScope = new Map();
      for (const [, r] of memories.entries()) {
        const t = r.tier ?? "active";
        if (tally[t] !== undefined) tally[t] += 1;
        tally.total += 1;
        const s = r.scope ?? "global";
        byScope.set(s, (byScope.get(s) ?? 0) + 1);
      }
      const g = deps.domain.global.get();
      const s = g?.stats ?? {};
      const scopeLine = byScope.size > 0
        ? `作用域 ${[...byScope.entries()].map(([k, v]) => `${k}:${v}`).join(", ")}`
        : "作用域 -";
      return {
        action: "stats",
        ok: true,
        tally,
        detail: [
          `turns ${s.turnsSeen ?? 0}, jobs done ${s.jobsDone ?? 0}, failed ${s.jobsFailed ?? 0}`,
          `recalls ${s.recalled ?? 0}, promoted ${s.promoted ?? 0}, forgotten ${s.forgotten ?? 0}, revived ${s.revived ?? 0}`,
          `blocked ${s.blocked ?? 0}, purged ${s.purged ?? 0}, evicted ${s.evicted ?? 0}, cleared ${s.cleared ?? 0}`,
          `mood samples ${s.moodTotal ?? 0} (rejected ${s.moodRejected ?? 0}), multi-label ${s.multiLabel ?? 0}`,
          `语义覆盖 ${deps.index.semanticCount}/${deps.index.size}`,
          scopeLine,
          `心情来源：${MOOD_INFERENCE_NOTE}`,
        ].join("\n"),
      };
    },
  });

  return [memoryRecall, memoryRemember, memoryManage];
}

/**
 * 一次性重算存量条目的语义向量。
 *
 * 为什么需要：升级到「语义召回真的接线」这个版本后，存量记忆只有
 * 词汇向量，语义空间是空的。若不主动补，语义召回要等每条记忆被
 * 重新写入/唤醒才能生效 —— 对老用户等于"升级了但没变化"，又一次
 * 落入「有配置没效果」的坑。
 *
 * 分批调用 embedder，避免一次几百条把端点打爆。
 */
async function reembedAll(deps) {
  const { domain, index, embedder, log } = deps;
  if (!embedder?.ready?.()) {
    return { ok: false, detail: "嵌入未配置或不可用，无法重算。请先在设置页配置嵌入模型。" };
  }
  const memories = domain.table("memories");
  const semvec = domain.table("semvec");

  const targets = [...memories.entries()]
    .filter(([, r]) => (r.tier ?? "active") !== "dormant" && r.text)
    .map(([id, r]) => ({ id, text: r.text }));

  if (targets.length === 0) return { ok: true, detail: "没有需要重算的条目。" };

  const BATCH = 16;
  let done = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    try {
      const { vectors, semantic } = await embedder.embedBatch(chunk.map((c) => c.text));
      if (!semantic) { failed += chunk.length; continue; }
      for (let k = 0; k < chunk.length; k += 1) {
        const v = vectors[k];
        if (!v) { failed += 1; continue; }
        index.attachSemantic(chunk[k].id, v);
        try {
          await semvec.put(chunk[k].id, { id: chunk[k].id, vec: Array.from(v), dim: v.length, schemaV: 1 });
        } catch { /* 加速层 */ }
        done += 1;
      }
    } catch (e) {
      failed += chunk.length;
      log?.warn?.(`memory: reembed batch failed: ${e?.message ?? e}`);
    }
  }

  return {
    ok: done > 0,
    detail: `重算完成：成功 ${done} 条，失败 ${failed} 条。当前语义覆盖 ${index.semanticCount}/${index.size}。`,
  };
}

export { defineTool, formatEmbedStatus };

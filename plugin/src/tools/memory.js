/**
 * 模型可见工具：记忆检索、记忆写入、记忆管理、状态内省。
 *
 * 设计取舍：只暴露 4 个工具。工具越多，模型越容易在无必要时调用，
 * 反而把上下文塞满。检索默认自动注入（systemPrompt.context），
 * 这里的 recall 工具只用于「主动翻找」的场景。
 */

import { hostExport } from "../resolve.js";
import { RECALL_TOP_K, LEVELS, LEVEL_ORDER } from "../core/config.js";
import { recall, touchRecalled, sweep, bumpStats } from "../pipeline/pipeline.js";
import { levelOfImportance } from "../core/config.js";
import { describeEmbedConfig } from "../storage/embed-config.js";

/**
 * 把嵌入配置摘要渲染成人能读的几行。
 *
 * @param {object} info describeEmbedConfig 的返回
 * @param {object|null} probe 探测结果；null 表示没探测
 */
function formatEmbedStatus(info, probe) {
  const lines = [
    `嵌入来源：${info.mode}  (${info.origin})`,
    `API 地址：${info.baseURL}`,
    `模型 id ：${info.model}`,
    `API Key ：${info.apiKey}`,
    `可用性  ：${info.ready ? "配置完整" : "配置不完整"}`,
  ];
  if (info.note) lines.push(`说明    ：${info.note}`);

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
          (m, i) => `${i + 1}. [${m.tier}/${m.kind ?? "?"}] ${m.text}  (score ${m.score.toFixed(2)}, via ${m.via})`,
        );
        const head = `Found ${value.count} memory item(s)${value.revived ? `, ${value.revived} revived from dormant` : ""}:`;
        return [{ type: "text", text: [head, ...lines].join("\n") }];
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(args.limit ?? RECALL_TOP_K, 1), 20);
      const hits = recall(deps, args.query, { limit });
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
        },
      },
      render(_args, v) {
        return [{
          type: "text",
          text: `Stored as ${v.level} (${v.tier} tier), survives ~${v.survivalDays} days without recall. id=${v.id}`,
        }];
      },
    },
    async execute(args) {
      const level = LEVEL_ORDER.includes(args.level) ? args.level : "important";
      const kind = args.kind ?? "semantic";
      const memories = deps.domain.table("memories");
      const now = Date.now();
      const id = `mem_${now.toString(36)}_${Math.floor(Math.random() * 1296).toString(36)}`;
      const cfg = LEVELS[level];
      const tier = level === "critical" ? "long" : "active";

      const rec = {
        id,
        text: args.text.slice(0, 800),
        kind,
        tier,
        importance: cfg.imp,
        stability: cfg.s0,
        recallCount: 0,
        recurred: 0,
        createdAt: now,
        lastRecallAt: now,
        lastDecayAt: now,
        sourceTurn: "tool",
        tags: [],
        schemaV: 1,
      };
      await memories.put(id, rec);
      deps.index.put(id, rec.text, rec);

      return {
        id,
        tier,
        level,
        survivalDays: Number((2.996 * cfg.s0 * (tier === "long" ? 4 : 1)).toFixed(1)),
      };
    },
  });

  const memoryManage = defineTool({
    name: "memory_manage",
    description:
      "Inspect or adjust stored memory. Actions: " +
      "`stats` (counts by tier), `list` (recent items), `forget` (drop one item), " +
      "`promote` (move to long-term), `sweep` (apply decay now), " +
      "`embed_status` (show the embedding configuration actually in effect and, " +
      "with `probe: true`, test the endpoint live).",
    parameters: {
      action: {
        type: "string",
        enum: ["stats", "list", "forget", "promote", "sweep", "embed_status"],
        required: true,
        description: "The operation to perform.",
      },
      id: {
        type: "string",
        description: "Target memory id. Required for forget and promote.",
      },
      limit: {
        type: "integer",
        description: "For list: how many items (default 20).",
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
          parts.push(...v.items.map((m) => `- [${m.tier}/${m.level}] ${m.text}  ${m.id}`));
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
            detail: formatEmbedStatus(info, r),
          };
        }
        return {
          action: "embed_status",
          ok: info.ready,
          detail: formatEmbedStatus(info, null),
        };
      }

      if (args.action === "sweep") {
        const r = await sweep(deps, 100000);
        return {
          action: "sweep",
          ok: true,
          detail: `scanned ${r.scanned}, forgot ${r.forgot}, demoted ${r.demoted}`,
        };
      }

      if (args.action === "forget") {
        if (!args.id) return { action: "forget", ok: false, detail: "id is required" };
        const had = memories.get(args.id);
        if (!had) return { action: "forget", ok: false, detail: `no memory with id ${args.id}` };
        await memories.delete(args.id);
        deps.index.drop(args.id);
        return { action: "forget", ok: true, detail: `deleted ${args.id}` };
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
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
        const rows = [...memories.entries()]
          .map(([, r]) => r)
          .sort((a, b) => (b.lastRecallAt ?? b.createdAt ?? 0) - (a.lastRecallAt ?? a.createdAt ?? 0))
          .slice(0, limit);
        return {
          action: "list",
          ok: true,
          items: rows.map((r) => ({
            id: r.id,
            text: (r.text ?? "").slice(0, 120),
            tier: r.tier ?? "active",
            level: levelOfImportance(r.importance ?? 0.4),
          })),
        };
      }

      // stats
      const tally = { active: 0, long: 0, dormant: 0, total: 0 };
      for (const [, r] of memories.entries()) {
        const t = r.tier ?? "active";
        if (tally[t] !== undefined) tally[t] += 1;
        tally.total += 1;
      }
      const g = deps.domain.global.get();
      const s = g?.stats ?? {};
      return {
        action: "stats",
        ok: true,
        tally,
        detail:
          `turns ${s.turnsSeen ?? 0}, jobs done ${s.jobsDone ?? 0}, failed ${s.jobsFailed ?? 0}, ` +
          `recalls ${s.recalled ?? 0}, promoted ${s.promoted ?? 0}, forgotten ${s.forgotten ?? 0}, ` +
          `revived ${s.revived ?? 0}`,
      };
    },
  });

  return [memoryRecall, memoryRemember, memoryManage];
}

export { defineTool };

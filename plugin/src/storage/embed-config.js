/**
 * 嵌入配置的最终解析：把三种来源（inherit / custom / off）收敛成一个
 * 可直接发给 /embeddings 的三元组 {url, apiKey, model}。
 *
 * ## 为什么要单独一层
 *
 * `index.js` 的 Config 描述"用户填了什么"，本模块回答"现在实际该用什么"。
 * 两者分开有三个好处：
 *
 *   · 继承模式的解析要读文件、查凭据，是 I/O，不该混在配置 schema 里
 *   · 每个请求都重解析（用户改配置立刻生效），但文件读取要缓存
 *   · 探测、自检、实际嵌入走同一条解析路径，不会出现"测试通过但实际失败"
 *
 * ## 缓存策略
 *
 * 继承结果缓存 TTL_MS，因为读的是磁盘文件。用户改完设置页后最多等
 * 一个 TTL 就生效 —— 比"必须重启进程"好得多，又不至于每次嵌入都读盘。
 *
 * custom 模式不缓存：值就在内存里，拼一下而已。
 */

import { existsSync, statSync } from "node:fs";
import { resolveInheritedModel } from "../core/inherit.js";
import { embeddingsUrl } from "./embed-client.js";

/** 继承结果缓存时长。改设置页后最迟这么久生效。 */
const TTL_MS = 5000;

let cache = { at: 0, key: "", value: null };

/**
 * 解析当前应使用的嵌入配置。
 *
 * @param {object} config 插件的 Config（含 embedSource / embedBaseURL / ...）
 * @param {object} ctx cordis 上下文，用于继承解析
 * @returns {{
 *   mode: string, url: string, apiKey: string, model: string,
 *   baseURL: string, origin: string, reason: string
 * }} reason 非空表示配置不完整，调用方应降级
 */
export function resolveEmbedConfig(config, ctx) {
  const mode = String(config?.embedSource ?? "inherit");

  if (mode === "off") {
    return { mode, url: "", apiKey: "", model: "", baseURL: "", origin: "off", reason: "已关闭语义召回" };
  }

  if (mode === "custom") {
    const baseURL = String(config?.embedBaseURL ?? "").trim();
    const apiKey = String(config?.embedApiKey ?? "").trim();
    const model = String(config?.embedModel ?? "").trim();
    const missing = [];
    if (!baseURL) missing.push("API 地址");
    if (!apiKey) missing.push("API Key");
    if (!model) missing.push("模型 id");
    return {
      mode,
      baseURL,
      url: embeddingsUrl(baseURL),
      apiKey,
      model,
      origin: "custom",
      reason: missing.length ? `自定义配置缺少：${missing.join("、")}` : "",
    };
  }

  // inherit
  return resolveInheritCached(config, ctx);
}

/**
 * 继承解析带 TTL 缓存。缓存的 key 里带上 patch 文件 mtime，改文件即失效。
 *
 * 注意这里的 patchPath 只用于「缓存键」，不作为解析输入 —— 真正的路径
 * 探测在 inherit.js 里做，那里用 `in` 守卫安全地取服务。这里同样不能
 * 直接 `ctx.configEditor`：cordis 的 Context 是 Proxy，读未 inject 的
 * 服务会抛错，可选链也挡不住。取不到就退化成空串，缓存退化为按时间失效。
 */
function resolveInheritCached(config, ctx) {
  const now = Date.now();
  let patchPath = "";
  try {
    if (ctx !== undefined && ctx !== null && "configEditor" in ctx) {
      patchPath = ctx.configEditor?.documentPath ?? "";
    }
  } catch { /* 服务不可用，退化 */ }
  let mtime = 0;
  try { if (patchPath && existsSync(patchPath)) mtime = statSync(patchPath).mtimeMs; } catch { /* 忽略 */ }
  const key = `${patchPath}|${mtime}`;

  if (cache.value && cache.key === key && now - cache.at < TTL_MS) {
    return cache.value;
  }

  const r = resolveInheritedModel(ctx);
  const value = r.ok
    ? {
        mode: "inherit",
        baseURL: r.baseURL,
        url: embeddingsUrl(r.baseURL),
        apiKey: r.apiKey,
        model: r.model,
        origin: `inherit:${r.provider}/${r.model}`,
        // 继承来的是生成模型，嵌入端点未必存在。这里不预先判断，
        // 交给探测去发现——但把提示写进 reason 供界面展示。
        reason: "",
        _inherited: { provider: r.provider, model: r.model, apiKeyEnv: r.apiKeyEnv, patchFile: r.patchFile },
      }
    : {
        mode: "inherit",
        baseURL: "", url: "", apiKey: "", model: "",
        origin: "inherit:failed",
        reason: `继承失败：${r.reason ?? "未知原因"}。请在配置页把嵌入来源改为「自定义」并手填。`,
      };

  cache = { at: now, key, value };
  return value;
}

/** 清空缓存。测试与"重新探测"用。 */
export function clearEmbedCache() { cache = { at: 0, key: "", value: null }; }

/**
 * 面向界面的配置摘要。不含密钥明文，可安全写进日志或返回给前端。
 *
 * @param {object} config
 * @param {object} ctx
 */
export function describeEmbedConfig(config, ctx) {
  const r = resolveEmbedConfig(config, ctx);
  return {
    mode: r.mode,
    origin: r.origin,
    baseURL: r.baseURL || "(未设置)",
    url: r.url || "(未设置)",
    model: r.model || "(未设置)",
    apiKey: r.apiKey ? `已设置（${r.apiKey.length} 字符）` : "(未设置)",
    ready: Boolean(r.url && r.apiKey && r.model),
    note: r.reason || "",
    inherited: r._inherited ?? null,
  };
}

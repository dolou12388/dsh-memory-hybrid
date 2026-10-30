/**
 * 探测：当前 dsh 客户端在用的端点是否具备 /embeddings 能力。
 *
 * 直接复用 inherit.js 的解析结果，不写死任何地址或密钥。
 */

import { resolveInheritedModel } from "../plugin/src/core/inherit.js";
import { probeEmbedding, embeddingsUrl } from "../plugin/src/storage/embed-client.js";

const hr = () => console.log("─".repeat(74));

const r = resolveInheritedModel({});
console.log("=".repeat(74));
console.log("探测：继承来的端点能否做 embedding");
console.log("=".repeat(74));
console.log();

if (!r.ok) {
  console.log("✗ 继承失败，无法探测：" + (r.reason ?? ""));
  process.exit(0);
}

const url = embeddingsUrl(r.baseURL);
console.log(`端点    ${r.baseURL}`);
console.log(`完整URL ${url}`);
console.log(`模型    ${r.model}   (provider=${r.provider}, key=${r.apiKeyEnv})`);
hr();
console.log();

const res = await probeEmbedding({ baseURL: r.baseURL, apiKey: r.apiKey, model: r.model });
console.log("探测结果：");
console.log(JSON.stringify(res, null, 2));
hr();

if (res.ok) {
  console.log(`✓ 可用。维度 = ${res.dim}`);
  console.log("  继承模式下开箱即用，用户无需填任何配置。");
} else {
  console.log("✗ 不可用。");
  console.log();
  console.log("这符合预期：继承来的是**生成**模型，多数网关的生成端点不带");
  console.log("/embeddings。用户需要在配置页把 embedSource 改成 custom，");
  console.log("填一个真正的嵌入模型（如 bge-m3 / text-embedding-3-small）。");
  if (res.status === 404) {
    console.log();
    console.log("提示：HTTP 404 说明该地址确实没有这个接口，不是密钥问题。");
  }
}
hr();

// 再列一下同网关常见嵌入模型名，供用户填 custom 时参考
console.log();
console.log("建议优先试这些模型名（同名接口下换 model 字段即可）：");
for (const m of ["bge-m3", "bge-large-zh-v1.5", "text-embedding-3-small", "text-embedding-v3", "embedding-3"]) {
  console.log(`  · ${m}`);
}

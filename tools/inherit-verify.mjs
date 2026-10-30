/**
 * 继承解析器验证：用真实 profile 文件跑一遍。
 *
 * 这个脚本不进 npm 包（在 workspace 根 tools/ 下），只用于开发期核对
 * `core/inherit.js` 能否从用户的 cordis.patch.yml 里正确读出当前模型配置。
 */

import { resolveInheritedModel, scanPatchEntries } from "../plugin/src/core/inherit.js";
import { readFileSync } from "node:fs";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(74));

line("=".repeat(74));
line("继承解析：从 profile 的 cordis.patch.yml 读出当前生效的模型配置");
line("=".repeat(74));
line();

const r = resolveInheritedModel({});

hr();
line(`ok         ${r.ok}`);
line(`patchFile  ${r.patchFile || "(未找到)"}`);
line(`provider   ${r.provider || "(空)"}`);
line(`displayName ${r.displayName || "(空)"}`);
line(`model      ${r.model || "(空)"}`);
line(`baseURL    ${r.baseURL || "(空)"}`);
line(`apiKeyEnv  ${r.apiKeyEnv || "(空)"}`);
line(`apiKey     ${r.apiKey ? r.apiKey.slice(0, 8) + "…(长度 " + r.apiKey.length + ")" : "(空)"}`);
if (r.reason) line(`reason     ${r.reason}`);
hr();
line();

if (r.patchFile) {
  line("解析出的条目清单：");
  const entries = scanPatchEntries(readFileSync(r.patchFile, "utf8"));
  for (const e of entries) {
    const keys = Object.keys(e.config ?? {});
    line(`  · id=${e.id}`);
    line(`    name=${e.name}`);
    line(`    config keys: [${keys.join(", ")}]`);
    if (e.config?.providers) {
      for (const [route, p] of Object.entries(e.config.providers)) {
        line(`      providers.${route}: baseURL=${p.baseURL ?? ""} apiKeyEnv=${p.apiKeyEnv ?? ""} models=${(p.models ?? []).map((m) => m.id).join(",")}`);
      }
    }
  }
  line();
}

hr();
line("结论");
hr();
if (r.ok) {
  line("✓ 继承成功。用户不填任何配置即可拿到 baseURL / apiKey / model。");
  line("");
  line("注意：继承来的是**生成**模型。嵌入端点需要的是 embedding 模型，");
  line("      两者通常不通用。探测会明确报 404/unsupported，届时用户改填");
  line("      custom 指向真正的嵌入模型即可。");
} else {
  line("✗ 继承失败：" + (r.reason ?? "未知"));
  line("  用户需要在配置页把 embedSource 改成 custom 并手填三项。");
}
hr();

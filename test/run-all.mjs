#!/usr/bin/env node
/**
 * 全套测试入口。
 *
 * 五个套件按「依赖由少到多」排列，前面的失败不应掩盖后面的：
 *   1. core            —— 纯逻辑，无 IO 无宿主
 *   2. backend-contract —— 存储契约，有 IO 无宿主
 *   3. sqlite-embedded  —— 内嵌引擎，验证零外部依赖成立
 *   4. embed-config     —— 嵌入配置解析与继承（离线，不发真实请求）
 *   5. host-wiring      —— 真实 cordis + storage + storage-domain
 *
 * 用法：node test/run-all.mjs
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ["core", "核心逻辑：衰减 / 心情 / 抽取 / 召回 / 管线"],
  ["backend-contract", "存储后端契约"],
  ["sqlite-embedded", "内嵌 sqlite 引擎（零外部依赖）"],
  ["embed-config", "嵌入配置解析与继承（离线）"],
  ["host-wiring", "真实宿主装配（cordis + storage + domain）"],
];

const results = [];

for (const [name, desc] of SUITES) {
  console.log("\n" + "─".repeat(60));
  console.log(`▶ ${desc}`);
  console.log("─".repeat(60));

  const r = spawnSync(process.execPath, [join(here, `${name}.test.mjs`)], {
    stdio: "inherit",
    cwd: join(here, ".."),
  });
  results.push({ name, desc, code: r.status ?? 1 });
}

console.log("\n" + "=".repeat(60));
console.log("汇总");
console.log("=".repeat(60));
let failed = 0;
for (const r of results) {
  const mark = r.code === 0 ? "✓" : "✗";
  if (r.code !== 0) failed += 1;
  console.log(`  ${mark} ${r.name.padEnd(18)} ${r.desc}`);
}
console.log("");
if (failed > 0) {
  console.log(`${failed} / ${results.length} 个套件失败\n`);
  process.exit(1);
}
console.log(`${results.length} / ${results.length} 个套件全部通过\n`);

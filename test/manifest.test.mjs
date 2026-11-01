#!/usr/bin/env node
/**
 * 清单一致性测试。
 *
 * 这个仓库有**两份** `package.json`：仓库根的代理清单（`github:` 装法读它）
 * 和 `plugin/` 下的子包清单（`link:` 装法读它）。两者装出来是同一个包，
 * 所以版本号必须永远相同 —— 不同的话，两种装法会得到同一个名字、不同版本，
 * 而 `dsh plugin list` 看起来一切正常。
 *
 * 更要紧的是版本号本身：`github:owner/repo` 这种规格**不吃 semver**。
 * pnpm 把解析结果钉成 `codeload.../tar.gz/<commit>` 写进 lockfile，之后
 * `pnpm add` 同一个规格时只看包名与版本号是否已经满足，命中就跳过下载。
 * 于是「代码推上去了、版本号没动」= 老用户重新执行同一条安装命令，
 * 装回来的仍是**旧 commit**，而输出照样是 `+ dsh-memory-hybrid x.y.z`。
 *
 * 这个坑踩过一次（侧栏面板那次，远端已是 8e19f36，用户那边还停在
 * e453cc2），所以在此加自动检查。
 *
 * 检查分两层：
 *   1. 两份清单的版本号一致
 *   2. 若与上一个 git 提交相比源码有过改动，则版本号必须已经变过
 *
 * 第 2 条依赖 git；在没有 .git 的环境（npm 包安装后）自动跳过。
 *
 * 用法：node test/manifest.test.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    return;
  }
  fail += 1;
  failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log(`  ✗ ${name} ${extra}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `实际 ${a} / 期望 ${e}`);
}
function group(title) {
  console.log(`\n${title}`);
}

/** 读取并校验一份清单。 */
function readManifest(path) {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

/* ------------------------------------------------------------------ *
 * [1] 两份清单都存在且版本一致
 * ------------------------------------------------------------------ */

group("两份清单");

const rootPkgPath = resolve(root, "package.json");
const pluginPkgPath = resolve(root, "plugin", "package.json");

ok("根清单存在", existsSync(rootPkgPath));
ok("子包清单存在", existsSync(pluginPkgPath));

const rootPkg = readManifest(rootPkgPath);
const pluginPkg = readManifest(pluginPkgPath);

eq("包名一致", rootPkg.name, pluginPkg.name);
eq("版本号一致", rootPkg.version, pluginPkg.version);

ok(
  "版本号是合法 semver",
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(rootPkg.version),
  `实际 ${rootPkg.version}`,
);

/* ------------------------------------------------------------------ *
 * [2] 两侧的 dsh 关键字段不能漂移
 * ------------------------------------------------------------------ */

group("dsh 声明");

// 根清单是代理清单：入口指向 plugin/ 下，patch 路径也要带 plugin/ 前缀。
// 子包清单从 plugin/ 自身出发，路径不带前缀。两处都对，但必须各自自洽。
eq("根清单 main 指向 plugin/", rootPkg.main, "./plugin/src/index.js");
eq("根清单 exports['.']", rootPkg.exports?.["."], "./plugin/src/index.js");
eq("根清单 client 导出", rootPkg.exports?.["./client"], "./plugin/client.js");
eq("子包 main", pluginPkg.main, "src/index.js");
eq("子包 exports['.']", pluginPkg.exports?.["."], "./src/index.js");

eq("根清单 bundle patch", rootPkg.dsh?.bundle?.patch, "./plugin/cordis.patch.yml");
eq("子包 bundle patch", pluginPkg.dsh?.bundle?.patch, "./cordis.patch.yml");

// 客户端产物是设置页 tab 与侧栏面板的前提，缺了就是整块 UI 消失且不报错
eq("根清单 client.platform", rootPkg.dsh?.client?.platform, "web");
eq("根清单 client.inject", rootPkg.dsh?.client?.inject, pluginPkg.dsh?.client?.inject);

// files 白名单漏项会让 npm pack 少带文件，但本地 link 装看不出来
const rootFiles = rootPkg.files ?? [];
for (const expect of ["plugin/src", "plugin/client.js", "plugin/vendor", "plugin/cordis.patch.yml"]) {
  ok(`根 files 含 ${expect}`, rootFiles.includes(expect), `实际 ${JSON.stringify(rootFiles)}`);
}
const pluginFiles = pluginPkg.files ?? [];
for (const expect of ["src", "client.js", "vendor", "cordis.patch.yml"]) {
  ok(`子包 files 含 ${expect}`, pluginFiles.includes(expect), `实际 ${JSON.stringify(pluginFiles)}`);
}

/* ------------------------------------------------------------------ *
 * [3] 零外部依赖
 * ------------------------------------------------------------------ */

group("零外部依赖");

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundleDependencies",
];

for (const field of DEP_FIELDS) {
  ok(`根清单未声明 ${field}`, rootPkg[field] === undefined);
  ok(`子包未声明 ${field}`, pluginPkg[field] === undefined);
}

/* ------------------------------------------------------------------ *
 * [4] 改了源码就要升版本
 * ------------------------------------------------------------------ */

group("版本是否跟上源码改动");

/**
 * 跑一条 git 命令，失败时返回 undefined（无 .git、无 git、浅克隆都可能失败）。
 *
 * @param {string[]} args - git 参数
 * @returns {string|undefined} 标准输出（已去掉首尾空白）
 */
function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const hasGit = existsSync(resolve(root, ".git")) && git(["rev-parse", "--git-dir"]) !== undefined;

if (!hasGit) {
  console.log("  · 无 .git，跳过「源码改动 ↔ 版本号」检查");
} else {
  // 上一提交的版本号：HEAD~1 不存在（首个提交）时按 undefined 处理
  const prevPkgRaw = git(["show", "HEAD~1:package.json"]);
  const prevPkg = prevPkgRaw === undefined ? undefined : JSON.parse(prevPkgRaw);

  // 相对上一提交，插件产物里是否有实质改动
  const changed = git(["diff", "--name-only", "HEAD~1", "HEAD", "--", "plugin/"]);
  const changedFiles = (changed ?? "").split("\n").filter(Boolean);

  // 只关心会进包的文件；README 之类也算，因为它同样会改变用户看到的内容
  const shipped = changedFiles.filter((f) => !f.includes("node_modules"));

  if (prevPkg === undefined) {
    console.log("  · 无上一提交，跳过「版本号是否已升」检查");
  } else if (shipped.length === 0) {
    console.log("  · 上一提交未改动 plugin/，无需升版本");
  } else {
    ok(
      "plugin/ 有改动，版本号已提升",
      rootPkg.version !== prevPkg.version,
      `上一提交 ${prevPkg.version} → 当前 ${rootPkg.version}，改动 ${shipped.length} 个文件：${shipped.slice(0, 3).join(", ")}`,
    );
  }

  // 工作区若有未提交的 plugin/ 改动，且版本号相对 HEAD 还没变，才提示。
  // 已经升过版本就不该继续催 —— 开发中途本来就会边改边提交。
  const dirty = git(["status", "--porcelain", "--", "plugin/"]);
  const dirtyFiles = (dirty ?? "").split("\n").filter(Boolean);
  const headPkgRaw = git(["show", "HEAD:package.json"]);
  const headVersion = headPkgRaw === undefined ? undefined : JSON.parse(headPkgRaw).version;
  const bumped = headVersion !== undefined && rootPkg.version !== headVersion;

  if (dirtyFiles.length > 0 && !bumped) {
    console.log(
      `  · 工作区有 ${dirtyFiles.length} 个 plugin/ 改动未提交，且版本号仍是 ${rootPkg.version}，提交前记得升`,
    );
  } else if (dirtyFiles.length > 0 && bumped) {
    console.log(`  · 工作区有 ${dirtyFiles.length} 个 plugin/ 改动未提交，版本号已升到 ${rootPkg.version}`);
  }
}

/* ------------------------------------------------------------------ *
 * [5] 版本号出现在 README 里时不能自相矛盾
 * ------------------------------------------------------------------ */

group("文档中的版本号");

const readme = readFileSync(resolve(root, "README.md"), "utf8");
const pluginReadme = readFileSync(resolve(root, "plugin", "README.md"), "utf8");

// 只认「明确在说本包版本」的写法：包名后紧跟版本号，或 dsh-memory-hybrid@x.y.z。
// 全文扫三段数字会误伤 Jev 模型版本（jev-1.14.0）、IP（127.0.0.1）、
// dshTarget（0.2.0-rc.2）这些无关数字，反而逼着人去改不相干的行。
const versionMentions = /dsh-memory-hybrid[@\s]+v?(\d+\.\d+\.\d+)/g;
for (const [label, text] of [["根 README", readme], ["plugin README", pluginReadme]]) {
  const found = [...text.matchAll(versionMentions)].map((m) => m[1]);
  const stale = found.filter((v) => v !== rootPkg.version);
  ok(
    `${label} 提到的本包版本与清单一致`,
    stale.length === 0,
    stale.length > 0 ? `发现 ${[...new Set(stale)].join(", ")}，当前 ${rootPkg.version}` : "",
  );
}

/* ------------------------------------------------------------------ */

console.log(`\n${"-".repeat(50)}`);
if (fail === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  for (const row of failures) console.log(`  · ${row}`);
}
process.exit(fail === 0 ? 0 : 1);

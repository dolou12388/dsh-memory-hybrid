/**
 * 宿主依赖解析器。
 *
 * 为什么必须有这一层：插件以 link / 源码目录方式安装时，profile 的
 * node_modules 里没有 @deepseek-ai/* 的真实包（符号链接目标不存在），
 * 静态 `import '@deepseek-ai/dsh-tools'` 会在模块加载期直接
 * ERR_MODULE_NOT_FOUND，且失败发生在 apply 之前——整个插件行变成
 * never-started，界面上什么都看不到，也无从报错。
 *
 * 官方第三方插件 dsh-purge 也踩了同一个坑，做法一致：从 dsh 包自身路径
 * 建 createRequire，向宿主借依赖。本文件即该做法的收敛实现。
 *
 * 本模块必须零静态外部依赖，否则自身就无法加载。
 */

import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const seen = (list, v) => {
  if (v && !list.includes(v)) list.push(v);
};

/** 从 dsh 可执行路径反推包根，覆盖 npm 全局 / pnpm / 便携版布局 */
function candidatesFromBin(list, bin) {
  if (!bin) return;
  const text = String(bin).replace(/\\/g, "/");
  const at = text.lastIndexOf("/node_modules/@deepseek-ai/dsh/");
  if (at >= 0) {
    seen(list, text.slice(0, at + "/node_modules/@deepseek-ai/dsh".length) + "/package.json");
  }

  const dir = dirname(text);
  // 同层 node_modules：npm 全局把 bin 放在 <prefix>/，包在 <prefix>/node_modules。
  // 这是 Windows 上最常见的布局（dsh 只是 prefix 根下的 shim）。
  seen(list, join(dir, "node_modules", "@deepseek-ai", "dsh", "package.json"));
  // npm 全局的另一种布局：argv 为 …/bin/dsh，真包在旁的 lib/node_modules
  seen(list, join(dir, "..", "lib", "node_modules", "@deepseek-ai", "dsh", "package.json"));
  seen(list, join(dir, "..", "node_modules", "@deepseek-ai", "dsh", "package.json"));
  // 便携版：bin 与 bin/node_modules 同层
  seen(list, join(dir, "lib", "node_modules", "@deepseek-ai", "dsh", "package.json"));
}

/**
 * 通过 PATH 定位 dsh 可执行文件再反推包根。
 * 为什么需要：插件进程的 process.argv[1] 可能是宿主自己的入口（甚至测试脚本），
 * 并不指向 dsh 包。此时唯一定位手段就是用户 PATH 里的 dsh。
 */
function candidatesFromPath(list) {
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(which, ["dsh"], { encoding: "utf8", timeout: 2000 });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      let real = p;
      try { real = realpathSync(p); } catch { /* 用原路径 */ }
      candidatesFromBin(list, real);
      candidatesFromBin(list, p);
    }
  } catch { /* 没装到 PATH 就算了 */ }
}

/** 收集所有可能锚点，按可靠性排序 */
function anchors(ctx) {
  const list = [];

  // 0. 显式覆盖：用户可在 profile 里设环境变量直接钉死
  const forced = process.env.DSH_MEMORY_HOST_PKG;
  if (forced && existsSync(forced)) seen(list, forced);

  // 1. 宿主注入的 ctx.baseDir（若存在）——最可靠，直指 profile 根
  for (const key of ["baseDir", "root", "cwd"]) {
    const v = ctx?.[key];
    if (typeof v === "string" && v) seen(list, join(v, "package.json"));
  }

  // 2. dsh 可执行路径
  try { candidatesFromBin(list, process.argv[1]); } catch { /* 忽略 */ }
  candidatesFromPath(list);

  // 3. DSH_HOME / ~/.dsh 下的 profile 树
  const homes = [process.env.DSH_HOME, join(homedir(), ".dsh")].filter(Boolean);
  for (const home of homes) {
    seen(list, join(home, "package.json"));
    for (const profile of ["desktop", "web", "tui", "headless", "sdk", "acp", "default"]) {
      const base = join(home, "profiles", profile);
      seen(list, join(base, "package.json"));
      seen(list, join(base, "node_modules", "@deepseek-ai", "dsh", "package.json"));
    }
    seen(list, join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json"));
  }

  // 4. 当前工作目录（开发者在本仓库内直接跑测试时命中）
  seen(list, join(process.cwd(), "package.json"));

  return list;
}

let cached = null;

/**
 * 解析并缓存一个宿主模块。
 * @param {string} spec 模块名，如 "@deepseek-ai/dsh-tools"
 * @returns {any} 模块命名空间
 * @throws 找不到时抛出带候选清单的错误
 */
export function hostRequire(spec) {
  cached ??= new Map();
  if (cached.has(spec)) return cached.get(spec);

  const tried = [];
  for (const pkg of anchors()) {
    try {
      if (!pkg || !existsSync(pkg)) continue;
      const mod = createRequire(pkg)(spec);
      cached.set(spec, mod);
      return mod;
    } catch { tried.push(pkg); }
  }

  const err = new Error(
    `dsh-memory-hybrid: 无法从宿主解析 "${spec}"。` +
    `已尝试 ${tried.length} 个锚点。请确认插件以 dependencies（而非 link）方式安装，` +
    `或在 profile 内可解析 @deepseek-ai/dsh。`,
  );
  err.code = "HOST_RESOLVE_FAILED";
  err.spec = spec;
  err.anchors = tried;
  throw err;
}

/**
 * 取模块里的具名导出，兼容 default 包装。
 *
 * 为什么要多跳一层 default：createRequire 加载 CJS 包时返回的是
 * `{ default: moduleExports, ...其他注入键 }`，具名导出往往只在 default 下。
 * zod 尤其典型——顶层有 z 但它是 interop 产物，真正的 z 在 default.z。
 */
export function hostExport(spec, name) {
  const mod = hostRequire(spec);
  const direct = mod?.[name];
  const viaDefault = mod?.default?.[name];
  // 优先 default 链路：CJS 主入口的真身在那里，顶层同名键常是残缺的 interop 投影
  const v = viaDefault ?? direct;
  if (v === undefined) {
    const err = new Error(
      `dsh-memory-hybrid: "${spec}" 未导出 "${name}"（顶层键: ${Object.keys(mod ?? {}).slice(0, 12).join(",")}）`,
    );
    err.code = "HOST_EXPORT_MISSING";
    err.spec = spec;
    err.wanted = name;
    throw err;
  }
  return v;
}

/** 探测可用性，不抛错。用于可选能力的降级判断。 */
export function hostProbe(spec) {
  try { hostRequire(spec); return true; } catch { return false; }
}

/** 清空缓存（仅测试用） */
export function resetResolver() { cached = null; }

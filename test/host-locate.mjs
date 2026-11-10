/**
 * 测试用宿主定位器。
 *
 * ## 为什么需要单独一个模块
 *
 * 所有「真实宿主装配」类测试都要 import dsh 自己的 cordis / storage 等包。
 * 早期把这些路径写死在每个测试文件里（`D:/App/NodeJS/24.16.0/...`），
 * 后果是：
 *
 *   · 换一台机器、升级 Node、用 nvm/fnm、或者把 dsh 装在 pnpm 全局 ——
 *     测试直接 ERR_MODULE_NOT_FOUND，看上去像「代码坏了」；
 *   · CI 上必然没有这个路径，所以这类测试在 CI 里等于不存在；
 *   · 路径散落在多个文件，改一次要全找一遍。
 *
 * 这里把定位逻辑收成一处，并且**复用插件自己的 `src/resolve.js`** ——
 * 它已经为运行时实现了完整的锚点搜索（PATH、DSH_HOME、profile 树、
 * ctx.baseDir）。测试与运行时共用同一套解析，就不会出现「运行时能找到、
 * 测试找不到」这种最难查的分叉。
 *
 * ## 为什么不按「@deepseek-ai 作用域目录」推导路径
 *
 * 踩过：dsh 的依赖是**嵌套**安装的 ——
 *
 *     …/node_modules/@deepseek-ai/dsh/            ← dsh 本体
 *     …/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/
 *                                                 ↑ cordis 在里面，不在外层
 *
 * 于是「从 dsh/package.json 取上级目录、再拼 cordis」会得到一个不存在
 * 的路径。正确做法是**逐包解析**：每个宿主包各自问一次解析器要路径。
 * 慢一点点（结果有缓存），但不会因为布局差异而错。
 *
 * ## 找不到时的行为
 *
 * 打印原因并 **skip**（以 0 退出），不 fail。一个没装 dsh 的环境本来就不
 * 具备跑这类测试的条件，让它变红只会训练人们忽略红色。真正该 fail 的是
 * 「dsh 装在这里但装配出错」，那种情况下 import 会真的抛。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostResolve } from "../plugin/src/resolve.js";

/** 真实宿主装配测试需要的包。缺任一即无法跑这类测试。 */
export const HOST_PACKAGES = [
  "cordis",
  "dsh-storage",
  "dsh-storage-domain",
  "dsh-storage-json",
  "dsh-tools",
];

/**
 * 定位宿主。
 *
 * @returns {{ dirOf: (name: string) => string, urlOf: (name: string, entry?: string) => string,
 *             has: (name: string) => boolean, version: string, missing: string[] } | null}
 */
export function locateHost() {
  const dirOf = (name) => dirname(hostResolve(`@deepseek-ai/${name}/package.json`));

  let dshVersion = "?";
  try {
    dshVersion = JSON.parse(readFileSync(hostResolve("@deepseek-ai/dsh/package.json"), "utf8")).version ?? "?";
  } catch { /* 未知 */ }

  const missing = [];
  for (const name of HOST_PACKAGES) {
    try {
      const d = dirOf(name);
      if (!existsSync(d)) missing.push(name);
    } catch {
      missing.push(name);
    }
  }

  const probe = (name) => {
    try { return dirOf(name); } catch { return ""; }
  };

  // 连 dsh 本体都解析不到：这台机器上根本没有可用的宿主
  if (dshVersion === "?") return null;

  return {
    dirOf,
    version: dshVersion,
    missing,
    has(name) {
      return !missing.includes(name);
    },
    /** 取某个宿主包的 ESM 入口 URL。 */
    urlOf(name, entry = "lib/index.js") {
      const d = probe(name);
      if (!d) throw new Error(`host-locate: 宿主包 ${name} 未解析到`);
      return pathToFileURL(join(d, entry)).href;
    },
  };
}

/**
 * 需要真实宿主的测试统一入口。
 *
 * @param {string} label 测试名，写进 skip 提示
 * @returns {NonNullable<ReturnType<typeof locateHost>>}
 */
export function requireHost(label) {
  const host = locateHost();
  const missing = host ? host.missing : HOST_PACKAGES;

  if (!host || missing.length > 0) {
    console.log(`\n⊘ 跳过 ${label}`);
    console.log(`  未找到宿主包：${missing.join(", ")}`);
    console.log("  该类测试需要本机安装 dsh（cordis + storage + tools 等）才能跑。");
    console.log("  宿主不在默认位置时：设置 DSH_TEST_HOST=<…/node_modules/@deepseek-ai>");
    console.log("  这不算失败 —— 该环境本来就不具备跑这类测试的条件。\n");
    process.exit(0);
  }
  return host;
}

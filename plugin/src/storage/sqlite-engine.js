/**
 * 内嵌 SQLite 引擎加载器 —— 零外部依赖。
 *
 * 为什么不用 node:sqlite：
 *   那是 Node 运行时自带的能力，可用性由**用户的 Node 版本**决定（需 ≥ 22.5）。
 *   插件要求「自带、不依赖用户系统或运行时已安装的东西」，所以必须把引擎
 *   本身打进包里。
 *
 * 为什么用 sql.js 的 wasm 产物：
 *   它是 SQLite 官方源码经 Emscripten 编译的 wasm，行为等同原生 SQLite，
 *   且 wasm 字节可以一次读入内存后通过 `wasmBinary` 传给初始化器，
 *   全程不触发任何文件查找或网络请求 —— 这正是「自带」的关键。
 *
 * 为什么改名为 .cjs：
 *   本包 package.json 是 "type": "module"，而 sql-wasm.js 是 UMD（CJS）格式。
 *   同名 .js 会被 Node 按 ESM 解析，`module.exports` 不生效，require 拿到的是
 *   一个空对象。改扩展名为 .cjs 才能让 Node 正确按 CommonJS 加载。
 *
 * 关于「内存库 + 导出落盘」的取舍：
 *   sql.js 没有文件系统层，整个库常驻内存。持久化靠 `db.export()` 拿完整字节
 *   再落盘。实测 1 万条记录（约 2.5MB）export 只需 1ms，因此每次写入后落盘
 *   是可接受的。代价是进程崩溃会丢失最后一次落盘之后的数据 —— 用
 *   write-ahead 的 journal 记录补偿（见 journal.js 的重放逻辑）。
 */

import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** wasm 与加载器的实际路径。相对本文件定位，不依赖 cwd 或包名解析。
 *
 *  本文件在 src/storage/，vendor 在包根，因此要退两级 ——
 *  写成 ../vendor 会指向 src/vendor（不存在），错误只会在运行时才暴露。 */
const VENDOR = new URL("../../vendor/sqlite/", import.meta.url);

let enginePromise = null;

/**
 * 加载并初始化内嵌 SQLite。
 *
 * 单例：wasm 初始化约 100~300ms，每次创建后端都重来一次是浪费。
 * 若初始化失败，清空缓存以便下次重试（比如文件被临时锁定）。
 *
 * @returns {Promise<{Database: Function}>} sql.js 模块命名空间
 */
export async function loadSqlite() {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    const loaderPath = fileURLToPath(new URL("sql-wasm.cjs", VENDOR));
    const wasmPath = fileURLToPath(new URL("sql-wasm.wasm", VENDOR));

    if (!existsSync(loaderPath)) {
      throw new Error(`memory: 内嵌 sqlite 加载器缺失（${loaderPath}）`);
    }
    if (!existsSync(wasmPath)) {
      throw new Error(`memory: 内嵌 sqlite wasm 缺失（${wasmPath}）`);
    }

    // UMD 产物：require 得到的是 initSqlJs 函数本身；
    // 某些打包器会包一层 default，两种都兼容。
    const mod = require(loaderPath);
    const initSqlJs = typeof mod === "function" ? mod : mod?.default;
    if (typeof initSqlJs !== "function") {
      throw new Error("memory: 内嵌 sqlite 加载器导出异常（既不是函数也没有 default）");
    }

    // 关键：把 wasm 字节直接喂进去，避免 emscripten 去 fs 里找 .wasm 文件。
    // 这一步让「插件自带引擎」成立 —— 不查路径、不联网、不读系统目录。
    const wasmBinary = readFileSync(wasmPath);

    const SQL = await initSqlJs({
      wasmBinary,
      // 不要落任何文件：sql.js 默认可能写 .data 之类的缓存
      noInitialRun: true,
      print: () => {},
      printErr: () => {},
    });

    if (!SQL?.Database) {
      throw new Error("memory: 内嵌 sqlite 初始化失败（无 Database 构造器）");
    }
    return SQL;
  })();

  try {
    return await enginePromise;
  } catch (e) {
    enginePromise = null; // 允许重试
    throw e;
  }
}

/**
 * 探测内嵌引擎是否可用。不抛错。
 * 与「检测用户系统有无 sqlite」完全不同 —— 这里检查的是插件自带的文件。
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function available() {
  try {
    await loadSqlite();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

/** 仅供测试：重置单例 */
export function resetEngine() {
  enginePromise = null;
}

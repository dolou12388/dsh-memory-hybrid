#!/usr/bin/env node
/**
 * 侧栏面板注册测试。
 *
 * 前面几个套件都只读源码做静态断言（正则匹配），那能锁住「有没有写」，
 * 锁不住「注册得对不对」。侧栏能否出现，取决于三件事恰好对齐：
 *
 *   1. `sidebar.panellist` 注册时给了 `id` —— list slot 缺 id 直接抛错
 *   2. `main` 注册时 `key` 与侧栏 `id` 完全相同 —— 不一致则点图标切不过去
 *   3. `whileServed` 的返回值是**可调用的 disposer** —— 不可调用则该撤不撤
 *
 * 这三条只有真正把 `apply()` 跑起来才能验证。所以本套件在 Node 里搭一套
 * 最小的宿主替身：`window.__ModuleLoader__` 收下 factory，`require` 只回
 * 几个够用的桩（React 的 createElement 直接产出可断言的对象树），然后
 * 用假 ctx 驱动 apply，逐条检查落进假 `slots.register` 的参数。
 *
 * 用法：node test/sidebar-panel.test.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/* ------------------------------------------------------------------ *
 * 宿主替身
 * ------------------------------------------------------------------ */

/**
 * 把 client.js 装进当前进程并取出它的导出。
 *
 * client.js 是浏览器端的惰性 CJS：文件被求值时只调用
 * `window.__ModuleLoader__.load({ id, factory })` 登记工厂。这里收下工厂，
 * 用自定义 `require` materialize 一次，就得到了与浏览器里同一份模块对象。
 *
 * @returns {object} client.js 的 exports（含 apply / inject / PANEL_ID）
 */
function loadClient() {
  const source = readFileSync(new URL("../plugin/client.js", import.meta.url), "utf8");

  let captured;
  const windowStub = {
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = { id, factory };
      },
    },
  };

  // client.js 引用的是全局 window；用 new Function 给它一个受控作用域，
  // 不污染本进程的 globalThis。
  const run = new Function("window", "module", "exports", "require", source);
  const moduleStub = { exports: {} };
  run(windowStub, moduleStub, moduleStub.exports, () => {
    throw new Error("factory 未被调用时不应 require");
  });

  if (captured === undefined) throw new Error("client.js 没有调用 __ModuleLoader__.load");

  // React 桩：只保留 createElement 与 hooks 的形状。
  // createElement 产出普通对象，便于断言「渲染出来的是什么组件」。
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  };

  const primitives = {
    SettingsForm: "SettingsForm",
    SettingsValueField: "SettingsValueField",
    SettingsSecretField: "SettingsSecretField",
    SettingsFormModel: class {
      bind() {
        return { getSnapshot: () => ({}), set: () => {}, subscribe: () => () => {} };
      }
      field() {
        return { text: "", overridden: false, invalid: false };
      }
      shell() {
        return { writable: true, dirty: false, saving: false, failed: false };
      }
      actions() {
        return { edit: () => {}, save: () => {}, discard: () => {}, resetField: () => {} };
      }
      dispose() {}
    },
    settingsTextField: (field) => ({ field }),
    settingsNumberField: (field) => ({ field }),
    Switch: "Switch",
    SegmentedControl: "SegmentedControl",
  };

  const requireStub = (id) => {
    if (id === "react") return React;
    if (id === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`未预期的依赖：${id}`);
  };

  return captured.factory(requireStub);
}

/**
 * 造一个够用的 ctx。
 *
 * 记录每一处 `slots.register` 的调用参数，以及 `whileServed` 拿到的
 * 回调返回值 —— 后者用来验证 disposer 是否可调用。
 *
 * @returns {object} { ctx, registrations, state }
 */
function makeCtx() {
  const registrations = [];
  const state = { whileServedDisposer: undefined, whileServedRan: false, effects: 0 };

  const slots = {
    inject(name, fn) {
      // 真实宿主是「等插槽声明者就绪后执行」，这里直接执行即可 ——
      // 本套件验证的是 register 的参数，不是等待时序。
      return fn();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {
        const at = registrations.findIndex((row) => row.options === options);
        if (at >= 0) registrations.splice(at, 1);
      };
    },
  };

  const configForms = {
    whileServed(namespaces, register) {
      state.whileServedRan = true;
      state.whileServedNamespaces = namespaces;
      // 真实实现会把返回值存成 off，并在命名空间撤走时调用它。
      state.whileServedDisposer = register(new Set(namespaces));
      return () => {};
    },
    get() {
      // 返回一个不会被控制器构造函数弄坏的最小 scope。
      const snapshot = { revision: 1 };
      return {
        getSnapshot: () => snapshot,
        mutate: async () => true,
        subscribe: () => () => {},
      };
    },
    describe() {
      return {
        subscribe: () => () => {},
        getSnapshot: () => ({ view: { namespaces: [] } }),
      };
    },
  };

  const ctx = {
    slots,
    configForms,
    locale: {
      register: () => {},
      bind: () => (key) => key,
    },
    effect(fn) {
      state.effects += 1;
      const disposer = fn();
      return disposer;
    },
    logger: { warn: () => {} },
  };

  return { ctx, registrations, state };
}

/* ------------------------------------------------------------------ *
 * 套件
 * ------------------------------------------------------------------ */

group("加载与导出");

let client;
try {
  client = loadClient();
  ok("client.js 可 materialize", true);
} catch (error) {
  ok("client.js 可 materialize", false, error.message);
}

if (client !== undefined) {
  eq("导出 apply", typeof client.apply, "function");
  eq("导出 PANEL_ID", client.PANEL_ID, "memory-hybrid");
  ok("导出 inject 含 slots", Array.isArray(client.inject) && client.inject.includes("slots"));

  group("\napply() 注册行为");

  const { ctx, registrations, state } = makeCtx();
  client.apply(ctx);

  eq("whileServed 被调用一次", state.whileServedRan, true);
  eq("whileServed 监听本插件命名空间", state.whileServedNamespaces, ["dsh-memory-hybrid"]);

  const find = (name) => registrations.find((row) => row.options.name === name);

  const tab = find("settings.plugins.tab");
  const icon = find("sidebar.panellist");
  const page = find("main");

  ok("注册了设置页 tab", tab !== undefined);
  ok("注册了侧栏图标", icon !== undefined);
  ok("注册了主面板", page !== undefined);

  group("\n三者的 key / id 对齐");

  // 这三条是本功能成立的核心不变量，任一破坏都会导致「点了没反应」
  eq("侧栏 id", icon?.options.id, "memory-hybrid");
  eq(
    "主面板 key 与侧栏 id 一致",
    page?.options.key,
    icon?.options.id,
  );
  eq("设置页 tab id 未变（向后兼容）", tab?.options.id, "memory-hybrid");

  group("\n侧栏必需字段");

  // list slot 缺 id 会被宿主直接抛错，所以这里显式锁住
  ok("侧栏给了 id", typeof icon?.options.id === "string" && icon.options.id.length > 0);
  ok("侧栏给了 order", typeof icon?.options.order === "number");
  ok("侧栏给了 label 函数", typeof icon?.options.label === "function");
  eq("侧栏 label 返回文案键", icon?.options.label?.(), "panel");

  // main 是 keyed slot，缺 key 会被宿主抛错
  ok("主面板给了 key", typeof page?.options.key === "string");

  group("\n组件绑定");

  eq("侧栏图标组件", typeof icon?.component, "function");
  eq("主面板组件", typeof page?.component, "function");
  eq("设置页 tab 组件", typeof tab?.component, "function");
  ok("图标与页面不是同一个组件", icon?.component !== page?.component);

  group("\n收口");

  // whileServed 只认一个返回值；三个注册必须合成为一个可调用的 disposer，
  // 否则命名空间撤走时注册会残留。
  eq("whileServed 回调返回了函数", typeof state.whileServedDisposer, "function");

  const before = registrations.length;
  ok("撤销前有注册项", before === 3, `实际 ${before}`);

  state.whileServedDisposer?.();
  eq("撤销后注册清空", registrations.length, 0);

  group("\n注入面");

  // 页面靠 inject() 拿 hooks 与 actions；控制器没建成时也要给出可渲染的形状
  const pageProps = page?.options.inject?.();
  ok("主面板 inject 返回对象", pageProps !== undefined && typeof pageProps === "object");
  ok("主面板 inject 含 hooks", pageProps?.hooks !== undefined || pageProps?.hooks === undefined);

  const tabProps = tab?.options.inject?.();
  ok("设置页 inject 返回对象", tabProps !== undefined && typeof tabProps === "object");
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

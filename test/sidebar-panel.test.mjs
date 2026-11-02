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
        // 必须与真实 primitives 的 SettingsFormModel.shell() 一致
        // （dsh-client-ui-primitives:7190）—— 少一个字段，卡片就会按错误
        // 形状渲染，测试也就测不出「available 恒为 false」这类问题。
        return {
          available: true,
          writable: true,
          dirty: false,
          invalid: false,
          saving: false,
          failed: false,
        };
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
 * `ctx.inject` 按真实语义实现：服务在 `state.provided` 里就立即给一个
 * child（带该服务的复制 ctx）并执行回调；不在就一直等。`state.provide()`
 * 用于测试中途投递服务，模拟「configForms 迟到」。
 *
 * @param {object} [options]
 * @param {boolean} [options.withConfigForms] 初始就提供 configForms
 * @returns {object} { ctx, registrations, state }
 */
/**
 * `ctx.remote` 的最小桩：只实现本插件用到的那两个 RPC。
 *
 * `describe` 回一份含本命名空间的文档，`mutate` 回写后的视图 —— 与
 * `dsh-api-settings-controller` 的真实回答结构一致
 * （`{writable, hasDocument, namespaces:[...]}` / 单个 namespaceView）。
 *
 * 放在 makeCtx 外面是因为「非 loopback」那组测试要直接把它喂给 RemoteScope，
 * 不经过 apply()。
 *
 * @param {object} [options]
 * @param {string} [options.status] 让 describe 回 ok:false 以模拟通道故障
 * @returns {object} { settings: { describe, mutate } }
 */
function makeRemote({ status = "ok" } = {}) {
  return {
    settings: {
      describe: async () => {
        if (status === "fail") return { ok: false, error: { message: "boom" } };
        return {
          ok: true,
          value: {
            writable: true,
            hasDocument: true,
            namespaces: [
              {
                ns: "dsh-memory-hybrid",
                value: { recallLimit: 6 },
                base: {},
                user: {},
                revision: 1,
                secrets: [{ path: ["embedApiKey"], set: false }],
              },
            ],
          },
        };
      },
      mutate: async () => ({
        ok: true,
        value: {
          ns: "dsh-memory-hybrid",
          value: { recallLimit: 6 },
          base: {},
          revision: 2,
          secrets: [{ path: ["embedApiKey"], set: false }],
        },
      }),
    },
  };
}

function makeCtx({ withConfigForms = true } = {}) {
  const registrations = [];
  const state = {
    whileServedDisposer: undefined,whileServedRan: false,
    effects: 0,
    /** 已提供但尚未抵达 inject 回调的条件 */
    pending: [],
    /** 当前已提供的服务名 */
    provided: new Set(),
  };

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

  const remoteStub = makeRemote();
  const services = {
    slots,
    locale: {},
    configForms,
    remote: remoteStub,
    // 独立服务名，与真实 cordis 一致
    "remote.settings": remoteStub.settings,
  };
  if (withConfigForms) state.provided.add("configForms");
  // remote 是宿主的基础服务，真实部署里始终在场；本插件只把它当软依赖读
  state.provided.add("remote");
  state.provided.add("remote.settings");

  /**
   * 把 ctx 变成「已提供某服务」的 child。
   *
   * 真实 cordis 的语义有两层，这里都要模拟，否则测不出真问题：
   *
   *   1. inject 回调拿到的 child 上能**直接**访问已声明的服务
   *   2. 访问**未声明**的服务名会抛 `cannot get property "X" without inject`
   *      （`cordis/lib/index.js:676`）
   *
   * 第 2 条是 0.2.3 第一版翻车的原因：`remote.settings` 是按命名空间注册的
   * 独立服务名，只声明 `remote` 时读 `ctx.remote.settings` 会当场抛错。桩里
   * 若让 `child.remote.settings` 随便就能读到，这个 bug 就永远测不出来。
   */
  const makeChild = (parent, names) => {
    const base = {
      locale: parent.locale,
      slots: parent.slots,
      effect: parent.effect,
      logger: parent.logger,
      inject: parent.inject,
      get: parent.get,
    };

    /**
     * `remote` 也做成 proxy：`remote.settings` 在真实 cordis 里是独立服务名
     * （`remote.settings`），读它同样要过 inject 门禁。若这里直接返回一个
     * 普通对象，`child.remote.settings` 就永远能读到 —— 那个坑测不出来。
     */
    const remoteProxy = new Proxy({}, {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        const full = `remote.${String(prop)}`;
        if (names.includes(full)) return services[full];
        // 声明了父级但没声明子级时，真实 cordis 抛的正是这句
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    });

    // 用 proxy 复现 inject 门禁：未声明的属性直接抛
    return new Proxy(base, {
      get(target, prop) {
        if (typeof prop === "symbol" || prop.startsWith("_")) return Reflect.get(target, prop);
        if (Reflect.has(target, prop)) return Reflect.get(target, prop);
        if (!names.includes(prop)) {
          throw new Error(`cannot get property "${String(prop)}" without inject`);
        }
        if (prop === "remote") return remoteProxy;
        // overrideConfigForms 只顶替 configForms，不能污染其它服务
        return prop === "configForms"
          ? (state.overrideConfigForms ?? services[prop])
          : services[prop];
      },
      has(target, prop) {
        return Reflect.has(target, prop) || names.includes(prop);
      },
    });
  };

  const ctx = {
    slots,
    locale: {
      register: () => {},
      bind: () => (key) => key,
    },
    // 软依赖读法：未提供就是 undefined，不抛错
    get(name) {
      return state.provided.has(name) ? services[name] : undefined;
    },
    /**
     * 真实语义：等 names 全部就绪后调用 cb(child)；就绪前什么都不做。
     * 这里记下未满足的回调，供 state.provide() 在测试中途触发。
     */
    inject(names, cb) {
      const ready = names.every((name) => state.provided.has(name));
      if (ready) {
        cb(makeChild(ctx, names));
        return;
      }
      state.pending.push({ names, cb, parent: ctx });
    },
    effect(fn) {
      state.effects += 1;
      const disposer = fn();
      return disposer;
    },
    logger: { warn: () => {} },
  };

  /** 测试用：投递一个服务，并唤醒等待它的 inject 回调。 */
  state.provide = (name) => {
    state.provided.add(name);
    const arrived = state.pending.filter((row) => row.names.includes(name));
    state.pending = state.pending.filter((row) => !row.names.includes(name));
    for (const row of arrived) {
      if (row.names.every((n) => state.provided.has(n))) {
        row.cb(makeChild(row.parent, row.names));
      }
    }
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

  group("\n顶层 inject 只声明硬依赖");

  // 这是本次事故的核心回归点。把 configForms 写进顶层 inject 会让 cordis
  // 在它缺席时**连 apply 都不调** —— 侧栏、主面板、tab 一起消失，而且
  // 不报错不打日志。configForms 必须是软依赖（ctx.inject / ctx.get）。
  ok("inject 含 slots", client.inject?.includes("slots"));
  ok("inject 含 locale", client.inject?.includes("locale"));
  ok(
    "inject 不含 configForms（它必须走软依赖，否则整个插件会被硬门禁挡住）",
    !client.inject?.includes("configForms"),
  );

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

  // 关键结构：侧栏两处无条件注册（侧栏不关心配置能否写），设置页 tab
  // 由它自己的 ctx.inject + whileServed 两层守卫管。早期版本把三处全包进
  // whileServed，命名空间未被服务时整个 UI 都不出现 —— 这就是「装了插件
  // 但左侧没入口」的根因之一；把 configForms 写进顶层 inject 是同一个病的
  // 另一种形态。
  eq("whileServed 回调返回了函数", typeof state.whileServedDisposer, "function");

  const before = registrations.length;
  ok("初始有 3 个注册项", before === 3, `实际 ${before}`);

  state.whileServedDisposer?.();
  // 撤掉 whileServed 只应收回 tab，侧栏两处仍在 —— 它们不受命名空间影响
  eq("撤 tab 守卫后侧栏两处仍在", registrations.length, 2);

  const stillIcon = registrations.find((row) => row.options.name === "sidebar.panellist");
  const stillPage = registrations.find((row) => row.options.name === "main");
  ok("侧栏图标未受影响", stillIcon !== undefined);
  ok("主面板未受影响", stillPage !== undefined);
  ok(
    "设置页 tab 已被收回",
    registrations.find((row) => row.options.name === "settings.plugins.tab") === undefined,
  );

  group("\n命名空间未被服务时侧栏仍要出现");

  // 回归点一：whileServed 静默不触发（命名空间没被服务）时，侧栏图标与
  // 主面板必须照旧注册，否则「左侧没入口」重演。
  {
    const bare = makeCtx();
    // 把这个 ctx 的 whileServed 改成「永不触发」—— 模拟命名空间未被服务
    const cfg = { ...bare.ctx.get("configForms") };
    cfg.whileServed = (namespaces, register) => {
      bare.state.whileServedRan = true;
      bare.state.whileServedDisposer = undefined; // 回调根本没跑
      return () => {};
    };
    // 让 child 拿到这个不会触发的 whileServed
    bare.state.overrideConfigForms = cfg;
    client.apply(bare.ctx);

    const hasIcon = bare.registrations.some((row) => row.options.name === "sidebar.panellist");
    const hasPage = bare.registrations.some((row) => row.options.name === "main");
    const hasTab = bare.registrations.some((row) => row.options.name === "settings.plugins.tab");

    ok("whileServed 未触发", bare.state.whileServedRan === true);
    ok("侧栏图标照样注册", hasIcon);
    ok("主面板照样注册", hasPage);
    ok("设置页 tab 被正确抑制（它确实依赖命名空间）", hasTab === false);
  }

  group("\nconfigForms 完全缺席（软依赖降级）");

  // 回归点二 —— 本次事故的真正根因形态。configForms 服务不存在时：
  //   · apply 必须照常执行完（顶层 inject 不含它）
  //   · 侧栏图标与主面板必须注册
  //   · 设置页 tab 不注册（它真的离不开表单）
  //   · 全程不抛错
  {
    const soft = makeCtx({ withConfigForms: false });
    let threw;
    try {
      client.apply(soft.ctx);
    } catch (error) {
      threw = error;
    }

    ok("configForms 缺席时 apply 不抛错", threw === undefined, threw?.message);

    const hasIcon = soft.registrations.some((row) => row.options.name === "sidebar.panellist");
    const hasPage = soft.registrations.some((row) => row.options.name === "main");
    const hasTab = soft.registrations.some((row) => row.options.name === "settings.plugins.tab");

    ok("侧栏图标必须注册（这是左侧入口）", hasIcon);
    ok("主面板必须注册", hasPage);
    ok("设置页 tab 不注册", hasTab === false);
    // 两个 ctx.inject 在等：tab（configForms）与升级（configForms+remote）。
    // 控制器那一个等的是 remote，而 remote 始终在场，所以不会挂起。
    ok(
      "configForms 的就绪回调被挂起等待",
      soft.state.pending.length === 2,
      `实际挂起 ${soft.state.pending.length} 个`,
    );

    // 后续 configForms 到达，tab 应该补上，侧栏不受影响
    soft.state.provide("configForms");
    const tabLater = soft.registrations.some((row) => row.options.name === "settings.plugins.tab");
    const iconStill = soft.registrations.some((row) => row.options.name === "sidebar.panellist");
    ok("configForms 迟到后 tab 补注册", tabLater);
    ok("侧栏图标始终在", iconStill);
  }

  group("\n非 loopback 页面：宿主 scope 永不就绪时必须自立");

  // 这是 0.2.3 修的那个 bug 的回归位。
  //
  // 用公网 IP / 域名打开页面时，宿主的 ConfigFormController 拿到
  // `persistence = "memory"`，其 status 恒为 "unavailable" 且永不订阅镜像，
  // 于是 SettingsFormModel.shell() 的 `available` 永远 false，卡片稳定显示
  // 「该插件当前未加载，暂时无法配置。」—— 但插件明明在跑。
  //
  // 修法：控制器发现宿主 scope 的 mode 是 "memory" 时，换成自建的
  // RemoteScope（只走 remote.settings）。
  {
    const memoryScope = {
      getSnapshot: () => ({
        status: "unavailable",
        value: undefined,
        revision: undefined,
        writable: false,
        mode: "memory",
      }),
      mutate: async () => false,
      subscribe: () => () => {},
    };

    // 直接验判据：memory 判死，其余放行
    ok(
      "mode=memory 的宿主 scope 判定为不可用",
      client.isScopeServable(memoryScope) === false,
    );
    ok(
      "status=ready 的宿主 scope 判定为可用",
      client.isScopeServable({ getSnapshot: () => ({ status: "ready", mode: "host" }) }) === true,
    );
    ok(
      "status=loading 且 mode=host 仍在路上，不判死",
      client.isScopeServable({ getSnapshot: () => ({ status: "loading", mode: "host" }) }) === true,
    );
    ok(
      "getSnapshot 抛错的 scope 判定为不可用",
      client.isScopeServable({ getSnapshot: () => { throw new Error("boom"); } }) === false,
    );

    // 端到端：自建 scope 能从 Host 读到本命名空间并落到 ready
    const scope = new client.RemoteScope({ logger: {} }, client.NS, makeRemote().settings);
    ok("自建 scope 的 mode 是 remote", scope.getSnapshot().mode === "remote");
    ok("自建 scope 初始为 loading", scope.getSnapshot().status === "loading");

    // describe 是异步的，等它落地
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = scope.getSnapshot();
    ok("describe 落地后 status=ready", after.status === "ready", `实际 ${after.status}`);
    ok("status=ready 正是 SettingsFormModel.shell() 判 available 的条件", after.status === "ready");
    ok("读到了 value", after.value?.recallLimit === 6);
    ok("writable 跟随 Host", after.writable === true);

    // 变更要通知订阅者，否则界面不会重绘
    let notified = 0;
    scope.subscribe(() => { notified += 1; });   // 订阅本身会立即回调一次
    ok("订阅时立即回调一次（这是 tab 探测能成立的前提）", notified === 1, `实际 ${notified}`);
    await scope.load();
    ok("重新 load 再通知一次", notified === 2, `实际 ${notified}`);

    scope.dispose();
  }

  group("\n非 loopback：设置页 tab 靠 RPC 探测补上");

  // whileServed 依赖 describe 镜像，而镜像在 memory 下永不加载 —— 若不换路，
  // tab 在公网访问时也不会出现。这一组验证「换成 RPC 探测」这条路真的注册了。
  {
    const mem = makeCtx();
    const cfg = { ...mem.ctx.get("configForms") };
    // 宿主 scope 永远 unavailable + memory
    cfg.get = () => ({
      getSnapshot: () => ({ status: "unavailable", writable: false, mode: "memory" }),
      mutate: async () => false,
      subscribe: () => () => {},
    });
    // whileServed 永不触发，模拟镜像不加载
    cfg.whileServed = () => () => {};
    mem.state.overrideConfigForms = cfg;

    client.apply(mem.ctx);
    // RPC 探测是异步的，等它落地
    await new Promise((resolve) => setTimeout(resolve, 10));

    const hasTab = mem.registrations.some((row) => row.options.name === "settings.plugins.tab");
    const hasIcon = mem.registrations.some((row) => row.options.name === "sidebar.panellist");
    ok("memory 下 tab 通过 RPC 探测注册成功", hasTab, "未注册说明探测路径没跑通");
    ok("sidebar 不受影响", hasIcon);
  }

  group("\n设置通道的取用方式");

  // 关于 `remote.settings` 的实测结论（在真实 cordis 上验过，别照抄网上的说法）：
  //
  //   · 在**插件 ctx** 里直接 `ctx.remote` 会抛
  //     `cannot get property "remote" without inject`
  //   · `ctx.get("remote.settings")` 与 `ctx.get("remote").settings` 都能拿到
  //   · 声明了 `remote` 之后，`child.remote.settings` 也可用
  //
  // 所以 `inject` 里写两件是**防御性**的（与官方 `dsh-client-ui-settings` 一致），
  // 但真正的取用入口必须是 `ctx.get(...)` —— 它「不受 inject 约束」
  // （cordis:763），apply 里能同步拿到，不受时序影响。
  {
    const src = readFileSync(new URL("../plugin/client.js", import.meta.url), "utf8");

    ok(
      "apply 里用 ctx.get 同步取 settings",
      src.includes('anyCtx.get?.("remote.settings")'),
      "同步取不到才会退到异步 inject，否则控制器晚建、hooks 被 useMemo 钉死",
    );
    ok(
      "有 remote.settings 的兼容读法",
      src.includes('anyCtx.get?.("remote")?.settings'),
    );
    ok(
      "inject 里两件都声明（与官方一致）",
      src.includes('ctx.inject(["remote", "remote.settings"]'),
    );
    ok(
      "升级分支声明了 configForms + remote.settings",
      src.includes('ctx.inject(["configForms", "remote", "remote.settings"]'),
    );
    ok(
      "代码里不再用裸 ctx.remote 取服务（会抛 without inject）",
      // 只看非注释行：注释里提这个写法是为了解释为什么不这么写
      !src.split("\n").some((line) => {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
        return /ctx\.remote\.settings/.test(code);
      }),
    );

    // 桩本身也要有门禁能力
    const probeCtx = makeCtx();
    let threw = false;
    try {
      probeCtx.ctx.inject(["remote"], (child) => {
        void child.remote.settings;
      });
    } catch {
      threw = true;
    }
    ok("桩对未声明的服务名会抛错（复现 cordis 门禁）", threw);
  }

  group("\n注入面");

  // bridge 的意义：宿主的 useMemo 会把 `inject()` 的返回值按
  // `[actions, definition, scopeBinding]` 固化（renderer:1000），所以注入面
  // 里的 hooks 必须是**稳定对象**，否则控制器晚建就永远注不进去。
  {
    const snap = page?.options.inject?.();
    const second = page?.options.inject?.();
    ok("主面板 inject 返回对象", snap !== undefined && typeof snap === "object");
    ok(
      "两次调用返回同一个 memoryCard source（hook 才能稳定）",
      snap?.hooks?.memoryCard === second?.hooks?.memoryCard,
      "每次新建 source 会让 observableHook 的 WeakMap 缓存失效",
    );
    ok(
      "source 具备 getSnapshot / subscribe（absentSource 的契约）",
      typeof snap?.hooks?.memoryCard?.getSnapshot === "function" &&
        typeof snap?.hooks?.memoryCard?.subscribe === "function",
    );
    ok(
      "初始快照形状完整（缺字段会在渲染中途炸）",
      (() => {
        const s = snap?.hooks?.memoryCard?.getSnapshot();
        return (
          s !== undefined &&
          "available" in s && "writable" in s && "secrets" in s && "diagnostics" in s
        );
      })(),
    );
    ok(
      "动作是代理而非首帧绑定（控制器后建也能用）",
      typeof snap?.edit === "function" && typeof snap?.save === "function",
    );
  }
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

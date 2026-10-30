/**
 * 「设置 → 插件 → 记忆」配置页的浏览器端实现。
 *
 * ## 为什么需要这一份代码
 *
 * 宿主的 `dsh-settings` 会按插件 Config schema 产出表单**数据**（describe 返回
 * schema / 值 / revision），但没有任何组件把它渲染成界面。想让人在界面上改
 * 配置，必须自己往设置页的插槽注册一个页面 —— 本文件就是那一步。
 *
 * ## 两个前置条件，缺一条页面就不会出现
 *
 * 1. **Config 的每个字段都要 `.volatile()`**（在 `src/index.js` 里）。
 *    宿主 `describe()` 先用 `volatileForm(schema)` 过滤，只留标了 volatile 的
 *    字段；一个都没标时返回 `undefined`，整个条目被跳过，且**不报错**。
 * 2. `package.json` 要声明 `dsh.client` 且 `exports["./client"]` 指向本文件。
 *    宿主的 client-modules 靠这个把本文件编进启动图（走 combo URL）。
 *
 * ## 宿主已提供的构件（不重写）
 *
 * `dsh-client-ui-primitives` 的 `settings-form` 已把表单该有的一切做好：
 *
 *   · `SettingsFormModel` —— 暂存草稿、只在保存时写、revision 围栏、
 *     「是否覆盖了默认值」的判定、保存失败保留草稿
 *   · `SettingsValueField` / `SettingsSecretField` —— 文本/数字/密钥控件；
 *     密钥控件只显示「已配置」，永远拿不到明文
 *   · `SettingsForm` —— 外壳：只读提示、保存按钮、失败提示
 *
 * 所以本文件只做四件事：取到本命名空间的配置表单、声明字段及转换规则、
 * 用 `bind()` 把状态投影成可订阅的 store、把它摆进 `SettingsForm`。
 *
 * ## 模块格式
 *
 * 必须是 `window.__ModuleLoader__.load({ id, factory })` 的惰性 CJS 形态：
 * 执行脚本时只登记工厂，materialize 发生在首次 require。所有副作用都写在
 * factory 闭包里。
 */

window.__ModuleLoader__.load({
  id: "dsh-memory-hybrid",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require("react");

    const {
      SettingsForm,
      SettingsValueField,
      SettingsSecretField,
      SettingsFormModel,
      settingsTextField,
      settingsNumberField,
      Switch,
      SegmentedControl,
    } = require("@deepseek-ai/dsh-client-ui-primitives");

    const h = React.createElement;

    /**
     * 设置命名空间 = 插件在 profile 里的条目 id。
     * 与 `src/index.js` 里 `cordis.patch.yml` 的 `id: dsh-memory-hybrid` 一致。
     */
    const NS = "dsh-memory-hybrid";

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */

    const zh = {
      tab: "记忆",
      title: "长期记忆",
      description: "记忆插件的全部配置。",

      sectionRecall: "召回",
      sectionEmbed: "嵌入模型（语义召回）",
      sectionStore: "存储",
      sectionOther: "其它",

      autoRecall: "启用自动召回",
      autoRecallHint: "开：每轮对话自动把相关记忆注入上下文。关：只能靠 memory_recall 工具主动翻。",
      recallLimit: "每次注入条数",
      recallLimitHint: "默认 6。条数越多上下文越长，建议不超过 10。",
      contextOrder: "注入段排序",
      contextOrderHint: "在系统提示里的位置，默认 10500。一般不用改。",

      embedSource: "嵌入来源",
      embedSourceHint: "inherit = 沿用当前 dsh 客户端的地址与模型；custom = 在下面自己填；off = 关闭语义召回，退回字面匹配。",
      embedSourceInherit: "继承当前客户端",
      embedSourceCustom: "自己填",
      embedSourceOff: "关闭",
      embedBaseURL: "API 地址",
      embedBaseURLHint: "形如 https://api.example.com/v1，不要带 /embeddings。仅在「custom」下生效。",
      embedApiKey: "API Key",
      embedApiKeyHint: "只写不回显。留空表示不修改已保存的密钥。",
      embedModel: "模型 id",
      embedModelHint: "嵌入模型，例如 bge-m3、text-embedding-3-small。它和对话用的生成模型不是同一类。",
      embedInheritNote: "注意：继承来的通常是生成模型，多半没有 /embeddings 接口。要真正启用语义召回，请改为 custom 并填一个嵌入模型。",

      dim: "向量维度",
      dimHint: "改动会使现有索引失效。索引可重建，记忆数据不受影响。",
      storageMode: "存储后端",
      storageModeHint: "auto = 优先自带 sqlite，失败退回 profile 路由；sqlite = 强制；json = 沿用 profile。改动需重启 dsh 才真正切换。",
      storageModeAuto: "自动",
      storageModeSqlite: "强制 sqlite",
      storageModeJson: "跟随 profile",
      sqliteFile: "sqlite 库路径",
      sqliteFileHint: "留空则用 ~/.dsh/storages/memory_hybrid.sqlite。改动需重启 dsh。",

      jevEndpoint: "Jev 判别端点",
      jevEndpointHint: "留空则只用内置规则判档。要启用，填 https://api.typesafe.ai/v1/systemone。端点和密钥都填齐才会走 Jev。",
      jevApiKey: "Jev 密钥",
      jevApiKeyHint: "TypeSafe 的 API Key（tsf_ 开头），在 console.typesafe.ai 创建。只写不回显，留空表示不修改。",
      jevModel: "Jev 模型",
      jevModelHint: "默认 jev-1.14.0（已钉版本）。改成 jev-latest 会随官方发版漂移。",
      sweepOnStart: "启动时结算扫描",
      sweepOnStartHint: "开：启动即按衰减规则处理一次遗忘/降级。",
      verbose: "调试日志",
      verboseHint: "打开后输出 debug 级别日志。",

      save: "保存",
      saving: "保存中…",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      readOnly: "本部署的设置为只读。",
      unavailable: "该插件当前未加载，暂时无法配置。",
      overridden: "已覆盖",
      reset: "恢复默认",
      invalidNumber: "请填数字；留空表示使用默认值。",
      configured: "已配置",
      notConfigured: "未配置",
    };

    const en = {
      tab: "Memory",
      title: "Long-term memory",
      description: "Every setting for the memory plugin.",

      sectionRecall: "Recall",
      sectionEmbed: "Embedding model (semantic recall)",
      sectionStore: "Storage",
      sectionOther: "Other",

      autoRecall: "Automatic recall",
      autoRecallHint: "On: relevant memories are injected into every turn. Off: only the memory_recall tool reaches them.",
      recallLimit: "Items per injection",
      recallLimitHint: "Default 6. More items cost more context; 10 is a practical ceiling.",
      contextOrder: "Injection order",
      contextOrderHint: "Position in the system prompt, default 10500. Rarely needs changing.",

      embedSource: "Embedding source",
      embedSourceHint: "inherit = reuse the current dsh client endpoint and model; custom = fill in below; off = disable semantic recall.",
      embedSourceInherit: "Inherit client",
      embedSourceCustom: "Custom",
      embedSourceOff: "Off",
      embedBaseURL: "API base URL",
      embedBaseURLHint: "Like https://api.example.com/v1 — do not append /embeddings. Used when the source is custom.",
      embedApiKey: "API key",
      embedApiKeyHint: "Write-only. Leave blank to keep the stored key.",
      embedModel: "Model id",
      embedModelHint: "An embedding model such as bge-m3 or text-embedding-3-small; not the generative chat model.",
      embedInheritNote: "Note: an inherited model is usually a generative one with no /embeddings endpoint. Switch to custom and name an embedding model to enable semantic recall.",

      dim: "Vector dimensions",
      dimHint: "Changing this invalidates the index. The index is rebuildable; memories are not affected.",
      storageMode: "Storage backend",
      storageModeHint: "auto = bundled sqlite with a profile fallback; sqlite = force; json = follow the profile. Needs a dsh restart to take effect.",
      storageModeAuto: "Auto",
      storageModeSqlite: "Force sqlite",
      storageModeJson: "Follow profile",
      sqliteFile: "sqlite file",
      sqliteFileHint: "Blank uses ~/.dsh/storages/memory_hybrid.sqlite. Needs a dsh restart.",

      jevEndpoint: "Jev endpoint",
      jevEndpointHint: "Blank uses the built-in rules only. To enable, enter https://api.typesafe.ai/v1/systemone — both the endpoint and the key must be set.",
      jevApiKey: "Jev key",
      jevApiKeyHint: "A TypeSafe API key (starts with tsf_), created at console.typesafe.ai. Write-only; leave blank to keep the stored key.",
      jevModel: "Jev model",
      jevModelHint: "Defaults to the pinned jev-1.14.0. jev-latest drifts as TypeSafe ships releases.",
      sweepOnStart: "Sweep on start",
      sweepOnStartHint: "Apply decay and forgetting once at startup.",
      verbose: "Debug logging",
      verboseHint: "Emit debug-level logs.",

      save: "Save",
      saving: "Saving…",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      readOnly: "This deployment stores settings read-only.",
      unavailable: "This plugin is not loaded, so it cannot be configured right now.",
      overridden: "Overridden",
      reset: "Reset to default",
      invalidNumber: "Enter a number, or leave blank to use the default.",
      configured: "Configured",
      notConfigured: "Not set",
    };

    /* ------------------------------------------------------------------ *
     * 字段转换规则
     * ------------------------------------------------------------------ */

    /**
     * 布尔的**取值转换**规则。
     *
     * 控件本身用宿主的原生 `Switch`（见下方 `toggleField`），这里只负责
     * 值域：模型层统一用文本表达草稿，所以布尔也得有 format / parse。
     * `Switch` 打开时写 "true"，关闭时写 "false"，两者都必然合法。
     */
    const settingsBooleanField = (field) => ({
      field,
      format: (value) => (value === undefined || value === null ? "" : value ? "true" : "false"),
      parse: (text) => {
        const s = String(text ?? "").trim().toLowerCase();
        if (s === "") return { kind: "clear" };
        if (s === "true" || s === "1" || s === "yes" || s === "on") return { kind: "set", value: true };
        if (s === "false" || s === "0" || s === "no" || s === "off") return { kind: "set", value: false };
        // 非法草稿返回 undefined：这一笔不产生写入，且 save 会因 invalid 被拒。
        // 不能悄悄丢弃 —— 用户敲进去的字必须有个明确的去处。
        return undefined;
      },
    });

    /** 枚举字段。合法值之外一律 invalid。 */
    const settingsEnumField = (field, allowed) => ({
      field,
      format: (value) => (value === undefined || value === null ? "" : String(value)),
      parse: (text) => {
        const s = String(text ?? "").trim();
        if (s === "") return { kind: "clear" };
        if (!allowed.includes(s)) return undefined;
        return { kind: "set", value: s };
      },
    });

    /**
     * 字段清单。顺序即页面呈现顺序。
     *
     * 每次调用返回新数组：`SettingsFormModel` 会持有它们，共用一个数组在
     * 多次注册间可能互相污染。
     */
    const fieldSpecs = () => [
      settingsBooleanField("autoRecall"),
      settingsNumberField("recallLimit"),
      settingsNumberField("contextOrder"),

      settingsEnumField("embedSource", ["inherit", "custom", "off"]),
      settingsTextField("embedBaseURL"),
      settingsTextField("embedModel"),

      settingsNumberField("dim"),
      settingsEnumField("storageMode", ["auto", "sqlite", "json"]),
      settingsTextField("sqliteFile"),

      settingsTextField("jevEndpoint"),
      settingsTextField("jevModel"),
      settingsBooleanField("sweepOnStart"),
      settingsBooleanField("verbose"),
    ];

    /**
     * 只写字段：走独立的 secret 通道，永不回显。
     *
     * 与普通字段的区别在于写入路径 —— 普通字段攒成一次 `mutate(ops)`，
     * 密钥逐条走 `write()`。`plan()` 里也只对非空草稿产生写入，所以留空
     * 表示「不改」，而不是「清空」。
     */
    const secretFields = () => ["embedApiKey", "jevApiKey"];

    /* ------------------------------------------------------------------ *
     * 视图
     * ------------------------------------------------------------------ */

    /**
     * 渲染本插件的配置页。
     *
     * `props` 由插槽渲染器拼装：`t` 来自 locale 命名空间，`useMemoryCard`
     * 由 inject 的 `hooks` 合成分派，其余（edit / resetField / save /
     * discard）来自 `model.actions()`。
     */
    function MemoryCard(props) {
      const { t } = props;
      // 投影里已经压平了 shell 与每个字段的状态，组件只按需取用。
      const state = props.useMemoryCard((snapshot) => snapshot);

      const disabled = !state.writable;

      const labels = {
        unavailable: t("unavailable"),
        readOnly: t("readOnly"),
        saveFailed: t("saveFailed"),
        save: t("save"),
        saving: t("saving"),
      };

      /** 一行文本/数字/布尔/枚举字段 */
      const valueField = (field, label, hint, extra = {}) =>
        h(SettingsValueField, {
          key: field,
          id: `plugin-config-memory-${field}`,
          label,
          hint,
          overriddenLabel: t("overridden"),
          resetLabel: t("reset"),
          invalidLabel: extra.invalidLabel ?? t("invalidNumber"),
          disabled,
          // state[field] 已是 { text, overridden, invalid }，正好是控件要的形状。
          ...state[field],
          onEdit: (text) => props.edit(field, text),
          onReset: () => props.resetField(field),
          ...(extra.numeric ? { numeric: true } : {}),
          ...(extra.placeholder ? { placeholder: extra.placeholder } : {}),
        });

      /**
       * 一行布尔开关。
       *
       * 用宿主原生的 `Switch`（`dsh-client-ui-primitives` 的正式导出），
       * 于是开关的视觉、键盘操作、`role="switch"` 语义都与其它设置页一致，
       * 不必自己画。
       *
       * 值的流转仍走表单模型：`Switch` 只报「开/关」，这里翻成模型认识的
       * 草稿文本 "true" / "false"。不用直接 `mutate`，是为了让改动和其它
       * 字段一样先暂存、由同一颗「保存」提交 —— 半保存的表单最难解释。
       *
       * 「已覆盖」徽标：宿主的 `Switch` 不带宽高徽标位，所以把「当前是否
       * 覆盖了默认值」挪到说明文字里，并给一个恢复默认的按钮。信息没丢，
       * 只是换了位置。
       */
      const toggleField = (field, label, hint) => {
        const fieldState = state[field];
        const checked = String(fieldState.text).trim().toLowerCase() === "true";
        return h(
          "div",
          {
            key: field,
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "12px 0",
              borderTop: "0.5px solid var(--dsw-alias-border-l2)",
            },
          },
          [
            h(
              "div",
              {
                key: "head",
                style: { display: "flex", alignItems: "center", gap: 8 },
              },
              [
                h(
                  "label",
                  {
                    key: "label",
                    htmlFor: `plugin-config-memory-${field}`,
                    style: {
                      flex: 1,
                      minWidth: 0,
                      fontSize: 13,
                      fontWeight: 500,
                      lineHeight: 1.5,
                      color: "var(--dsw-alias-label-primary)",
                    },
                  },
                  label,
                ),
                fieldState.overridden
                  ? h(
                      "button",
                      {
                        key: "reset",
                        type: "button",
                        disabled,
                        onClick: () => props.resetField(field),
                        style: {
                          border: "none",
                          background: "none",
                          padding: 0,
                          font: "inherit",
                          fontSize: 12,
                          lineHeight: 1.5,
                          color: "var(--dsw-alias-label-secondary)",
                          cursor: disabled ? "default" : "pointer",
                        },
                      },
                      t("reset"),
                    )
                  : null,
                h(Switch, {
                  key: "switch",
                  checked,
                  disabled,
                  label,
                  onChange: (next) => props.edit(field, next ? "true" : "false"),
                }),
              ].filter(Boolean),
            ),
            hint
              ? h(
                  "p",
                  {
                    key: "hint",
                    style: {
                      margin: 0,
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: "var(--dsw-alias-label-tertiary)",
                    },
                  },
                  hint,
                )
              : null,
          ].filter(Boolean),
        );
      };

      /**
       * 一行枚举分段选择器。
       *
       * 用宿主原生的 `SegmentedControl`。它自带 `role="tablist"`、方向键
       * 切换、指示条动画，比一堆手写按钮稳。
       *
       * 只认列表里的值：草稿若不在其中（例如别处写进了新枚举），回落到
       * 第一项显示，但仍保留原草稿不主动覆盖 —— 显示与写入分开，避免
       * 「看一眼就把别人的值改了」。
       */
      const enumField = (field, label, hint, options) => {
        const fieldState = state[field];
        const current = String(fieldState.text ?? "").trim();
        const known = options.some((option) => option.value === current);
        return h(
          "div",
          {
            key: field,
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "12px 0",
              borderTop: "0.5px solid var(--dsw-alias-border-l2)",
            },
          },
          [
            h(
              "div",
              {
                key: "head",
                style: { display: "flex", alignItems: "center", gap: 8 },
              },
              [
                h(
                  "div",
                  {
                    key: "label",
                    style: {
                      flex: 1,
                      minWidth: 0,
                      fontSize: 13,
                      fontWeight: 500,
                      lineHeight: 1.5,
                      color: "var(--dsw-alias-label-primary)",
                    },
                  },
                  label,
                ),
                fieldState.overridden
                  ? h(
                      "button",
                      {
                        key: "reset",
                        type: "button",
                        disabled,
                        onClick: () => props.resetField(field),
                        style: {
                          border: "none",
                          background: "none",
                          padding: 0,
                          font: "inherit",
                          fontSize: 12,
                          lineHeight: 1.5,
                          color: "var(--dsw-alias-label-secondary)",
                          cursor: disabled ? "default" : "pointer",
                        },
                      },
                      t("reset"),
                    )
                  : null,
              ].filter(Boolean),
            ),
            h(SegmentedControl, {
              key: "control",
              id: `plugin-config-memory-${field}`,
              label,
              disabled,
              value: known ? current : options[0].value,
              options,
              onChange: (next) => props.edit(field, String(next)),
            }),
            hint
              ? h(
                  "p",
                  {
                    key: "hint",
                    style: {
                      margin: 0,
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: "var(--dsw-alias-label-tertiary)",
                    },
                  },
                  hint,
                )
              : null,
          ].filter(Boolean),
        );
      };

      /** 一行只写密钥字段 */
      const secretField = (field, label, hint) => {
        const fieldState = state[field];
        return h(SettingsSecretField, {
          key: field,
          id: `plugin-config-memory-${field}`,
          label,
          hint,
          text: fieldState.text,
          configured: state.secrets[field],
          stateLabel: state.secrets[field] ? t("configured") : t("notConfigured"),
          disabled,
          onEdit: (text) => props.edit(field, text),
        });
      };

      /** 分组标题。宿主没有提供这个件，用最少的行内样式补齐。 */
      const group = (title, note) =>
        h(
          "div",
          { style: { marginTop: 22, marginBottom: 6 } },
          [
            h(
              "div",
              {
                key: "t",
                style: {
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--dsw-alias-label-primary)",
                },
              },
              title,
            ),
            note
              ? h(
                  "div",
                  {
                    key: "n",
                    style: {
                      fontSize: 12,
                      lineHeight: "18px",
                      color: "var(--dsw-alias-label-tertiary)",
                      marginTop: 4,
                    },
                  },
                  note,
                )
              : null,
          ].filter(Boolean),
        );

      return h(
        SettingsForm,
        {
          labels,
          state,
          onSave: props.save,
          onDiscard: props.discard,
        },
        [
          group(t("sectionRecall")),
          toggleField("autoRecall", t("autoRecall"), t("autoRecallHint")),
          valueField("recallLimit", t("recallLimit"), t("recallLimitHint"), {
            numeric: true,
            placeholder: "6",
          }),
          valueField("contextOrder", t("contextOrder"), t("contextOrderHint"), {
            numeric: true,
            placeholder: "10500",
          }),

          group(t("sectionEmbed"), t("embedSourceHint")),
          enumField("embedSource", t("embedSource"), t("embedSourceHint"), [
            { value: "inherit", label: t("embedSourceInherit") },
            { value: "custom", label: t("embedSourceCustom") },
            { value: "off", label: t("embedSourceOff") },
          ]),
          valueField("embedBaseURL", t("embedBaseURL"), t("embedBaseURLHint"), {
            placeholder: "https://api.example.com/v1",
          }),
          valueField("embedModel", t("embedModel"), t("embedModelHint"), {
            placeholder: "bge-m3",
          }),
          secretField("embedApiKey", t("embedApiKey"), t("embedApiKeyHint")),

          group(t("sectionStore")),
          valueField("dim", t("dim"), t("dimHint"), { numeric: true, placeholder: "256" }),
          enumField("storageMode", t("storageMode"), t("storageModeHint"), [
            { value: "auto", label: t("storageModeAuto") },
            { value: "sqlite", label: t("storageModeSqlite") },
            { value: "json", label: t("storageModeJson") },
          ]),
          valueField("sqliteFile", t("sqliteFile"), t("sqliteFileHint")),

          group(t("sectionOther")),
          valueField("jevEndpoint", t("jevEndpoint"), t("jevEndpointHint")),
          valueField("jevModel", t("jevModel"), t("jevModelHint"), {
            placeholder: "jev-1.14.0",
          }),
          secretField("jevApiKey", t("jevApiKey"), t("jevApiKeyHint")),
          toggleField("sweepOnStart", t("sweepOnStart"), t("sweepOnStartHint")),
          toggleField("verbose", t("verbose"), t("verboseHint")),
        ],
      );
    }

    /* ------------------------------------------------------------------ *
     * 配置卡片控制器
     * ------------------------------------------------------------------ */

    /**
     * 把 `ConfigForm` 与 `SettingsFormModel` 拼成页面要的那一副面孔。
     *
     * 投影里同时装两类状态：`SettingsFormModel` 的 shell（可写性、脏、保存中、
     * 失败）与逐字段状态，外加一个 `secrets` 表。密钥字段的「已配置」不由
     * 表单模型回答 —— 它只关心草稿 —— 而是直接问宿主 describe 的侧信道
     * （`SettingsNamespaceView.secrets`，形如 `[{path:["embedApiKey"], set:true}]`）。
     */
    class MemoryCardController {
      constructor(ctx, scope) {
        this.ctx = ctx;
        this.scope = scope;
        this.secrets = { embedApiKey: false, jevApiKey: false };

        this.form = new SettingsFormModel(
          scope,
          fieldSpecs(),
          secretFields().map((field) => ({
            field,
            // 与 form-model 的约定一致：留空草稿不产生写入（plan 会跳过），
            // 所以这里只需原样写下去。
            write: (text) => this.writeSecret(field, text),
          })),
        );

        this.store = this.form.bind(() => this.projection());

        // 两条订阅各管一类变化：
        //   · mirror 变化 —— describe 首次就绪、或别处改了配置，连密钥侧信道一起刷新
        //   · scope 变化 —— 本表单的写入被接受，字段值跟着更新
        // 只订阅 scope 是不够的：mirror 的内部读取是异步的，scope 的首次
        // `ready` 早于它，首次渲染时密钥状态会停留在「未配置」。
        const mirror = ctx.configForms.describe();
        this.unsubscribeMirror = mirror.subscribe(() => this.readSecrets());
        this.unsubscribe = scope.subscribe(() => this.readSecrets());
        this.readSecrets();
      }

      /** 页面渲染所需的全部状态。 */
      projection() {
        const fields = {};
        for (const spec of fieldSpecs()) fields[spec.field] = this.form.field(spec.field);
        for (const field of secretFields()) fields[field] = this.form.field(field);
        return { ...this.form.shell(), ...fields, secrets: { ...this.secrets } };
      }

      /**
       * 写一个密钥字段。
       *
       * 走普通 `mutate` 而不是别的通道：这两个密钥是本插件自己 Config 里的
       * 字段，与 web-search 那种「密钥存放在 credentials 域、由 apiKeyEnv
       * 引用」的情形不同，这里不需要额外的凭据服务。
       */
      async writeSecret(field, text) {
        const s = String(text ?? "").trim();
        if (s === "") return true;
        const snapshot = this.scope.getSnapshot();
        return this.scope.mutate([{ op: "set", path: [field], value: s }], snapshot.revision);
      }

      /**
       * 重读「哪些密钥已配置」。
       *
       * 密钥明文永不过网，宿主只回一个侧信道。`configForms.describe()` 是
       * 这条侧信道的读取口，它给整份 describe 视图，因此这里按命名空间找到
       * 本插件那一行，再按 path 匹配字段。
       *
       * ## 这条侧信道只有在「密钥字段不带 default」时才可靠
       *
       * 宿主的判定是 `value !== undefined`。若密钥字段写了
       * `.default("")`，解析后永远是空串而非 undefined，于是 `set` **恒为
       * true** —— 一次都没填过也显示「已配置」。实测：
       *
       *     有 default("")  → 没填也 set=true          ✗
       *     无 default      → 没填 set=false，填了 set=true   ✓
       *
       * 所以 `src/index.js` 里两个密钥字段刻意不给默认值。改那里的 cost
       * 是读配置时要自己兜 undefined，收益是这里能拿到真实状态。
       *
       * 注：不能改用 `user` 层判断 —— `describe()` 对 user 层同样跑
       * `redactSecrets`，密钥键会被整个摘除，从那边什么都看不出来。
       */
      readSecrets() {
        const next = { embedApiKey: false, jevApiKey: false };
        try {
          const mirror = this.ctx.configForms.describe();
          const view = mirror.getSnapshot().view;
          const row = view?.namespaces?.find((candidate) => candidate.ns === NS);
          for (const secret of row?.secrets ?? []) {
            const field = secret.path?.[0];
            if (field !== undefined && field in next) next[field] = secret.set === true;
          }
        } catch {
          // describe 还没就绪时保持全部「未配置」，下一轮订阅会再读。
        }
        const changed =
          next.embedApiKey !== this.secrets.embedApiKey ||
          next.jevApiKey !== this.secrets.jevApiKey;
        if (!changed) return;
        this.secrets = next;
        this.store.set(this.projection());
      }

      /** 插槽注册时注入的那副面孔。 */
      inject() {
        return {
          hooks: { memoryCard: this.store },
          ...this.form.actions(),
        };
      }

      dispose() {
        this.unsubscribeMirror();
        this.unsubscribe();
        this.form.dispose();
      }
    }

    /* ------------------------------------------------------------------ *
     * 插件装配
     * ------------------------------------------------------------------ */

    const inject = ["slots", "locale", "configForms"];

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "memory-hybrid: dictionaries",
      );

      const t = ctx.locale.bind(NS);

      // 先建控制器，再挂页面：控制器要订阅 scope，而 scope 来自
      // configForms，两者生命周期都绑在 ctx 上，用 ctx.effect 统一收口。
      let controller;
      ctx.effect(() => {
        try {
          controller = new MemoryCardController(ctx, ctx.configForms.get(NS));
        } catch (error) {
          ctx.logger?.warn?.(error);
          controller = undefined;
        }
        return () => {
          controller?.dispose();
          controller = undefined;
        };
      }, "memory-hybrid: form");

      // whileServed：只有宿主真的提供了本命名空间才注册页面。
      // 少了这层守卫，命名空间没被服务时页面上会出现一个永远空白的 tab。
      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject("settings.plugins.tab", () =>
              ctx.slots.register(
                {
                  name: "settings.plugins.tab",
                  id: "memory-hybrid",
                  order: 20,
                  label: () => t("tab"),
                  locale: NS,
                  inject: () => (controller ? controller.inject() : { hooks: {} }),
                },
                MemoryCard,
              ),
            ),
          ),
        "memory-hybrid: page",
      );
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

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

      panel: "记忆",
      panelDesc: "分级 · 衰减 · 唤醒 · 淘汰",
      backToSettings: "也可在 设置 → 插件 → 记忆 中修改同一份配置",
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

      panel: "Memory",
      panelDesc: "Tiered · decaying · revivable",
      backToSettings: "The same configuration is also under Settings → Plugins → Memory",
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
      //
      // `useMemoryCard` 缺席的唯一场合是控制器没建起来（`remote` 全程未就绪）。
      // 那时不该崩，落到「未加载」态 —— 与宿主自己表达不可用的方式一致。
      const state = typeof props.useMemoryCard === "function"
        ? props.useMemoryCard((snapshot) => snapshot)
        : { available: false, writable: false, dirty: false, invalid: false, saving: false, failed: false, secrets: {} };

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
     * 侧栏面板
     * ------------------------------------------------------------------ */

    /**
     * 侧栏图标：一枚「记忆分层」符号。
     *
     * 画三层递减的横条（上层最宽、下层最窄），表达记忆按重要性分层后逐层
     * 沉淀；最底一层用低透明度，暗示「沉睡但仍可复活」。不用文字或复杂图形，
     * 保证 16–18px 的侧栏槽位里仍然可辨。
     *
     * @param {object} props - 组件属性
     * @param {number} [props.size] - 边长（像素）
     * @param {boolean} [props.active] - 选中态
     * @returns {object} React 元素
     */
    function MemoryIcon(props) {
      const size = props.size || 18;
      const active = Boolean(props.active);
      // 选中时整枚图标提亮；未选中时留一点透明，与侧栏其它图标一致。
      const opacity = active ? 1 : 0.85;

      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          xmlns: "http://www.w3.org/2000/svg",
          "aria-hidden": "true",
          focusable: "false",
        },
        [
          // 上层：最宽，实心
          h("rect", {
            key: "top",
            x: 3,
            y: 5,
            width: 18,
            height: 3.4,
            rx: 1.7,
            fill: "currentColor",
            opacity,
          }),
          // 中层：略窄
          h("rect", {
            key: "mid",
            x: 5,
            y: 10.3,
            width: 14,
            height: 3.4,
            rx: 1.7,
            fill: "currentColor",
            opacity: opacity * 0.72,
          }),
          // 底层：最窄且最淡，表达「沉到低层但未删除」
          h("rect", {
            key: "low",
            x: 7.5,
            y: 15.6,
            width: 9,
            height: 3.4,
            rx: 1.7,
            fill: "currentColor",
            opacity: opacity * 0.42,
          }),
        ],
      );
    }

    /**
     * 侧栏面板页：把设置页那张卡片放进一个独立的主面板容器。
     *
     * 为什么还要一层：`main` 槽只提供一个空盒子（`dsh-client-ui-layout` 的
     * `MainPanel` 直接 `renderSlot("main")`，不带内边距），而 `MemoryCard`
     * 返回的 `SettingsForm` 是给设置页正文用的、不自带边距。放进主面板若不
     * 自己加容器，表单会贴到窗口边缘。
     *
     * 配置本身不另开一套：仍由同一个 `MemoryCardController` 供数，所以这里
     * 只是「换了个壳」，与设置页 tab 看到的是同一份配置、同一个保存动作。
     *
     * @param {object} props - 插槽渲染器拼装的属性
     * @returns {object} React 元素
     */
    function MemoryPanelPage(props) {
      const { t } = props;

      return h(
        "div",
        {
          style: {
            height: "100%",
            overflowY: "auto",
            padding: "28px 32px 48px",
            boxSizing: "border-box",
          },
        },
        h(
          "div",
          { style: { maxWidth: 720, margin: "0 auto" } },
          [
            h(
              "div",
              { key: "head", style: { marginBottom: 20 } },
              [
                h(
                  "h1",
                  {
                    key: "title",
                    style: {
                      margin: 0,
                      fontSize: 18,
                      fontWeight: 600,
                      lineHeight: 1.4,
                      color: "var(--dsw-alias-label-primary)",
                    },
                  },
                  t("title"),
                ),
                h(
                  "p",
                  {
                    key: "desc",
                    style: {
                      margin: "6px 0 0",
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: "var(--dsw-alias-label-tertiary)",
                    },
                  },
                  t("panelDesc"),
                ),
              ],
            ),
            // 卡片本体：与设置页 tab 完全同一份组件与数据源
            h(MemoryCard, { key: "card", ...props }),
            h(
              "p",
              {
                key: "foot",
                style: {
                  margin: "18px 0 0",
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "var(--dsw-alias-label-tertiary)",
                },
              },
              t("backToSettings"),
            ),
          ],
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * 自备 scope：绕开宿主对非 loopback 页面的表单禁用
     * ------------------------------------------------------------------ */

    /**
     * 一个只靠 `ctx.remote.settings` 的 scope，接口与宿主
     * `configForms.get(ns)` 返回的 `ConfigFormController` 完全一致。
     *
     * ## 为什么需要它
     *
     * 宿主的 `ConfigFormController` 在构造时按页面来源决定「是否连 Host」：
     *
     *     const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";
     *
     * `isLoopback` 只认 `localhost` / `[::1]` / `127.x.x.x`
     * （`dsh-client-connection/lib/client.js:1333` 的 `isLoopbackHostname`）。
     * 用公网 IP 或域名打开页面时它是 **false**，于是 `persistence = "memory"`，
     * 而 memory 分支下：
     *
     *     status: persistence === "host" ? "loading" : "unavailable"   // 1118 行
     *     load()   { if (this.persistence === "memory") return; }      // 1407 行
     *     ensure() { if (this.persistence === "memory") return; }      // 1423 行
     *     enqueue(){ if (this.persistence === "memory") return false; } // 1213 行
     *
     * 三件事同时发生：`status` 一经构造就是 `"unavailable"`、镜像永不发起
     * describe、写入一律直接返回 false。而 `SettingsFormModel.shell()` 的
     * 判定是 `available: snapshot.status === "ready"`（primitives 7194 行），
     * 于是卡片稳定渲染 `labels.unavailable` —— 就是界面上那句
     * 「该插件当前未加载，暂时无法配置。」
     *
     * 关键点：**这不是插件没加载**。`MemoryPanelPage` 自己渲染的标题、副标题、
     * 脚注都正常，说明插件在跑、组件树在跑；失败的只是表单那一层。
     *
     * ## 为什么不照抄宿主这套保守策略
     *
     * 宿主的保守有它的道理 —— 非本地页面的写入在它看来可能失效。但它的
     * 「失效」假设来自 `settings/conflict` 一类并发写冲突，而不是权限：
     * Host 端的 `dsh-api-settings-controller` 对 `describe` / `mutate` 没有
     * 任何 loopback 门禁（`--trusted-host` 只影响 `/api` 的请求准入，见
     * `dsh-client-connection/lib/index.js:210`）。既然 RPC 通、Host 认，
     * 那就在前端补上宿主没做的那一层，而不是让整个面板空着。
     *
     * 官方插件里也有同样的取舍痕迹：`dsh-client-ui-settings-general` 用
     * `ctx.remote.$host.isLoopback ? new SettingsDocumentStore(...) : void 0`
     * 主动放弃，但它放弃的只是「用原生编辑器打开配置文件」这一个动作。
     *
     * ## 契约（必须与 ConfigFormController 对齐，因为它喂的是同一个
     *    `SettingsFormModel`）
     *
     *   · `getSnapshot()` → `{status, value, base, user, revision, writable, mode}`
     *   · `subscribe(fn)`  → 返回退订函数
     *   · `mutate(ops, expectedRevision)` → Promise<boolean>
     */
    class RemoteScope {
      /**
       * @param {object} ctx 插件上下文
       * @param {string} namespace 设置命名空间
       * @param {object} remote `ctx.remote`，由调用方经 `ctx.inject(["remote"])` 取到
       */
      constructor(ctx, namespace, remote) {
        this.ctx = ctx;
        this.namespace = namespace;
        this.remote = remote;

        this.state = {
          status: "loading",
          value: undefined,
          base: undefined,
          user: undefined,
          revision: undefined,
          writable: false,
          mode: "remote",
          // 密钥侧信道：Host 在 describe 与写回答里都会带上，形如
          // `[{path:["embedApiKey"], set:true}]`。明文永不过网。
          secrets: undefined,
        };

        this.listeners = new Set();
        this.disposed = false;
        this.generation = 0;

        this.load();
      }

      /** @returns {object} 当前快照（引用稳定，变更时才换） */
      getSnapshot() {
        return this.state;
      }

      /**
       * 订阅快照变化。
       *
       * **订阅时立即回调一次**：`load()` 在构造里就发了，订阅往往晚于它落地，
       * 只靠后续变更通知的话订阅者可能永远收不到那次变化（tab 探测就踩过：
       * describe 在 subscribe 之前完成，回调再也不会被触发）。
       *
       * @param {Function} listener 快照变化回调
       * @returns {Function} 退订
       */
      subscribe(listener) {
        this.listeners.add(listener);
        try {
          listener();
        } catch {
          // 首次回调抛错不该让订阅失败
        }
        return () => this.listeners.delete(listener);
      }

      setState(patch) {
        if (this.disposed) return;
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            // 单个订阅者抛错不该拖垮其余订阅者
          }
        }
      }

      /**
       * 从 Host 读一次 describe，取本命名空间那一行。
       *
       * @returns {Promise<boolean>} 是否拿到了本命名空间的视图
       */
      async load() {
        const generation = ++this.generation;
        try {
          const response = await this.remote.settings.describe();
          if (this.disposed || generation !== this.generation) return false;
          if (!response.ok) {
            this.setState({ status: "unavailable" });
            return false;
          }
          this.fold(response.value);
          return true;
        } catch {
          if (this.disposed || generation !== this.generation) return false;
          // 通道异常：标 unavailable 而不是永远 loading，让界面能说出实话
          this.setState({ status: "unavailable" });
          return false;
        }
      }

      /**
       * 把一份 describe 文档折叠进本快照。
       *
       * @param {object} view `{ writable, namespaces: [...] }`
       */
      fold(view) {
        const row = view?.namespaces?.find((candidate) => candidate.ns === this.namespace);
        if (row === undefined) {
          // Host 没在服务本命名空间 —— 这才是真正意义上的「未加载」：
          // 插件没进配置树，或 describe 的过滤链把它跳过了
          // （dsh-settings/lib/index.js:420 的 fiber.state !== 2 等）。
          this.setState({ status: "unavailable", writable: view?.writable === true });
          return;
        }
        this.setState({
          status: "ready",
          value: row.value,
          base: row.base,
          user: row.user,
          revision: row.revision,
          writable: view?.writable === true,
          secrets: row.secrets,
        });
      }

      /**
       * 写一批 path 操作，成功后把 Host 回答的视图折叠回来。
       *
       * 与宿主的 `enqueue` 有一处刻意的不同：宿主在 `persistence === "memory"`
       * 时直接 `return false`（不写也不发请求）；这里照发 —— 因为 remote 通道
       * 本身是通的，写不写得进由 Host 裁决。
       *
       * @param {Array<object>} ops `{op:"set"|"unset", path:[...], value?}`
       * @param {number} [expectedRevision] 读到的 revision，用于并发围栏
       * @returns {Promise<boolean>} Host 是否接受
       */
      async mutate(ops, expectedRevision) {
        if (this.disposed) return false;
        const revision = expectedRevision ?? this.state.revision;
        try {
          const response = await this.remote.settings.mutate(this.namespace, ops, revision);
          if (this.disposed) return true;
          if (!response.ok) {
            // 冲突/被拒：重读一次，让界面回到 Host 的真相
            await this.load();
            return false;
          }
          // Host 在写成功后直接回该命名空间的新视图，省掉一次 describe
          this.fold({ writable: this.state.writable, namespaces: [response.value] });
          return true;
        } catch {
          await this.load();
          return false;
        }
      }

      dispose() {
        this.disposed = true;
        this.listeners.clear();
      }
    }

    /**
     * 判断宿主给的 scope 有没有可能变成 `ready`。
     *
     * 只读一次同步快照，绝不等：`ConfigFormController` 在构造时就把终态定死了
     * （`persistence === "memory"` → `status` 恒为 `"unavailable"`，且不订阅
     * 镜像），所以「现在不是 ready 且永远不会变」与「现在 loading 但马上会好」
     * 必须区分开，否则会在正常部署上把宿主 scope 白白换掉。
     *
     * 判据用 `mode`：宿主把它设成 `persistence`，自建的是 `"remote"`。
     * `mode === "memory"` 就是那条「永不就绪」的分支。
     *
     * @param {object} scope 候选 scope
     * @returns {boolean} 是否值得继续用
     */
    function isScopeServable(scope) {
      let snapshot;
      try {
        snapshot = scope.getSnapshot();
      } catch {
        return false;
      }
      if (snapshot === undefined || snapshot === null) return false;
      if (snapshot.status === "ready") return true;
      // 非 ready 时唯一的死刑判决是 memory 持久化；其余（loading / idle）
      // 都还在路上，交给订阅去等。
      return snapshot.mode !== "memory";
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
      /**
       * @param {object} ctx 插件上下文
       * @param {object} remote `ctx.remote`
       * @param {object} [hostScope] 宿主的 `configForms.get(NS)`；不可用时自建
       */
      constructor(ctx, remote, hostScope) {
        this.ctx = ctx;
        this.remote = remote;
        this.secrets = { embedApiKey: false, jevApiKey: false };

        // 绝大多数部署里宿主 scope 是好的，直接用它 —— 它额外提供
        // `developerTools` 等本插件用不到的协作面，但契约与自建的一致。
        //
        // 只有在它「拿不到」或「拿得到但永远 ready 不了」时才自建：
        // 后者是非 loopback 页面的常态（见 RemoteScope 的注释），此时
        // 边界上没有任何报错，唯一的表征是 status 恒为 unavailable。
        this.ownScope = undefined;
        this.scope = hostScope ?? this.adoptRemoteScope();
        if (hostScope !== undefined && !isScopeServable(hostScope)) {
          this.ownScope = this.adoptRemoteScope();
          this.scope = this.ownScope;
        }

        this.form = new SettingsFormModel(
          this.scope,
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
        //
        // 自建 scope 时没有镜像可订阅，密钥侧信道改从它自己的 describe 结果
        // 里取（RemoteScope 折叠过的那份），下面 readSecrets 统一走 scope。
        const forms = ctx.get?.("configForms");
        if (forms !== undefined && this.ownScope === undefined) {
          const mirror = forms.describe();
          this.unsubscribeMirror = mirror.subscribe(() => this.readSecrets());
        }
        this.unsubscribe = this.scope.subscribe(() => this.readSecrets());
        this.readSecrets();
      }

      /** 建一个只走 remote 的 scope，并随控制器一起释放。 */
      adoptRemoteScope() {
        return new RemoteScope(this.ctx, NS, this.remote);
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
          const view = this.describeView();
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

      /**
       * 取一份 describe 视图，供密钥侧信道使用。
       *
       * 两条来源，取决于当前用的是哪个 scope：
       *
       *   · 宿主 scope —— 走 `configForms.describe()` 的共享镜像。它给整份
       *     文档，与本表单同源，最准。
       *   · 自建 scope —— 宿主镜像根本不会加载（`persistence === "memory"`
       *     时 `load()` 直接 return），只能读 RemoteScope 自己 describe 出来
       *     的那一份。
       *
       * 注意自建 scope 的 mutate 回答里 Host 会带上 `secrets`，所以保存之后
       * 侧信道也是新的，不会停在旧值上。
       *
       * @returns {object|undefined} `{ writable, namespaces }`
       */
      describeView() {
        if (this.ownScope !== undefined) {
          const snapshot = this.ownScope.getSnapshot();
          const row = snapshot.status === "ready"
            ? {
                ns: NS,
                value: snapshot.value,
                base: snapshot.base,
                user: snapshot.user,
                revision: snapshot.revision,
                secrets: snapshot.secrets,
              }
            : undefined;
          return row === undefined ? undefined : { writable: snapshot.writable, namespaces: [row] };
        }
        const forms = this.ctx.get?.("configForms");
        if (forms === undefined) return undefined;
        return forms.describe().getSnapshot().view;
      }

      /** 插槽注册时注入的那副面孔。 */
      inject() {
        return {
          hooks: { memoryCard: this.store },
          ...this.form.actions(),
        };
      }

      dispose() {
        this.unsubscribeMirror?.();
        this.unsubscribe?.();
        this.form.dispose();
        this.ownScope?.dispose();
      }
    }

    /* ------------------------------------------------------------------ *
     * 插件装配
     * ------------------------------------------------------------------ */

    /**
     * 必需服务只有两个。
     *
     * `configForms` **刻意不在这里**。inject 是「等这些服务全部就绪才执行
     * apply」——它是一种硬门禁，cordis 会安静地等，等不到就永远不调用 apply，
     * 不报错、不打日志。
     *
     * 而本插件对 configForms 的依赖是「有了才能填设置表单」，不是「没有就
     * 不该工作」。侧栏图标和主面板根本不需要它。把它写进 inject 的后果是：
     * configForms 一旦因为任何上游原因（settings 插件没起来、remote 通道未就绪、
     * describe 镜像还没建）迟迟不出现，整个 apply 就不执行 —— 侧栏、主面板、
     * 设置页 tab 全都不会注册，且日志里干干净净。这正是「装了插件但左侧没有
     * 记忆入口」最难查的那种失败。
     *
     * 正确分工（对应插件开发标准「必需依赖用 inject 声明，可选依赖用 ctx.get()
     * 判空」）：
     *
     *   · slots / locale  —— 硬依赖，缺了整个插件没意义，进 inject
     *   · configForms    —— 软依赖，用 ctx.get("configForms") 判空后降级
     *
     * 降级行为：拿不到 configForms 时侧栏与主面板照常注册，主面板显示
     * 「配置尚未就绪」而不是崩掉；设置页 tab 不注册（它确实离不开表单）。
     */
    const inject = ["slots", "locale"];

    /** 侧栏面板 id，同时是 `main` keyed slot 的 key —— 两者必须一致，否则点图标不会切到本页。 */
    const PANEL_ID = "memory-hybrid";
    /** 侧栏排序：插件按钮是 0，本面板紧随。 */
    const PANEL_ORDER = 2;

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        "memory-hybrid: dictionaries",
      );

      const t = ctx.locale.bind(NS);

      /**
       * 取可选的 configForms 服务。
       *
       * `ctx.get()` 对未就绪/未提供的服务返回 undefined 而不是抛错 —— 这正是
       * 软依赖该用的读法。拿不到时整个设置表单链路（控制器 + tab）跳过，
       * 侧栏与主面板不受影响。
       */
      const configForms = () => ctx.get?.("configForms");

      // 先建控制器，再挂页面：控制器要订阅 scope，而 scope 来自
      // configForms，两者生命周期都绑在 ctx 上，用 ctx.effect 统一收口。
      //
      // ## 为什么这里用 ctx.inject 而不是直接把 configForms 写进 inject
      //
      // 两者差别是「整插件」还是「仅这一块」：
      //
      //   · 顶层 inject: ["slots","locale","configForms"] —— cordis 等三个服务
      //     全部就绪才调 apply。configForms 迟到 = 整个插件静默不启动，
      //     侧栏和主面板一起消失。
      //   · ctx.inject(["configForms"], cb) —— 只延后这个回调。configForms
      //     就绪时 cb 跑，没就绪就一直等；apply 本身照常执行，侧栏照常注册。
      //
      // 这正是软依赖该用的形态：把「等」的作用域收到最小。
      //
      // ## 第二层：宿主 scope 未必可用，未必因为我们
      //
      // 上面解决的是「configForms 到不了场」。还有一个更隐蔽的失败：它到场了、
      // `get(NS)` 也返回了对象，但那个对象的 `status` **永远不会**变成 ready。
      // 宿主的 `ConfigFormController` 在构造时按页面来源二选一：
      //
      //     const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";
      //
      // 只有 `localhost` / `[::1]` / `127.x.x.x` 算 loopback。用公网 IP 或域名
      // 打开页面时走 memory 分支，而 memory 下 `status` 恒为 `"unavailable"`、
      // 镜像永不加载、写入直接 return false —— 表现就是卡片上那句
      // 「该插件当前未加载，暂时无法配置。」，尽管插件明明在跑。
      //
      // 所以控制器不只是「接收 scope」，它自己会判断这个 scope 值不值得用，
      // 必要时换成只走 `remote.settings` 的自建 scope（见 RemoteScope）。
      //
      // ## 两级安装：先立即可用，再择机升级
      //
      // 不写成「等 configForms 就绪再建控制器」——那样在 loopback 上要白等一个
      // 微任务周期，面板首帧会是空的。改成：
      //
      //   ① 立刻建（此时 configForms 通常还没到，自动落到 RemoteScope）
      //   ② configForms 到场后，若它的 scope 可用，换成它重建
      //
      // ②只做「升级」，从不降级：一旦已经在用宿主 scope，就不会再被换回自建。
      let controller;

      /**
       * 用当前可得的 scope 建（或升级）控制器。
       *
       * @param {object} scopeCtx 提供 configForms 的上下文
       * @param {object} remote `ctx.remote`
       */
      const install = (scopeCtx, remote) => {
        const forms = scopeCtx.get?.("configForms");
        let hostScope;
        try {
          hostScope = forms?.get?.(NS);
        } catch {
          hostScope = undefined;
        }

        const upgrade = hostScope !== undefined && isScopeServable(hostScope);
        // 已经在用可用的宿主 scope 时不重建，否则每次 setup 都会重发 describe
        if (controller !== undefined && !upgrade) return;

        controller?.dispose();
        controller = new MemoryCardController(scopeCtx, remote, upgrade ? hostScope : undefined);
      };

      // ① 立即可用。`RemoteScope` 只依赖 `remote.settings`，那是个一直挂着的
      //    服务，所以这一步在 loopback 与非 loopback 上都能成。
      //
      //    `remote` 用 ctx.inject 取，不写进顶层 inject —— 它缺席时插件仍要
      //    能注册侧栏（哪怕是降级态），不该被硬门禁挡住整个 apply。
      ctx.inject(["remote"], (child) => {
        child.effect(() => {
          const remote = child.remote;
          if (controller !== undefined) return () => {};
          try {
            install(child, remote);
          } catch (error) {
            child.logger?.warn?.(error);
            controller = undefined;
          }
          return () => {
            controller?.dispose();
            controller = undefined;
          };
        }, "memory-hybrid: form");
      });

      // ② 择机升级到宿主 scope（它的镜像与其他设置页共享，外部改动会跟着刷新）。
      //    用 ctx.inject 而不是把 configForms 写进顶层 inject，理由同上：
      //    configForms 缺席时这里安静不跑，而 ① 已经把面板撑起来了。
      ctx.inject(["configForms", "remote"], (child) => {
        child.effect(() => {
          if (controller !== undefined) return () => {};
          try {
            install(child, child.remote);
          } catch (error) {
            child.logger?.warn?.(error);
          }
          return () => {};
        }, "memory-hybrid: form upgrade");
      });

      // 传给页面的那一副面孔；控制器没建起来时给空 hooks，
      // 页面会落到「未加载」态而不是崩掉。
      const props = () => (controller ? controller.inject() : { hooks: {} });

      /**
       * 注册一处插槽，返回它自己的 disposer。
       *
       * `ctx.slots.inject(name, fn)` 的语义是「等 name 这个插槽被声明者就绪后
       * 再执行 fn」，并返回用于撤销的 disposer。所以这里必须把 `register`
       * 的结果原样返回出去 —— 中间多包一层聚合会让 whileServed 拿不到可调用
       * 的 off()，命名空间撤走时注册就残留了。
       */
      const slot = (name, options, component) =>
        ctx.slots.inject(name, () => ctx.slots.register({ name, ...options }, component));

      /** 设置页 tab 的注册参数，两路注册共用同一份。 */
      const tabOptions = {
        name: "settings.plugins.tab",
        id: "memory-hybrid",
        order: 20,
        label: () => t("tab"),
        locale: NS,
        inject: props,
      };

      /**
       * 设置页 tab：正常情况下等 Host 真的把本命名空间放进 describe 镜像再注册。
       *
       * `whileServed` 的用意是「这个部署压根没组这个命名空间时，别露出一个
       * 空页面」。但它依赖 describe 镜像 —— 而非 loopback 页面下镜像**永不
       * 加载**（`SettingsDescribeMirror.load()` 在 `persistence === "memory"`
       * 时直接 return），于是 `served` 恒为空集，tab 也永不注册。
       *
       * 所以这里分两路：
       *
       *   · 宿主 scope 可用（loopback）—— 保留 whileServed，尊重它的原意
       *   · 宿主 scope 不可用（非 loopback）—— 改为直接用自建 scope 探一次：
       *     能读到本命名空间就注册，读不到就不注册。判据与 whileServed 等价
       *     （都是「Host 在服务这个 ns 吗」），只是数据源换成 RPC。
       *
       * 无论哪一路，都只影响这一个 tab，不影响下面的侧栏与主面板。
       */
      ctx.inject(["configForms"], (child) => {
        const hostScope = (() => {
          try {
            return child.configForms.get(NS);
          } catch {
            return undefined;
          }
        })();

        if (hostScope !== undefined && isScopeServable(hostScope)) {
          child.effect(
            () =>
              child.configForms.whileServed([NS], () =>
                child.slots.inject("settings.plugins.tab", () => child.slots.register(tabOptions, MemoryCard)),
              ),
            "memory-hybrid: tab",
          );
          return;
        }

        // 非 loopback：用 RPC 自己确认一次命名空间是否被服务。
        child.inject(["remote"], (grand) => {
          grand.effect(
            () => {
              const probe = new RemoteScope(grand, NS, grand.remote);
              let off;
              const stop = probe.subscribe(() => {
                const snapshot = probe.getSnapshot();
                if (snapshot.status === "loading") return;
                if (snapshot.status === "ready" && off === undefined) {
                  off = grand.slots.inject("settings.plugins.tab", () =>
                    grand.slots.register(tabOptions, MemoryCard),
                  );
                }
              });
              return () => {
                stop();
                off?.();
                off = undefined;
                probe.dispose();
              };
            },
            "memory-hybrid: tab (remote probe)",
          );
        });
      });

      // 侧栏图标与主面板：无条件注册。
      //
      // 早期版本把这两处也包在 `ctx.configForms.whileServed([NS], ...)` 里，
      // 结果是**侧栏图标根本不出现**。原因：whileServed 的语义是「等 Host 把
      // 这个设置命名空间放进 describe 镜像」才执行回调 —— 它守护的是「配置
      // 页面」，而不是「侧栏面板」。两者依赖的东西完全不同：
      //
      //   · 设置页 tab  —— 确实需要命名空间可写，否则用户改了存不进去
      //   · 侧栏面板   —— 只需要 slots 服务；侧栏本身不关心配置是否可写
      //
      // 而且 whileServed 是**静默**不触发的：命名空间没被服务时它只是不调用
      // 回调，不报任何错。于是整个插件的 UI 全都不出现，日志里干干净净。
      //
      // 同一类错误还有第二种形态：把 configForms 写进顶层 `inject`。那是硬
      // 门禁，服务不就绪时 cordis 连 apply 都不调，静默程度更彻底。见文件
      // 上方 `inject` 那段注释。
      //
      // 正确的分工：设置页 tab 由自己的 ctx.inject 收口，侧栏两处直接注册。
      ctx.effect(
        () => {
          const offs = [
            // ① 侧栏图标：点击后由宿主调 layout.selectPanel(PANEL_ID)
            slot(
              "sidebar.panellist",
              {
                id: PANEL_ID,
                order: PANEL_ORDER,
                locale: NS,
                label: () => t("panel"),
              },
              MemoryIcon,
            ),

            // ② 主面板：keyed slot，key 必须与侧栏 id 相同
            slot(
              "main",
              {
                key: PANEL_ID,
                locale: NS,
                inject: props,
              },
              MemoryPanelPage,
            ),
          ];

          return () => {
            for (const off of offs) {
              try {
                off?.();
              } catch {
                // 某一处已自行撤销时不应连累其余，逐个吞掉继续。
              }
            }
          };
        },
        "memory-hybrid: page",
      );
    }

    exports.NS = NS;
    exports.PANEL_ID = PANEL_ID;
    exports.apply = apply;
    exports.inject = inject;

    // 下面两个不是给宿主用的，是给测试与排障用的。
    //
    // `isScopeServable` 是「宿主 scope 还能不能用」的判据本身 —— 这个 bug
    // （「该插件当前未加载」）唯一的表征就是它返回 false，所以值得单独可测。
    // `RemoteScope` 同理：它是绕开宿主 memory 分支的那条路，需要一个能直接
    // 断言 `status` 落在 ready 的入口。
    exports.isScopeServable = isScopeServable;
    exports.RemoteScope = RemoteScope;

    return module.exports;
  },
});

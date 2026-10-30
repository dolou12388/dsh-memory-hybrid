/**
 * 嵌入配置与继承解析的测试。
 *
 * 覆盖三件事：
 *   1. YAML 扫描能否正确取出 patch 条目与嵌套 providers
 *   2. 继承解析在缺文件 / 正常文件下的行为
 *   3. 响应归一化能否认出各种网关形态，以及配置解析的降级路径
 *
 * 全部离线：不发真实请求，不读用户真实配置（用临时文件构造）。
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  scanPatchEntries, pickRoute, resolveInheritedModel, candidatePatchFiles,
} from "../plugin/src/core/inherit.js";
import {
  normalizeEmbeddingResponse, embeddingsUrl,
} from "../plugin/src/storage/embed-client.js";
import { resolveEmbedConfig, clearEmbedCache } from "../plugin/src/storage/embed-config.js";

/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = "") {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log(`  ✗ ${name} ${extra}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `实际 ${a} / 期望 ${e}`);
}
function group(title) { console.log(`\n${title}`); }

const SAMPLE_PATCH = `# 测试用 patch
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      gateway:
        displayName: 测试网关
        apiKeyEnv: TEST_API_KEY
        api: openai-completions
        baseURL: https://example.test/v1
        models:
          - id: chat-model-a
            name: chat-model-a
          - id: chat-model-b
            name: chat-model-b
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: gateway
    model: chat-model-b
`;

/* ================================================================== *
 * 一、YAML 扫描
 * ================================================================== */

group("[1] patch 解析：条目与嵌套");
{
  const entries = scanPatchEntries(SAMPLE_PATCH);
  eq("识别出 2 个顶层条目", entries.length, 2);
  eq("首个条目 id", entries[0].id, "llm-pi-ai");
  eq("首个条目 name", entries[0].name, "@deepseek-ai/dsh-llm-pi-ai");

  const p = entries[0].config?.providers?.gateway;
  ok("providers.gateway 存在", Boolean(p));
  eq("baseURL 正确", p?.baseURL, "https://example.test/v1");
  eq("apiKeyEnv 正确", p?.apiKeyEnv, "TEST_API_KEY");
  eq("displayName 正确", p?.displayName, "测试网关");

  // 这是修复过的坑：models 的列表项也写 "- id:"，
  // 若不加缩进判断会当成顶层条目，导致 models 被吃空。
  eq("models 有 2 项（不被误当顶层条目）", p?.models?.length, 2);
  eq("models[0].id", p?.models?.[0]?.id, "chat-model-a");
  eq("models[1].id", p?.models?.[1]?.id, "chat-model-b");

  eq("顶层条目数不含 models 列表项", entries.filter((e) => e.id === "chat-model-a").length, 0);
}

group("[2] patch 解析：边界情形");
{
  eq("空文本返回空数组", scanPatchEntries("").length, 0);
  eq("纯注释返回空数组", scanPatchEntries("# 只有注释\n# 再来一行").length, 0);
  eq("null 安全", scanPatchEntries(null).length, 0);

  // 引号与 !!js 标签
  const quoted = scanPatchEntries('- id: x\n  name: "y"\n  config:\n    k: \'v\'');
  eq("去引号", quoted[0]?.config?.k, "v");

  const tagged = scanPatchEntries("- id: x\n  config:\n    k: !!js process.env.A");
  eq("去 !!js 标签", tagged[0]?.config?.k, "process.env.A");

  // 行尾注释不应吃掉 URL 里的 #
  const urlLine = scanPatchEntries("- id: x\n  config:\n    baseURL: https://a.test/v1#frag  # 注释");
  eq("保留 URL 内 #，去掉行尾注释", urlLine[0]?.config?.baseURL, "https://a.test/v1#frag");
}

group("[3] 路由挑选");
{
  const entries = scanPatchEntries(SAMPLE_PATCH);
  const route = pickRoute(entries);
  eq("provider 取自 agent-default-model", route.provider, "gateway");
  eq("model 取自 agent-default-model", route.model, "chat-model-b");
  eq("baseURL 取自 providers 下同名路由", route.baseURL, "https://example.test/v1");
  eq("apiKeyEnv", route.apiKeyEnv, "TEST_API_KEY");

  // 无 agent-default-model 时退而取第一个带 baseURL 的
  const noDefault = scanPatchEntries(`- id: llm-x\n  config:\n    baseURL: https://b.test/v1\n    models:\n      - id: m1`);
  const r2 = pickRoute(noDefault);
  eq("无 default 时退回首条", r2.baseURL, "https://b.test/v1");
  eq("无 default 时取首个模型", r2.model, "m1");
}

/* ================================================================== *
 * 二、继承解析
 * ================================================================== */

group("[4] 继承解析：临时 profile");
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-mem-test-"));
  try {
    const patch = join(dir, "cordis.patch.yml");
    writeFileSync(patch, SAMPLE_PATCH, "utf8");

    const r = resolveInheritedModel({ profileContext: { home: dir } });
    eq("继承成功", r.ok, true);
    eq("读到的 model", r.model, "chat-model-b");
    eq("读到的 baseURL", r.baseURL, "https://example.test/v1");
    eq("读到的 provider", r.provider, "gateway");
    ok("patchFile 指向临时文件", r.patchFile === patch, r.patchFile);
    // 密钥在测试环境里通常不存在，此时应安静地返回空串而不是抛错
    eq("缺失密钥时返回空串不抛错", typeof r.apiKey, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

group("[5] 继承解析：无配置文件");
{
  const r = resolveInheritedModel({ profileContext: { home: join(tmpdir(), "definitely-not-exist-xyz") } });
  // 机器上可能真有 ~/.dsh，所以只断言"不抛错且结构完整"
  ok("不抛错", true);
  eq("返回字段齐全", Object.keys(r).sort(), [
    "apiKey", "apiKeyEnv", "baseURL", "displayName", "model", "ok", "patchFile", "provider", "source",
  ].sort());
  ok("ok 是布尔值", typeof r.ok === "boolean");
}

group("[6] 候选路径去重");
{
  const list = candidatePatchFiles({ profileContext: { home: "D:/x" }, configEditor: { documentPath: "D:/x/cordis.patch.yml" } });
  eq("同一路径不重复", list.length, new Set(list).size);
  ok("候选都是字符串", list.every((p) => typeof p === "string"));
}

/* ================================================================== *
 * 三、嵌入响应归一化
 * ================================================================== */

group("[7] 响应归一化");
{
  const std = normalizeEmbeddingResponse({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] });
  eq("OpenAI 标准形态", std, [[0.1, 0.2], [0.3, 0.4]]);

  const withIdx = normalizeEmbeddingResponse({
    data: [{ index: 1, embedding: [0.3] }, { index: 0, embedding: [0.1] }],
  });
  eq("按 index 还原顺序", withIdx, [[0.1], [0.3]]);

  const cohere = normalizeEmbeddingResponse({ embeddings: [[1, 2], [3, 4]] });
  eq("embeddings 数组形态", cohere, [[1, 2], [3, 4]]);

  const bare = normalizeEmbeddingResponse([[5, 6]]);
  eq("裸数组形态", bare, [[5, 6]]);

  const alt = normalizeEmbeddingResponse({ result: { embeddings: [[7]] } });
  eq("result.embeddings 形态", alt, [[7]]);

  eq("认不出返回 null", normalizeEmbeddingResponse({ foo: 1 }), null);
  eq("空 data 返回 null", normalizeEmbeddingResponse({ data: [] }), null);
  eq("null 安全", normalizeEmbeddingResponse(null), null);
}

group("[8] URL 拼接");
{
  eq("补 /embeddings", embeddingsUrl("https://a.test/v1"), "https://a.test/v1/embeddings");
  eq("去尾斜杠", embeddingsUrl("https://a.test/v1/"), "https://a.test/v1/embeddings");
  eq("已带则不重复", embeddingsUrl("https://a.test/v1/embeddings"), "https://a.test/v1/embeddings");
  eq("空返回空", embeddingsUrl(""), "");
  eq("null 安全", embeddingsUrl(null), "");
}

/* ================================================================== *
 * 四、配置解析与降级
 * ================================================================== */

group("[9] 配置解析：custom / off");
{
  clearEmbedCache();

  const off = resolveEmbedConfig({ embedSource: "off" }, {});
  eq("off 模式无 url", off.url, "");
  ok("off 模式给出说明", off.reason.length > 0);

  const custom = resolveEmbedConfig({
    embedSource: "custom",
    embedBaseURL: "https://e.test/v1",
    embedApiKey: "k-123",
    embedModel: "bge-m3",
  }, {});
  eq("custom 拼出完整 URL", custom.url, "https://e.test/v1/embeddings");
  eq("custom 带 model", custom.model, "bge-m3");
  eq("custom 无 reason", custom.reason, "");

  const partial = resolveEmbedConfig({ embedSource: "custom", embedBaseURL: "https://e.test/v1" }, {});
  ok("缺字段时 reason 非空", partial.reason.length > 0);
  ok("reason 指出缺什么", partial.reason.includes("API Key") && partial.reason.includes("模型"), partial.reason);
}

group("[10] 配置解析：inherit 失败时明确报错");
{
  clearEmbedCache();
  const r = resolveEmbedConfig({ embedSource: "inherit" }, { profileContext: { home: join(tmpdir(), "nope-xyz-123") } });
  eq("inherit 模式标记", r.mode, "inherit");
  // 本机若真有 ~/.dsh 且能读到，会 ok；此时不该有 reason
  if (!r.url) {
    ok("失败时给出可操作的 reason", r.reason.includes("自定义"), r.reason);
  } else {
    ok("成功时不报错", r.reason === "");
  }
}

group("[11] cordis 未 inject 的服务不能被直接读（踩过的坑）");
{
  // cordis 的 Context 是 Proxy：读未在 inject 里声明的服务会抛
  // `cannot get property "x" without inject`，可选链也挡不住 —— 抛错发生在
  // 属性读取那一刻。这里用一个「读什么都抛」的 Proxy 复刻该行为，确认
  // embed-config 的缓存路径不会因此炸掉。
  const hostileCtx = new Proxy({}, {
    get(_target, prop) {
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
    has() {
      // 真实 cordis 的 `in` 是安全的：未声明时安静返回 false。
      return false;
    },
  });

  clearEmbedCache();
  let threw;
  let result;
  try {
    result = resolveEmbedConfig({ embedSource: "inherit" }, hostileCtx);
  } catch (e) {
    threw = e;
  }
  ok("面对读属性即抛错的 ctx 不崩溃", threw === undefined, threw?.message);
  eq("仍然回落到 inherit 模式", result?.mode, "inherit");
  // hostile ctx 下所有路径探测都被挡掉，继承必然失败。此时不要求 reason
  // 里有什么具体字眼 —— 只要「有 url 就该没 reason、没 url 就该有 reason」
  // 这条不变量成立即可，真正的文案质量由 [10] 覆盖。
  ok(
    "引入了无效端点时说明与状态一致",
    (result?.url ? result.reason === "" : typeof result?.reason === "string" && result.reason.length > 0),
    `url=${JSON.stringify(result?.url)} reason=${JSON.stringify(result?.reason)}`,
  );


  // inherit.js 的候选路径探测同理
  let paths;
  let pathsThrew;
  try {
    paths = candidatePatchFiles(hostileCtx);
  } catch (e) {
    pathsThrew = e;
  }
  ok("候选路径探测同样不崩溃", pathsThrew === undefined, pathsThrew?.message);
  ok("返回数组（可空）", Array.isArray(paths));
}

group("[12] Config 每个字段都必须 volatile（否则设置页拿不到）");
{
  // 宿主 describe() 先用 volatileForm(schema) 过滤：只留 meta.volatile 的
  // 字段；一个都没标时返回 undefined，整个条目被跳过且不报错。这条测试
  // 锁住「不要有人手滑删掉某个 .volatile()」。
  const { Config } = await import("../plugin/src/index.js");
  // toJSON() 是引用结构：根节点自身的 dict 也在 refs[uid] 里，不在顶层。
  const json = JSON.parse(JSON.stringify(Config.toJSON()));
  const refs = json.refs ?? {};
  const resolveRef = (node) => (typeof node === "number" ? refs[node] : node);
  const root = resolveRef(json.uid);

  const fields = Object.keys(root?.dict ?? {});
  ok("配置字段数 > 0", fields.length > 0, String(fields.length));

  const notVolatile = [];
  const secrets = [];
  for (const name of fields) {
    const node = resolveRef(root.dict[name]);
    if (node?.meta?.volatile !== true) notVolatile.push(name);
    if (node?.meta?.role === "secret") secrets.push(name);
  }
  ok(
    "没有漏标 volatile 的字段",
    notVolatile.length === 0,
    notVolatile.length ? `漏标：${notVolatile.join("、")}` : "",
  );
  eq("secret 字段恰好两个", secrets.sort().join(","), "embedApiKey,jevApiKey");

  // 宿主的 describe() 用 `value !== undefined` 判断「密钥配过没有」。
  // 一旦给密钥字段加默认值，"没配过" 就永远报成 "配过"，设置页会一直
  // 显示「已配置」。这条约束很隐蔽，必须锁住。
  const secretsWithDefault = [];
  for (const name of secrets) {
    const node = resolveRef(root.dict[name]);
    if (node?.meta && Object.hasOwn(node.meta, "default")) secretsWithDefault.push(name);
  }
  ok(
    "secret 字段都没有 default（否则 describe 恒报已配置）",
    secretsWithDefault.length === 0,
    secretsWithDefault.length ? `带了默认值：${secretsWithDefault.join("、")}` : "",
  );
}

group("[13] 配置页控件必须与字段语义匹配（别退回纯文本框）");
{
  // 这一组盯的是「配置页看起来像表单」这件事本身。
  //
  // 曾经整页都是文本框：布尔字段要手打 true / false，枚举字段要手打
  // inherit / custom / off —— 能用，但不是可视化配置。宿主的
  // `dsh-client-ui-primitives` 本来就导出 Switch 与 SegmentedControl，
  // 换成它们之后，这里加断言锁住，避免以后又改回去。
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../plugin/client.js", import.meta.url), "utf8");

  // 1. 必须从 primitives 里取到这两个原生控件
  const importBlock = src.slice(
    src.indexOf("require(\"@deepseek-ai/dsh-client-ui-primitives\")") - 600,
    src.indexOf("require(\"@deepseek-ai/dsh-client-ui-primitives\")"),
  );
  ok("从 primitives 引入 Switch", /\bSwitch\b/.test(importBlock));
  ok("从 primitives 引入 SegmentedControl", /\bSegmentedControl\b/.test(importBlock));

  // 2. 布尔字段必须用 Switch 渲染，不能走 SettingsValueField
  const toggleBody = src.slice(src.indexOf("const toggleField"), src.indexOf("const enumField"));
  ok("toggleField 里渲染了 Switch", /h\(Switch,/.test(toggleBody));
  ok("toggleField 不渲染 SettingsValueField", !/SettingsValueField/.test(toggleBody));

  // 3. 枚举字段必须用 SegmentedControl
  const enumBody = src.slice(src.indexOf("const enumField"), src.indexOf("/** 一行只写密钥字段 */"));
  ok("enumField 里渲染了 SegmentedControl", /h\(SegmentedControl,/.test(enumBody));
  ok("enumField 不渲染 SettingsValueField", !/SettingsValueField/.test(enumBody));

  // 4. 三个布尔字段、两个枚举字段都要改走新控件；
  //    残留一个 valueField("autoRecall") 就说明漏改。
  const usage = src.slice(src.indexOf("group(t(\"sectionRecall\"))"));
  for (const field of ["autoRecall", "sweepOnStart", "verbose"]) {
    ok(`布尔字段 ${field} 走 toggleField`, new RegExp(`toggleField\\("${field}"`).test(usage));
    ok(`布尔字段 ${field} 不再走 valueField`, !new RegExp(`valueField\\("${field}"`).test(usage));
  }
  for (const field of ["embedSource", "storageMode"]) {
    ok(`枚举字段 ${field} 走 enumField`, new RegExp(`enumField\\("${field}"`).test(usage));
    ok(`枚举字段 ${field} 不再走 valueField`, !new RegExp(`valueField\\("${field}"`).test(usage));
  }

  // 5. 开关不能直接落盘：必须在 onChange 里写草稿，交给统一保存。
  //    直接 mutate 会让这一个字段立刻生效、其余仍是草稿，形成半保存。
  ok(
    "Switch 的 onChange 写的是草稿而非直接 mutate",
    /onChange:\s*\(next\)\s*=>\s*props\.edit\(field,/.test(toggleBody),
  );
  ok("toggleField 里没有直接 mutate 调用", !/\.mutate\(/.test(toggleBody));
}

/* ------------------------------------------------------------------ */

console.log(`\n${"=".repeat(56)}`);
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) {
  console.log("\n失败项：");
  for (const f of failures) console.log(`  · ${f}`);
}
console.log("");
process.exit(fail === 0 ? 0 : 1);

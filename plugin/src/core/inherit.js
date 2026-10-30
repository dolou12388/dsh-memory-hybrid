/**
 * 继承 dsh 客户端当前的模型配置。
 *
 * ## 为什么需要读文件，而不是问 ctx.llm
 *
 * 直觉做法是调 `ctx.llm.listProviders()` 拿 baseURL。查过契约后确认不可行：
 *
 *   interface LlmProviderInfo {
 *     id: string;      // 路由键，如 "string"
 *     name: string;    // 显示名，如 "浩瀚"
 *   }
 *
 * 只有 id 和 name，**没有 baseURL，也没有模型列表**。原因在设计上说得通：
 * 适配器注册路由时只登记身份，端点属于配置层的事，服务层不该重复暴露。
 *
 * 所以继承必须回到配置文件的真实来源：profile 的 cordis.patch.yml。
 * 那正是用户在客户端设置页里改的地方，读它就是读"用户当前在用的东西"。
 *
 * ## 三层来源，按可靠性排序
 *
 *   1. ctx.configEditor.documentPath  —— 宿主直接给出 patch 文件绝对路径
 *   2. ctx.profileContext.home        —— profile 根目录，拼 cordis.patch.yml
 *   3. ~/.dsh/profiles/<name>/        —— 按进程 argv 里的 --profile 猜
 *
 * 第 1 条最可靠，第 3 条只在前两条都拿不到时兜底。任何一条成功即止。
 *
 * ## 只读，不写
 *
 * 本模块绝不修改用户的配置文件。继承是"读现在的状态"，用户的设置页
 * 才是唯一的写入方 —— 插件越权改 profile 会让用户下次打开设置页时
 * 看到自己没改过的值。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 安全地读一个 cordis 服务。
 *
 * 为什么不能直接 `ctx.configEditor?.documentPath`：cordis 的 Context 是
 * Proxy，**读取**未在 `inject` 里声明的服务会直接抛
 * `cannot get property "x" without inject` —— 连可选链都挡不住，因为抛错
 * 发生在属性读取那一刻，早于 `?.` 生效。
 *
 * 而 `in` 运算符是安全的：未声明时安静地返回 false。所以判据是
 * 「先 `in`，再取」。
 *
 * 本插件刻意**不**把 configEditor / profileContext / credentials 写进
 * `inject`：那会让插件在这几个服务缺失时整体停在 pending（本插件踩过
 * `storageDomain` 的坑）。继承只是锦上添花，拿不到就走下一层来源，
 * 不该因此起不来。
 *
 * @param {object} ctx cordis 上下文
 * @param {string} name 服务名
 * @returns {unknown} 服务实例，或 undefined
 */
function safeService(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined;
  try {
    if (!(name in ctx)) return undefined;
    return ctx[name];
  } catch {
    return undefined;
  }
}

/** 候选 patch 文件路径。同步探测，全部不存在时返回空数组。 */
function candidatePatchFiles(ctx) {
  const out = [];

  // 1. 宿主直接给出（configEditor.documentPath / settings.documentPath）
  for (const path of [
    safeService(ctx, "configEditor")?.documentPath,
    safeService(ctx, "settings")?.documentPath,
  ]) {
    if (typeof path === "string" && path) out.push(path);
  }

  // 2. profile 根目录
  const home = safeService(ctx, "profileContext")?.home;
  if (typeof home === "string" && home) out.push(join(home, "cordis.patch.yml"));

  // 3. 按 profile 名兜底
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  const profileName = guessProfileName();
  if (profileName) out.push(join(dshHome, "profiles", profileName, "cordis.patch.yml"));
  for (const p of ["web", "desktop", "headless", "acp", "sdk"]) {
    out.push(join(dshHome, "profiles", p, "cordis.patch.yml"));
  }

  // 去重并只留存在的
  return [...new Set(out)].filter((p) => existsSync(p));
}

/** 从进程参数里找 --profile <name>。找不到返回 null。 */
function guessProfileName() {
  const argv = process.argv ?? [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--profile" && argv[i + 1]) return argv[i + 1];
    const inline = /^--profile=(.+)$/.exec(argv[i]);
    if (inline) return inline[1];
  }
  // dsh web 等价于 --profile web
  if (argv.includes("web")) return "web";
  return null;
}

/**
 * 极简 YAML 扫描：只取我们认识的字段，不引 yaml 依赖。
 *
 * 为什么不装 yaml 包：整个插件目前零依赖，为读三个字段引入解析器不划算，
 * 而且 patch 文件是人手写的、结构扁平（顶层数组 + 每项 id/name/config）。
 *
 * ⚠ 曾经踩过的坑：`- ` 开头的行不都是新条目。`models:` 下面的列表项
 *   也写成 `- id: xxx`，若不加区分就会把每个模型都当成一个顶层 patch 条目，
 *   于是 models 数组被吃空。判据是**缩进**：顶层条目的 `- ` 缩进最小，
 *   比它更深的一律视为内层列表项，归入当前 config 的对应键。
 *
 * 局限（已知且可接受）：不支持锚点、多行字符串、flow 风格嵌套。
 * patch 文件里出现这些写法时，本函数会跳过而不会崩 —— 继承失败就退回
 * 让用户手填，不会把插件搞坏。
 *
 * @param {string} text
 * @returns {Array<{id: string, name: string, config: object}>}
 */
function scanPatchEntries(text) {
  const entries = [];
  let cur = null;
  let inConfig = false;
  /** 顶层条目的 `- ` 缩进；首个条目决定，之后按它判断层级 */
  let entryIndent = -1;
  const stack = []; // [{ indent, key, list }]

  const lines = String(text ?? "").split(/\r?\n/);
  for (const raw of lines) {
    // 去掉行尾注释（只处理 ` #` 之后，避免误伤 URL 里的 #）
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (body.startsWith("- ")) {
      // 首个 `- ` 确立顶层条目缩进
      if (entryIndent < 0) entryIndent = indent;

      if (indent === entryIndent) {
        // 真正的顶层条目
        const rest = body.slice(2).trim();
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(rest);
        cur = { id: "", name: "", config: {} };
        entries.push(cur);
        inConfig = false;
        stack.length = 0;
        if (m && m[1] === "id") cur.id = unquote(m[2]);
        else if (m && m[1] === "name") cur.name = unquote(m[2]);
        continue;
      }

      // 内层列表项：归入当前 config 里"最近一个空值键"的数组
      if (cur && inConfig && stack.length) {
        const holder = stack[stack.length - 1];
        const list = Array.isArray(holder.list) ? holder.list : [];
        const rest = body.slice(2).trim();
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(rest);
        if (kv) {
          const item = {};
          item[kv[1]] = unquote(kv[2]);
          list.push(item);
        } else if (rest) {
          list.push(unquote(rest));
        }
        holder.list = list;
        setPath(cur.config, stack.map((s) => s.key), list);
      }
      continue;
    }

    if (!cur) continue;

    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(body);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2];

    if (key === "config" && val === "") {
      inConfig = true;
      stack.length = 0;
      continue;
    }
    if (!inConfig) {
      if (key === "id") cur.id = unquote(val);
      else if (key === "name") cur.name = unquote(val);
      continue;
    }

    // 在 config 块内：按缩进维护路径栈
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    if (val === "") {
      stack.push({ indent, key, list: null });
      continue;
    }
    setPath(cur.config, [...stack.map((s) => s.key), key], unquote(val));
  }

  return entries;
}

function unquote(s) {
  const t = String(s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  // 去掉 !!js 之类的标签
  return t.replace(/^!!\w+\s*/, "");
}

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const k = path[i];
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

/**
 * 从 patch 条目里挑出「当前生效的模型路由」。
 *
 * 判定顺序：
 *   1. agent-default-model 的 provider + model —— 这是用户实际在跑的
 *   2. 该 provider 对应的 llm-* 适配器条目里的 baseURL / apiKeyEnv
 *
 * 读不到 agent-default-model 时，退而取第一个带 baseURL 的 llm-* 条目。
 *
 * @param {Array} entries scanPatchEntries 的结果
 */
function pickRoute(entries) {
  const llmEntries = entries.filter((e) => /^llm-/.test(e.id ?? "") || /^@deepseek-ai\/dsh-llm-/.test(e.name ?? ""));

  let provider = "";
  let model = "";
  const def = entries.find((e) => e.id === "agent-default-model" || /dsh-agent-default-model/.test(e.name ?? ""));
  if (def) {
    provider = String(def.config?.provider ?? "");
    model = String(def.config?.model ?? "");
  }

  // pi-ai 系列把 provider 配置放在 config.providers.<route> 下
  for (const e of llmEntries) {
    const providers = e.config?.providers;
    if (providers && typeof providers === "object") {
      const routes = Object.keys(providers);
      const route = provider && providers[provider] ? provider : routes[0];
      if (!route) continue;
      const p = providers[route] ?? {};
      const models = Array.isArray(p.models) ? p.models : [];
      const pickedModel = model || String(models[0]?.id ?? "");
      return {
        provider: route,
        model: pickedModel,
        baseURL: String(p.baseURL ?? ""),
        apiKeyEnv: String(p.apiKeyEnv ?? ""),
        displayName: String(p.displayName ?? route),
      };
    }
    // 直挂式（如 llm-deepseek）：config.baseURL 直接在顶层
    if (e.config?.baseURL) {
      const models = Array.isArray(e.config.models) ? e.config.models : [];
      return {
        provider: String(e.config.provider ?? e.id.replace(/^llm-/, "")),
        model: model || String(models[0]?.id ?? ""),
        baseURL: String(e.config.baseURL ?? ""),
        apiKeyEnv: String(e.config.apiKeyEnv ?? ""),
        displayName: String(e.config.displayName ?? e.id),
      };
    }
  }

  return { provider, model, baseURL: "", apiKeyEnv: "", displayName: provider };
}

/**
 * 解析当前 dsh 客户端的模型配置。
 *
 * @param {object} ctx cordis 上下文（可以只传能拿到的那几个字段）
 * @returns {{
 *   ok: boolean, source: string, provider: string, model: string,
 *   baseURL: string, apiKeyEnv: string, apiKey: string, displayName: string,
 *   patchFile: string, reason?: string
 * }}
 */
export function resolveInheritedModel(ctx) {
  const empty = {
    ok: false, source: "none", provider: "", model: "",
    baseURL: "", apiKeyEnv: "", apiKey: "", displayName: "", patchFile: "",
  };

  const files = candidatePatchFiles(ctx);
  if (files.length === 0) {
    return { ...empty, reason: "未找到 profile 的 cordis.patch.yml" };
  }

  let lastErr = "";
  for (const file of files) {
    try {
      const entries = scanPatchEntries(readFileSync(file, "utf8"));
      if (entries.length === 0) { lastErr = "patch 文件里没有可识别的条目"; continue; }
      const route = pickRoute(entries);
      if (!route.baseURL && !route.model) { lastErr = "patch 文件里没有 baseURL / model"; continue; }

      const apiKey = route.apiKeyEnv ? readEnvKey(route.apiKeyEnv, ctx) : "";
      return {
        ok: true,
        source: "inherit",
        provider: route.provider,
        model: route.model,
        baseURL: route.baseURL,
        apiKeyEnv: route.apiKeyEnv,
        apiKey,
        displayName: route.displayName,
        patchFile: file,
      };
    } catch (e) {
      lastErr = e?.message ?? String(e);
    }
  }

  return { ...empty, reason: lastErr || "继承失败" };
}

/**
 * 解析 apiKeyEnv 指向的密钥。
 *
 * 三层：进程环境变量 → 凭据服务（ctx.credentials）→ ~/.dsh/.credentials.yaml。
 *
 * 为什么还要读最后那个文件：.credentials.yaml 的 refs 段就是普通映射，
 * 而 ctx.credentials 在某些装配（如 headless）下可能没有就绪。多一层兜底
 * 能让「继承」在更多场景成立。读不到就是空，不报错。
 */
function readEnvKey(name, ctx) {
  if (!name) return "";
  if (process.env[name]) return process.env[name];

  // 凭据服务是异步的，同步路径拿不到；调用方如需异步解析可另外走 resolveAsync
  try {
    const text = readFileSync(join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml"), "utf8");
    const m = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "m").exec(text);
    if (m) return unquote(m[1]);
  } catch { /* 没有就算了 */ }

  return "";
}

/**
 * 异步版：更完整，会走 ctx.credentials 服务。
 *
 * 写入链路本身是异步的（journal worker），所以真正发请求前用这个即可。
 *
 * @param {object} ctx
 * @param {string} name 凭据引用名，如 STRING_API_KEY
 */
export async function resolveCredential(ctx, name) {
  if (!name) return "";
  if (process.env[name]) return process.env[name];

  const cred = safeService(ctx, "credentials");
  if (cred?.resolve) {
    try {
      // CredentialRef 只是个品牌字符串，直接传原文即可，不必再引品牌函数。
      // credentials 服务按名字解析，不做语法校验以外的加工。
      const r = await cred.resolve(name);
      if (r?.value) return r.value;
    } catch { /* 退回本地文件 */ }
  }

  return readEnvKey(name, ctx);
}

export { candidatePatchFiles, scanPatchEntries, pickRoute };

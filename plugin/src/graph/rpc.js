/**
 * 图谱 RPC：把快照暴露给浏览器半（以及其他消费方）。
 *
 * 走 Connection RPC 的 **wire 约定**（channel 名 + endpoint + JSON 信封），
 * 但不走它的 `connection.rpc.handle()` 注册入口。原因见下面 `mountChannel`。
 *
 * 通道固定 `/memory-hybrid`，当前只有一个 endpoint：`graph`。
 * 这是跨包契约 —— 附属的图谱面板只认这两个名字，改名等于破坏兼容。
 */

import { buildSnapshot } from "./snapshot.js";

/** 跨包契约：附属插件按这个 channel 取数据。改动必须同步 graph/ 包。 */
export const RPC_CHANNEL = "/memory-hybrid";

/** 与 `dsh-client-connection` 内部一致的信封常量；只是 wire 格式，不是模块依赖。 */
const RPC_ID_FALLBACK = "invalid-request";

/**
 * 单次快照的节点数上限。
 *
 * 图谱面板实际能渲染的规模远小于此，但夹紧的意义不在面板：`limit` 来自
 * 网络请求，不夹就能用一次调用触发全库物化与全量序列化。
 */
const SNAPSHOT_MAX = 2000;

/**
 * 自己把 channel 挂到 webServer 的前缀路由表上。
 *
 * ## 为什么不用 `connection.rpc.handle()`
 *
 * 那个 api 长这样（`dsh-client-connection/lib/index.js`）：
 *
 * ```js
 * get rpc() {
 *   const owner = this.ctx;                       // ← connection 插件自己的 ctx
 *   return { handle: (channel, handler) => this.register(owner, channel, handler) };
 * }
 * ```
 *
 * 而 `register()` 最后一步是 `owner.webServer.register(route)`。问题在于
 * `owner` 是 **connection 服务自身的 ctx**，不是调用方的子上下文 ——
 * 它没有、也不需要 `webServer` 的 inject 许可，于是这一步稳定抛出
 *
 *     cannot get property "webServer" without inject
 *
 * 表现极具误导性：通道没注册，请求落到静态兜底，POST 拿到 405、
 * GET 拿到 404，面板只能显示 "transport failure ... HTTP 405"。
 *
 * 与其等上游修，不如自己挂：前缀路由表是公开的（`webServer.register`），
 * 信封格式也是公开的（`clientRequestSchema` / `serverResponseSchema`），
 * 两边都是稳定契约，中间那一层只是簿记。
 *
 * ## 代价与回补
 *
 * 自己挂路由少了上游的 Host/Origin 围栏与浏览器鉴权。本通道是只读投影
 * （返回本机用户的记忆摘要，不写库、不接受外部输入影响持久状态），风险
 * 面比写接口小得多，但**不等于可以裸奔**：
 *
 *   · 同一个 webServer 上通常还挂着 /api/** 的写接口，抓不到 Host 围栏
 *     就意味着任何能发起跨站请求的页面都能读到用户的记忆摘要；
 *   · 「本机」不等于「可信」—— 浏览器里的任意网页都是本机进程。
 *
 * 所以这里复用 `connection.admit(request)`：它是公开方法，返回
 * `{ peer }` 或 `{ rejection: 401|403 }`，用的正是宿主对其它通道的同一套
 * 判定。拿不到 connection 服务时（headless / 精简装配）退回一条**保守**
 * 的 Origin/Host 自检 —— 宁可让面板显示"未授权"，也不要默认放行。
 *
 * @param {import("@deepseek-ai/cordis").Context} webCtx 已就绪 webServer 的子上下文
 * @param {(endpoint: string, payload: unknown) => Promise<object>} handler
 * @returns {() => void} disposer
 */
function mountChannel(webCtx, handler) {
  const prefix = RPC_CHANNEL;

  /**
   * 请求准入。
   *
   * 优先走宿主的 `connection.admit()` —— 它实现了与其它通道完全一致的
   * Trust/Host 判定。没有 connection 服务时退回自检，且自检是**失败即拒**：
   * 写接口都在同一个 webServer 上，放行等于把记忆摘要暴露给任意网页。
   *
   * ⚠ 取服务必须用 `ctx.reflect.get()`，不能 `webCtx.connection`：
   *   cordis 对未声明的服务做属性访问保护，直接读会抛
   *   `cannot get property "connection" without inject`。而这里恰恰不能
   *   声明它 —— 顶层 inject 是硬门禁，headless 下没有 connection 会让整个
   *   插件静默 pending（本项目在 storageDomain 上踩过一次）。reflect.get
   *   是 cordis 提供的「无 inject 要求」读取入口，语义正好。
   *
   * @returns {number|undefined} 需要拒时返回 HTTP 状态码，放行返回 undefined
   */
  const admit = (req) => {
    const conn = (() => {
      try {
        const c = typeof webCtx.reflect?.get === "function"
          ? webCtx.reflect.get("connection")
          : null;
        return typeof c?.admit === "function" ? c : null;
      } catch {
        return null;
      }
    })();

    if (conn) {
      try {
        const out = conn.admit({ headers: req.headers });
        if (out?.rejection) return out.rejection;
        if (out?.peer) return undefined;
        // 既无 peer 也无 rejection：上游语义不清，按拒绝处理
        return 403;
      } catch {
        return 403;
      }
    }

    // ---- 兜底：Origin/Host 同源校验 ----
    //
    // 只接受「无 Origin」（非浏览器/同源导航）或 Origin 的 host 与请求 Host
    // 一致。这挡不住刻意伪造请求头的本地进程，但能挡住浏览器里的跨站读取 ——
    // 而后者正是本通道真正暴露的攻击面。
    const host = String(req.headers?.host ?? "");
    const origin = req.headers?.origin;
    if (!origin) return undefined;
    try {
      return new URL(String(origin)).host === host ? undefined : 403;
    } catch {
      return 403;
    }
  };

  const route = {
    kind: "prefix",
    path: prefix,
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      // 只接受 `<channel>/<endpoint>`，endpoint 单段且字符集受限。
      if (!pathname.startsWith(`${prefix}/`)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const endpoint = pathname.slice(prefix.length + 1);
      if (!endpoint || endpoint.includes("/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      if (
        req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json"
      ) {
        res.writeHead(415);
        res.end("content type must be application/json");
        return;
      }

      // 鉴权放在 body 解析**之前**：未授权的请求不该消耗解析成本，
      // 也不该从「400 还是 403」的差异里泄漏通道的内部校验顺序。
      const rejection = admit(req);
      if (rejection) {
        res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
        res.end(rejection === 401 ? "unauthorized" : "forbidden");
        return;
      }

      // 读 body。webServer 已按 prefix 路由把请求体缓冲好，这里仍自行兜底，
      // 因为 `requestBodyMode` 是可选钩子，缺省行为不由本插件决定。
      let body;
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400);
        res.end("body is not JSON");
        return;
      }

      const rpcId =
        typeof body?.rpcId === "string" && body.rpcId ? body.rpcId : RPC_ID_FALLBACK;
      if (
        body?.type !== "client-request" ||
        typeof body?.method !== "string" ||
        body.rpcId !== rpcId
      ) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "server-response",
            rpcId,
            result: {
              ok: false,
              error: {
                code: "gateway/bad-request",
                message: "invalid client-request message",
                details: { issues: [] },
              },
            },
          }),
        );
        return;
      }

      const envelope = (result) =>
        JSON.stringify({ type: "server-response", rpcId, result });

      // method 必须与 URL 里的 endpoint 一致 —— 上游同样这么校验，
      // 保持这条规则可以让将来换回 `rpc.handle` 时行为不变。
      if (body.method !== endpoint) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          envelope({
            ok: false,
            error: {
              code: "gateway/bad-request",
              message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
              details: { issues: [] },
            },
          }),
        );
        return;
      }

      let result;
      try {
        result = await handler(endpoint, body.payload);
      } catch (err) {
        // handler 自己已经把所有失败折成信封；走到这里是意外，
        // 仍然回信封而不是 500，免得浏览器端只剩 "Internal error"。
        result = {
          ok: false,
          error: { code: "internal", message: err?.message ?? String(err) },
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(envelope(result));
    },
  };

  return webCtx.effect(() => webCtx.webServer.register(route), `memory-hybrid: rpc ${prefix}`);
}

/**
 * 注册通道。
 *
 * 必须在 `ctx.inject(["webServer"], child => …)` 里调用：只有 web 部署才有
 * webServer，headless 下没有 —— 那不是错误，只是没有图谱视图。
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx 已就绪 webServer 的子上下文
 * @param {{domain: object}} deps
 * @param {{info: Function, warn: Function}} log
 * @returns {unknown} 注册产生的 disposer（随 fiber 卸载）
 */
export function registerGraphRpc(ctx, deps, log) {
  if (typeof ctx.webServer?.register !== "function") {
    log.warn("memory: webServer 不可用，图谱接口未注册（只影响图谱视图）");
    return undefined;
  }

  // rev 的语义是「数据变了没有」，不是「被问了几次」。
  // 每次调用都 +1 会让消费方永远认为数据是新的，整张图反复重绘。
  // 这里用「规模 + 最新时间戳」做指纹，只有指纹变化才推进版本号。
  let rev = 0;
  let lastFp = "";

  const handler = async (endpoint, payload) => {
    if (endpoint !== "graph") {
      return { ok: false, error: { code: "unknown-endpoint", message: `unknown endpoint "${endpoint}"` } };
    }
    try {
      // 上限必须夹紧：`limit` 来自网络，不夹的话一次 `limit: 1e9` 就会
      // 触发全库物化 + 全量 JSON 序列化，把只读接口变成 DoS 入口。
      // SNAPSHOT_MAX 与面板实际能渲染的节点数量级匹配。
      const requested = Number(payload?.limit);
      const limit = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), SNAPSHOT_MAX)
        : 0;
      const value = buildSnapshot(deps.domain, { limit });

      let maxTs = 0;
      for (const n of value.nodes) {
        const t = n.lastDecayAt ?? n.createdAt ?? 0;
        if (t > maxTs) maxTs = t;
      }
      const fp = `${value.stats.memories}:${value.stats.edges}:${Math.round(maxTs)}`;
      if (fp !== lastFp) {
        lastFp = fp;
        rev += 1;
      }
      value.rev = rev;

      return { ok: true, value };
    } catch (err) {
      // ⚠ 不要 throw 进 RPC 层：网关会包成基础设施级错误，把 code 丢掉，
      // 面板只剩 "Internal error"。失败一律走信封。
      return { ok: false, error: { code: "snapshot-failed", message: err?.message ?? String(err) } };
    }
  };

  const registered = mountChannel(ctx, handler);
  log.info(`memory: graph rpc ${RPC_CHANNEL} (endpoint: graph)`);
  return registered;
}

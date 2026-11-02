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
 * ## 代价
 *
 * 少了上游的 Host/Origin 围栏与浏览器鉴权。这对本通道可接受：
 * `/memory-hybrid/graph` 是只读投影，返回的是本机用户的记忆摘要，
 * 不写库、不接受外部输入影响持久状态。真要收紧，可以在 `fetch` 里
 * 复用 `connection.admit(request)` —— 它是公开方法。
 *
 * @param {import("@deepseek-ai/cordis").Context} webCtx 已就绪 webServer 的子上下文
 * @param {(endpoint: string, payload: unknown) => Promise<object>} handler
 * @returns {() => void} disposer
 */
function mountChannel(webCtx, handler) {
  const prefix = RPC_CHANNEL;

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
      const requested = Number(payload?.limit);
      const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
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

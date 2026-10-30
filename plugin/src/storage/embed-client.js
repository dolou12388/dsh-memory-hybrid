/**
 * 嵌入（embedding）客户端：把文本映射成向量。
 *
 * ## 为什么单独一个模块
 *
 * `storage/vector.js` 里的 `embed()` 是词袋哈希 —— 零依赖、可复现，但按
 * **字面**比对，理解不了「那家店」和「望京小腰」是一回事。本模块接入真正
 * 的语义嵌入，替换的就是那一个函数的位置（vector.js 的注释里写明了这是
 * 预留的升级点）。
 *
 * ## 与生成模型的区别
 *
 * 嵌入端点和生成端点协议相近但不是一回事：
 *
 *   POST <baseURL>/embeddings
 *   { "model": "bge-m3", "input": ["文本1", "文本2"] }
 *   → { "data": [ { "index": 0, "embedding": [0.1, ...] }, ... ] }
 *
 * OpenAI 兼容网关（含用户当前在用的那些）大多照此实现。少数厂商字段名
 * 有出入（如返回裸数组而非 {data:[...]}），`normalizeEmbeddingResponse`
 * 覆盖几种常见形态，认不出就明确报错而不是猜测。
 *
 * ## 降级原则
 *
 * 记忆系统是旁路设施。嵌入失败绝不能让对话失败：
 * 调用方拿到的永远是一个可用向量（失败时退回词袋哈希），只是质量降级。
 */

/** 单次请求最多送多少条文本。多数网关上限 2048，取 64 更稳妥。 */
const BATCH_SIZE = 64;

/** 默认超时。嵌入是旁路调用，宁可放弃也不要拖着 worker。 */
const DEFAULT_TIMEOUT_MS = 8000;

/** 归一化：语义模型输出的向量长度不一，统一到单位长度才能用余弦。 */
function l2normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  return vec;
}

/**
 * 把各种常见响应形态归一成 number[][]。
 *
 * 认得的形态：
 *   { data: [{ embedding: [...] }, ...] }        OpenAI 标准
 *   { data: [{ index: 1, embedding: [...] }] }   带 index，需按 index 排序
 *   { embeddings: [[...], ...] }                 Cohere / 部分国产网关
 *   [[...], ...]                                 裸数组
 *
 * @param {any} json
 * @returns {number[][] | null} 认不出返回 null
 */
export function normalizeEmbeddingResponse(json) {
  const pick = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const rows = [];
    for (const item of arr) {
      if (Array.isArray(item)) { rows.push(item); continue; }
      const vec = item?.embedding ?? item?.vector ?? item?.values;
      if (!Array.isArray(vec)) return null;
      rows.push({ index: Number.isInteger(item?.index) ? item.index : rows.length, vec });
    }
    // 有 index 时按 index 还原顺序；请求顺序必须与返回顺序对应
    if (rows.length && typeof rows[0] === "object" && !Array.isArray(rows[0])) {
      rows.sort((a, b) => a.index - b.index);
      return rows.map((r) => r.vec);
    }
    return rows;
  };

  if (Array.isArray(json)) return pick(json);
  if (Array.isArray(json?.data)) return pick(json.data);
  if (Array.isArray(json?.embeddings)) return pick(json.embeddings);
  if (Array.isArray(json?.result?.embeddings)) return pick(json.result.embeddings);
  return null;
}

/** 拼出 /embeddings 完整地址。容忍用户把 /embeddings 也写进 baseURL。 */
export function embeddingsUrl(baseURL) {
  const base = String(baseURL ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (/\/embeddings$/.test(base)) return base;
  return `${base}/embeddings`;
}

/**
 * 嵌入客户端。
 *
 * 每次调用都重新读 config，这样用户在设置页改完立刻生效，不必重启
 * （与 dsh 的「consumers re-resolve at each operation」约定一致）。
 */
export class Embedder {
  /**
   * @param {object} opts
   * @param {() => {url: string, apiKey: string, model: string, dim: number}} opts.resolve
   *   每次需要嵌入时调用，返回当前生效的配置。返回 null 表示未配置。
   * @param {Function} [opts.fallback] 降级实现（通常是词袋哈希 embed）
   * @param {object} [opts.log]
   */
  constructor(opts) {
    this.resolve = opts.resolve;
    this.fallback = opts.fallback ?? null;
    this.log = opts.log ?? {};
    /** 维度缓存：第一次成功请求后才知道真实维度 */
    this.dim = 0;
    this.lastError = "";
    this.okCount = 0;
    this.failCount = 0;
  }

  /** 当前是否具备语义嵌入能力（不是"配置了"，而是"上次调用成功了"） */
  get semantic() { return this.okCount > 0 && this.dim > 0; }

  /**
   * 批量嵌入。
   * @param {string[]} texts
   * @param {AbortSignal} [signal]
   * @returns {Promise<{vectors: Float32Array[], semantic: boolean, dim: number}>}
   */
  async embedBatch(texts, signal) {
    const list = (texts ?? []).map((t) => String(t ?? ""));
    if (list.length === 0) return { vectors: [], semantic: this.semantic, dim: this.dim };

    const cfg = safeResolve(this.resolve);
    if (!cfg?.url || !cfg?.model || !cfg?.apiKey) {
      return this.#degrade(list, "embedding not configured");
    }

    const out = [];
    try {
      for (let i = 0; i < list.length; i += BATCH_SIZE) {
        const chunk = list.slice(i, i + BATCH_SIZE);
        const vecs = await this.#request(cfg, chunk, signal);
        if (!vecs) return this.#degrade(list, this.lastError);
        out.push(...vecs);
      }
    } catch (e) {
      this.lastError = e?.message ?? String(e);
      return this.#degrade(list, this.lastError);
    }

    if (out.length !== list.length) {
      return this.#degrade(list, `返回条数不符：收到 ${out.length}，期望 ${list.length}`);
    }

    this.okCount += 1;
    this.failCount = 0;
    this.dim = out[0]?.length ?? this.dim;
    return { vectors: out.map((v) => l2normalize(Float32Array.from(v))), semantic: true, dim: this.dim };
  }

  /** 单条嵌入。语义不可用时返回 null，由调用方决定降级。 */
  async embedOne(text, signal) {
    const { vectors, semantic } = await this.embedBatch([text], signal);
    return semantic ? vectors[0] : null;
  }

  async #request(cfg, chunk, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // 调用方的 signal 与自身超时取先到者
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.("abort", onAbort, { once: true });

    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ model: cfg.model, input: chunk, encoding_format: "float" }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.lastError = `http-${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`;
        this.failCount += 1;
        return null;
      }

      const json = await res.json();
      const vecs = normalizeEmbeddingResponse(json);
      if (!vecs) {
        this.lastError = "响应里认不出向量字段";
        this.failCount += 1;
        return null;
      }
      return vecs;
    } catch (e) {
      const msg = e?.name === "AbortError" ? "timeout" : (e?.message ?? String(e));
      this.lastError = msg;
      this.failCount += 1;
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  /**
   * 降级：语义不可用时退回词袋哈希。
   *
   * 返回 semantic:false，调用方据此知道这批向量只供保底使用
   * （写入仍继续，只是关联质量下降）。
   */
  #degrade(list, reason) {
    this.lastError = reason ?? this.lastError;
    if (!this.fallback) return { vectors: [], semantic: false, dim: 0 };
    const dim = this.dim || 256;
    return {
      vectors: list.map((t) => l2normalize(Float32Array.from(this.fallback(t, dim)))),
      semantic: false,
      dim,
    };
  }
}

function safeResolve(fn) {
  try { return fn?.(); } catch { return null; }
}

/**
 * 探测一次：用极短文本试打 /embeddings，判断配置是否真的可用。
 *
 * 配置页的「测试」按钮与启动自检都走这里。返回结构刻意做成可直接
 * 展示给人看的形态。
 *
 * @param {{baseURL: string, apiKey: string, model: string}} cfg
 * @param {number} [timeoutMs]
 */
export async function probeEmbedding(cfg, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = embeddingsUrl(cfg?.baseURL);
  if (!url) return { ok: false, reason: "缺少 API 地址" };
  if (!cfg?.model) return { ok: false, reason: "缺少模型 id" };
  if (!cfg?.apiKey) return { ok: false, reason: "缺少 API Key" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, input: ["ping"], encoding_format: "float" }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // 常见失败原因翻译成人话，省得用户去猜
      const hint = res.status === 404
        ? "该地址没有 /embeddings 接口，可能填的是生成模型端点"
        : res.status === 401 || res.status === 403
          ? "密钥无效或无权访问该模型"
          : "";
      return { ok: false, status: res.status, reason: `HTTP ${res.status}${hint ? ` — ${hint}` : ""}`, body: text.slice(0, 240) };
    }
    let json;
    try { json = JSON.parse(text); } catch { return { ok: false, reason: "响应不是 JSON", body: text.slice(0, 240) }; }
    const vecs = normalizeEmbeddingResponse(json);
    if (!vecs?.length) return { ok: false, reason: "响应里认不出向量字段", body: text.slice(0, 240) };
    return { ok: true, url, dim: vecs[0].length, model: cfg.model };
  } catch (e) {
    return { ok: false, reason: e?.name === "AbortError" ? "超时" : (e?.message ?? String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

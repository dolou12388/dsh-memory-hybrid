/**
 * 写入前的安全检查：提示注入扫描 + 敏感信息掩码。
 *
 * ## 为什么记忆系统必须单独做这件事
 *
 * 记忆和普通 RAG 检索有一个致命差别：**它会跨会话反复回放**。
 *
 *   · 普通检索错一次，影响那一轮
 *   · 记忆投毒错一次，之后每次对话都以「你已有的记忆」身份生效
 *
 * 而记忆的内容来源极不可控 —— 用户会粘贴网页、日志、工单、第三方
 * 文档。这些文本里的「忽略之前的指令」一旦入库，就从"用户粘贴的数据"
 * 变成了"系统告诉模型的既有记忆"。这是权限层级的提升，不是内容问题。
 *
 * ## 两个动作
 *
 *   scanThreats(text)  —— 识别可疑片段，给出风险级别与理由。
 *                         critical 级拒绝写入，warn 级写入但打标记。
 *   redactSecrets(text) —— 抹掉密钥/口令/证件号/手机号等，保留可读性。
 *
 * ## 为什么是模式匹配而不是模型判定
 *
 * 写入路径在 worker 里跑，每轮一次。再挂一个模型调用会让写入尾延迟翻倍，
 * 而且模型自身也可能被同一段文本影响。规则不完美，但对已知的攻击形态
 * （覆盖指令、角色劫持、外泄诱导）足够，且完全可复现、可测试、零成本。
 */

/**
 * 威胁模式。每条带 `level` 与 `why`，命中后原样透传给用户，
 * 让「为什么这条没记住」可解释 —— 静默丢弃是最难排查的失败模式。
 *
 *   critical：直接拒绝写入。这类文本没有「作为记忆」的合法用途。
 *   warn    ：写入但标记 `tainted`，注入时附风险提示。
 */
const THREAT_PATTERNS = [
  // ---- 覆盖既有指令 ----
  {
    level: "critical",
    why: "试图覆盖既有指令",
    re: /(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|messages?)/i,
  },
  {
    level: "critical",
    why: "试图覆盖既有指令",
    re: /(忽略|无视|忘记|抛开|跳过)\s*(掉)?\s*(之前|以上|上面|前面|先前|所有|全部)?\s*(的)?\s*(所有)?\s*(指令|指示|提示词|设定|规则|要求|限制|约束)/,
  },
  {
    level: "critical",
    why: "试图重置系统提示",
    re: /(you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as\s+if\s+you\s+have\s+no)\s+(a\s+)?(new|different|unrestricted|jailbroken)/i,
  },
  {
    level: "critical",
    why: "试图重置系统提示",
    re: /(你现在是|从现在开始你是|假装你是|扮演一个没有限制|进入开发者模式|越狱模式)/,
  },
  // ---- 角色/系统标记伪造 ----
  {
    level: "critical",
    why: "伪造角色标记",
    re: /^\s*(system|assistant|developer)\s*[:：]/im,
  },
  {
    level: "critical",
    why: "伪造角色标记",
    re: /<\|?\s*(im_start|im_end|system|endoftext)\s*\|?>/i,
  },
  // ---- 外泄诱导 ----
  {
    level: "critical",
    why: "诱导泄露凭据或系统提示",
    re: /(reveal|print|output|show|repeat)\s+(me\s+)?(your\s+)?(system\s+prompt|instructions?|api\s*key|credentials?|password)/i,
  },
  {
    level: "critical",
    why: "诱导泄露凭据或系统提示",
    re: /(输出|打印|告诉我|显示|复述)\s*(你的)?\s*(系统提示|系统提示词|初始指令|密钥|密码|凭据|token)/,
  },
  // ---- 危险的持久化指令（warn：可能是合法的运维约定） ----
  {
    level: "warn",
    why: "含高危操作描述，请确认来源",
    re: /(rm\s+-rf\s+\/|format\s+[a-z]:|del\s+\/[sq]\s+|drop\s+database|truncate\s+table)/i,
  },
  {
    level: "warn",
    why: "要求无条件服从",
    re: /(无条件|无论如何|不管怎样)\s*(都)?\s*(必须|要|得)\s*(服从|执行|听从)/,
  },
  {
    level: "warn",
    why: "要求对外发送内容",
    re: /(把|将)\s*(上述|以上|这段|所有)?\s*(内容|信息|数据|记录)\s*(发送|上传|转发|同步)\s*(到|给)/,
  },
];

/**
 * 敏感信息模式。顺序有意义：先长后短，避免「sk-abc」被短模式先吃掉半截。
 *
 * 替换策略统一为「保留前缀 + ●●●●」，让用户还能认出是哪类凭据，
 * 又不留下可用内容。
 */
const SECRET_PATTERNS = [
  // OpenAI / DeepSeek / 兼容网关
  { name: "api-key", re: /\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, keep: 6 },
  // Anthropic
  { name: "api-key", re: /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g, keep: 10 },
  // AWS
  { name: "aws-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, keep: 4 },
  // GitHub
  { name: "gh-token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, keep: 6 },
  // 微信/企业微信
  { name: "wechat-key", re: /\bwx[a-z0-9]{16}\b/gi, keep: 4 },
  // Bearer 头
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, keep: 7 },
  // 私钥块
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, keep: 0 },
  // 中文口令写法。这条放在 api-key 之后：否则 "api key 是 sk-xxx" 会先被
  // 这条整段吞掉，连"api key 是"这个有用标签一起消失。用捕获组只替换值，
  // 保留标签 —— 用户看到 "密码：[已隐去口令]" 才知道这里原本是什么。
  {
    name: "password",
    re: /((?:密码|口令|密钥|api[_\s-]?key|secret|token)\s*[:：=是为]\s*)(\S{6,})/gi,
    keep: -1,
  },
  // 邮箱（弱 PII）
  { name: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, keep: 2 },
  // 中国大陆手机号
  { name: "phone", re: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, keep: 3 },
  // 身份证（18 位，末位可为 X）
  { name: "id-card", re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, keep: 3 },
  // 银行卡
  { name: "bank-card", re: /(?<!\d)\d{16,19}(?!\d)/g, keep: 4 },
];

/**
 * 扫描威胁。
 *
 * @param {string} text
 * @returns {{ level: "clean"|"warn"|"critical", hits: {why: string, level: string, sample: string}[] }}
 */
export function scanThreats(text) {
  const src = String(text ?? "");
  if (!src) return { level: "clean", hits: [] };

  const hits = [];
  for (const p of THREAT_PATTERNS) {
    const m = p.re.exec(src);
    if (!m) continue;
    hits.push({
      why: p.why,
      level: p.level,
      sample: String(m[0]).slice(0, 80),
    });
  }

  if (hits.length === 0) return { level: "clean", hits };
  const level = hits.some((h) => h.level === "critical") ? "critical" : "warn";
  return { level, hits };
}

/**
 * 抹除敏感信息。
 *
 * @param {string} text
 * @returns {{ text: string, found: string[] }} found 是命中的类别名（去重），
 *   供调用方统计与界面提示。**不返回原始值** —— 返回值会进日志与记忆。
 */
export function redactSecrets(text) {
  let out = String(text ?? "");
  const found = new Set();

  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    out = out.replace(re, (m, g1) => {
      // keep === -1：正则带捕获组，g1 是要保留的标签，只抹掉后面的值
      if (p.keep === -1) {
        found.add(p.name);
        return `${g1}[已隐去${labelOf(p.name)}]`;
      }
      // 私钥等整段替换，不留前缀
      if (p.keep === 0) {
        found.add(p.name);
        return `[已隐去${labelOf(p.name)}]`;
      }
      const head = m.slice(0, p.keep);
      // 被替换的部分用 ● 表示长度，但不精确暴露真实长度（取 4～8）
      const masked = "●".repeat(Math.min(8, Math.max(4, m.length - p.keep)));
      found.add(p.name);
      return `${head}${masked}`;
    });
  }

  return { text: out, found: [...found] };
}

function labelOf(name) {
  switch (name) {
    case "api-key": return "API Key";
    case "aws-key": return "AWS 密钥";
    case "gh-token": return "GitHub 令牌";
    case "wechat-key": return "微信密钥";
    case "bearer": return "令牌";
    case "private-key": return "私钥";
    case "password": return "口令";
    case "email": return "邮箱";
    case "phone": return "手机号";
    case "id-card": return "证件号";
    case "bank-card": return "卡号";
    default: return "敏感信息";
  }
}

/**
 * 注入前的转义：让被回放的记忆无法伪装成指令。
 *
 * 为什么只做「结构化」而不是「过滤」：召回内容需要保持可读，过度过滤会
 * 让模型看不懂。真正有效的是把内容限定在明确的引用区块里，并中和掉
 * 会破坏该区块的字符序列。
 *
 * @param {string} text
 * @returns {string}
 */
export function neutralizeForPrompt(text) {
  return String(text ?? "")
    // 行首的角色标记会被模型理解为真正的角色切换
    .replace(/^(\s*)(system|assistant|developer|user)\s*[:：]/gim, "$1$2（字面）:")
    // 常见 chat 模板标记
    .replace(/<\|?\s*(im_start|im_end|system|endoftext)\s*\|?>/gi, "[$1]")
    // 三个以上连续的 # / - 会伪造标题层级，干扰 prompt 结构
    .replace(/^#{3,}\s*/gm, "### ")
    // 极端长的无空格串会破坏排版，且通常是 base64 载荷
    .replace(/(\S{200,})/g, (m) => `${m.slice(0, 200)}…`);
}

/**
 * 一站式处理：掩码 + 扫描。写入路径调用这个。
 *
 * @param {string} text
 * @returns {{
 *   text: string, threats: object, secrets: string[],
 *   accept: boolean, reason: string
 * }}
 *   accept=false 表示应拒绝写入。
 */
export function screenForWrite(text) {
  const { text: masked, found } = redactSecrets(text);

  // 威胁扫描跑在**原文**上：掩码会把 api key 变成 ●●●●，
  // 而「告诉我你的 api key」这类诱导句本身不含真凭据，掩码后反而失去线索。
  const threats = scanThreats(text);

  const accept = threats.level !== "critical";
  const reason = accept
    ? (threats.level === "warn" ? threats.hits.map((h) => h.why).join("；") : "")
    : threats.hits.filter((h) => h.level === "critical").map((h) => h.why).join("；");

  return { text: masked, threats, secrets: found, accept, reason };
}

export { THREAT_PATTERNS, SECRET_PATTERNS };

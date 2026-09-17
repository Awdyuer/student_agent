// DeepSeek 客户端。
//
// 替代 n8n 的 `DeepSeek account` 凭据节点 + `lmChatDeepSeek` 节点。
//
// 参数沿用原工作流：model=deepseek-chat，temperature=0.4，输出 JSON 对象。
// 容错解析（parseJsonLoose）移植自 n8n 的 `Parse Agent JSON` 节点——
// 模型偶尔会用 markdown 代码块包住 JSON，或在前后加解释文字，
// 这是既有行为的一部分，不能因为换了运行时就把回退丢掉。

import { ChatDeepSeek } from "@langchain/deepseek";
import { loadLocalEnv } from "../store.mjs";

const DEFAULTS = {
  model: "deepseek-chat",
  temperature: 0.4,
  maxRetries: 2,
  timeout: 120_000,
};

/** 读取 DeepSeek 配置（每次调用都重读 .env，改密钥无需重启） */
export function getLlmConfig() {
  loadLocalEnv(undefined, true);
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "",
    model: process.env.DEEPSEEK_MODEL || DEFAULTS.model,
    temperature: Number(process.env.DEEPSEEK_TEMPERATURE ?? DEFAULTS.temperature),
  };
}

/** 供 /api/health 使用，不暴露密钥本身 */
export function getLlmStatus() {
  const config = getLlmConfig();
  return {
    provider: "deepseek",
    configured: Boolean(config.apiKey),
    model: config.model,
  };
}

/**
 * 创建 ChatDeepSeek 实例。
 * @throws {Error} 未配置 API Key 时抛出，带 `code` 供上层区分状态码
 */
export function createChatModel(overrides = {}) {
  const config = getLlmConfig();

  if (!config.apiKey) {
    const error = new Error(
      "DeepSeek 未配置，请在 classroom-chat/.env 中填写 DEEPSEEK_API_KEY。",
    );
    error.code = "LLM_NOT_CONFIGURED";
    throw error;
  }

  return new ChatDeepSeek({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { configuration: { baseURL: config.baseUrl } } : {}),
    model: config.model,
    temperature: config.temperature,
    maxRetries: DEFAULTS.maxRetries,
    timeout: DEFAULTS.timeout,
    ...overrides,
  });
}

/** 从消息对象里取出文本内容 */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  return String(content ?? "");
}

/**
 * 宽容地解析模型返回的 JSON。
 *
 * 移植自 n8n 的 `Parse Agent JSON` 节点：先直接 parse，
 * 失败则截取首个 `{` 到末个 `}` 之间的片段再试一次。
 *
 * @param {string} text
 * @returns {object|null} 解析失败返回 null，由调用方决定回退行为
 */
export function parseJsonLoose(text) {
  const source = String(text ?? "");
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // 落到下面的截取重试
  }

  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // 交给调用方走回退
    }
  }

  return null;
}

/**
 * 调用模型并要求返回 JSON 对象。
 *
 * @param {object} params
 * @param {string} params.system 系统提示词
 * @param {string} params.user 用户消息
 * @returns {Promise<{ parsed: object|null, text: string, usedFallback: boolean }>}
 */
export async function invokeJson({ system, user }) {
  const model = createChatModel();
  const response = await model.invoke([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);

  const text = messageText(response);
  const parsed = parseJsonLoose(text);

  return { parsed, text, usedFallback: parsed === null };
}

/**
 * 调用模型，返回纯文本回复。
 * 课后答疑这类不需要结构化产出的场景用它。
 */
export async function invokeText({ system, user }) {
  const model = createChatModel();
  const response = await model.invoke([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  return messageText(response);
}

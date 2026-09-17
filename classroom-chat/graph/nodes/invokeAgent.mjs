// 调用模型。
//
// 对应 n8n 的 `Teach Session Agent` + `DeepSeek Chat Model` + `Parse Agent JSON`
// 三个节点。
//
// 阶段 0 仍然用**整段原提示词**，行为与 n8n 等价——目的是先把链路跑通、
// 把前端契约对齐，不在这一步改变教学行为。
// 阶段 1 起会把提示词按 host_phase 拆成多个小段，届时本节点退化为
// 只负责"某个分支下的某次模型调用"。
//
// 用户消息模板逐字取自 n8n 部署版的 `Teach Session Agent` 节点
// （见 workflow/n8n-build/update-host-continue-rule.json），
// 包括那段"只允许使用 activeOpenPoints"的附加约束。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { invokeJson } from "../llm.mjs";
import { activeOpenPoints, buildContextText, renderOpenPoints } from "./loadContext.mjs";

const PROMPT_PATH = fileURLToPath(
  new URL("../prompts/legacy-agent.txt", import.meta.url),
);

let cachedPrompt = null;

/** 读取阶段 0 的完整提示词（进程内缓存，文件不会在运行中变化） */
function legacyPrompt() {
  if (cachedPrompt === null) {
    cachedPrompt = readFileSync(PROMPT_PATH, "utf8").trim();
  }
  return cachedPrompt;
}

/** 拼装用户消息，模板与 n8n 部署版一致 */
export function buildUserMessage(state) {
  const { rulesText, stateText, segmentText } = buildContextText(state);
  const openPoints = renderOpenPoints(activeOpenPoints(state));
  const fileCount = state.uploadedFileName ? 1 : 0;

  return `【学生消息】
${state.studentMessage || ""}

【上传文件】
文件数: ${fileCount}
文件名: ${state.uploadedFileName || ""}
文件正文:
${state.uploadedText || ""}

【老师端接口/网站材料】
${state.teacherMaterial || ""}

【状态文件】
${stateText}

【规则、格式与 KNOWLEDGE-BASE 数据】
${rulesText}

【class-point 知识点片段】
${segmentText}

【当前片段 open 标记点】
${openPoints}

列出待处理标记点时只允许使用上述 activeOpenPoints，不得列出已解决或其它片段的标记点。`;
}

/**
 * 图节点：调用模型，把原始产出放进 state。
 *
 * 模型返回的 JSON 里包含 reply 和各个待写文件的内容（阶段 0 的旧契约）。
 * 阶段 2 会把这些改成工具调用，模型不再需要手抄整份文件。
 */
export async function invokeAgent(state) {
  const { parsed, text, usedFallback } = await invokeJson({
    system: legacyPrompt(),
    user: buildUserMessage(state),
  });

  return { agentOutput: { parsed, text, usedFallback } };
}

/**
 * 从模型产出里取出某个待写文件的内容。
 *
 * 空字符串表示"本轮不改这个文件"——这是原契约的选择性更新约定，
 * 必须保留，否则每轮都会无证据覆盖全部状态文件。
 */
export function fileContentFromOutput(agentOutput, field) {
  const parsed = agentOutput?.parsed;
  if (!parsed) return "";
  const value = parsed[field];
  return typeof value === "string" ? value.trim() : "";
}

/** 取出模型给的回复文本；模型没吐合法 JSON 时退回原文 */
export function replyFromOutput(agentOutput) {
  const parsed = agentOutput?.parsed;
  if (parsed && typeof parsed.reply === "string" && parsed.reply.trim()) {
    return parsed.reply.trim();
  }
  const raw = String(agentOutput?.text || "").trim();
  return raw || "本轮处理失败，请稍后重试。";
}

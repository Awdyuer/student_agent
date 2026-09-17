// 把本轮产出写回文件系统。
//
// 对应 n8n 的 `Prepare State Writes` + `State Markdown to Binary` +
// `Write State Files` 三个节点。
//
// `State Markdown to Binary` 那一步在 n8n 里是必需的——因为 n8n 的
// readWriteFile 节点只能通过二进制属性写文件。在进程内直接用
// `writeTextFile` 写 UTF-8 文本即可，整个节点消失。
//
// 【保留的契约】
// 空字符串 = 本轮不改这个文件。这是"选择性更新"的实现方式，
// 也是防止无证据覆盖状态文件的关键，必须保留。

import { resolve } from "node:path";
import { PATHS, STATE_FILES, writeTextFile } from "../../store.mjs";
import { parseDialogueLog } from "../render.mjs";
import { fileContentFromOutput, replyFromOutput } from "./invokeAgent.mjs";

/** 标记点文件名白名单：只允许 `point-NNN.json` 形式 */
const POINT_FILE_PATTERN = /^point-\d{3}\.json$/;

/**
 * 校验并归一化模型给出的标记点文件名。
 *
 * n8n 版本直接拼接路径，模型给什么就写什么——提示词里虽然写了
 * "fileName 只允许 points 下的 json 文件名"，但从来没有代码校验过。
 * 这里补上白名单，顺带挡掉路径穿越。
 *
 * @returns {string|null} 合法则返回文件名，否则返回 null
 */
export function sanitizePointFileName(rawName) {
  const name = String(rawName || "").trim();

  // 先剥掉模型可能带上的目录部分（Windows 和 POSIX 分隔符都要处理）
  const slashIndex = Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/"));
  const fileName = slashIndex >= 0 ? name.slice(slashIndex + 1) : name;

  if (!POINT_FILE_PATTERN.test(fileName)) return null;
  return fileName;
}

/**
 * 把模型返回的 `class_point_files` 归一化成待写文件列表。
 *
 * `fileContent` 可能是字符串（模型常见行为）或对象。
 */
export function collectPointWrites(agentOutput) {
  const entries = agentOutput?.parsed?.class_point_files;
  if (!Array.isArray(entries)) return [];

  const writes = [];
  for (const entry of entries) {
    const fileName = sanitizePointFileName(entry?.fileName || entry?.name);
    if (!fileName) continue;

    const raw = entry?.fileContent ?? entry?.content;
    if (raw === undefined || raw === null) continue;

    const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
    if (!text.trim()) continue;

    writes.push({ fileName, filePath: resolve(PATHS.pointsDir, fileName), text });
  }
  return writes;
}

/**
 * 图节点：写回所有文件，并把模型给出的控制字段同步进 state。
 *
 * 阶段 0 里模型仍然手写整份 DIALOGUE-LOG.md，所以这里把它解析一遍，
 * 让 checkpointer 里的 hostPhase 等字段跟上——这样阶段 1 接管状态机时，
 * 起点就是准确的。
 */
export async function persist(state) {
  const agentOutput = state.agentOutput;
  const reply = replyFromOutput(agentOutput);

  const written = [];

  // 1. 七个状态 md：只在模型给了非空内容时才写
  for (const { field, name } of STATE_FILES) {
    const content = fileContentFromOutput(agentOutput, field);
    if (!content) continue;

    const filePath = resolve(PATHS.testDir, name);
    await writeTextFile(filePath, content);
    written.push(name);
  }

  // 2. 标记点文件
  const pointWrites = collectPointWrites(agentOutput);
  for (const { filePath, text } of pointWrites) {
    await writeTextFile(filePath, text);
    written.push(text ? filePath.split(/[\\/]/).pop() : "");
  }

  // 3. 回退：模型没吐出任何可写内容时，至少留一条痕迹
  //    对应 n8n `Prepare State Writes` 的空结果分支
  if (written.length === 0) {
    const fallbackPath = resolve(PATHS.testDir, "DIALOGUE-LOG.md");
    const existing = state.stateFiles?.dialogue_log_md || "# DIALOGUE-LOG";
    const appended = `${existing.trimEnd()}\n\n## 回退记录\n- 模型未返回可写入的状态更新\n- 本轮回复: ${reply}\n`;
    await writeTextFile(fallbackPath, appended);
    written.push("DIALOGUE-LOG.md（回退）");
  }

  return { reply, written };
}

/**
 * 从模型写出的 DIALOGUE-LOG.md 里读回控制字段，同步进 state。
 *
 * 阶段 0 专用：模型仍是状态文本的作者，代码只是跟着同步。
 * 阶段 1 会把方向反过来——代码是作者，文本是渲染产物。
 */
export function syncControlFromOutput(state) {
  const content = fileContentFromOutput(state.agentOutput, "dialogue_log_md");
  if (!content) return {};

  const { control: parsed } = parseDialogueLog(content);

  return {
    hostPhase: parsed.host_phase,
    activeSegmentId:
      parsed.active_segment_id === "无" ? null : parsed.active_segment_id,
    hostFlow: parsed.host_flow,
    speaker: parsed.speaker,
    currentTarget:
      parsed.current_target === "无" ? null : parsed.current_target,
    currentQuestion:
      parsed.current_question === "无" ? null : parsed.current_question,
    attempts: parsed.attempts,
    mastered: parsed.mastered,
    unresolved: parsed.unresolved,
    studentStatus: parsed.student_status,
    waitWhatUsed: parsed.wait_what_used,
    researchUsed: parsed.research_used,
    helpUsed: parsed.help_used,
    // 证据两段由模型供文
    evidence: extractSection(content, "本轮证据"),
    nextFocus: extractSection(content, "下次重点"),
  };
}

/** 取出某个 H2 段落的正文 */
function extractSection(markdown, heading) {
  const lines = String(markdown || "").split(/\r?\n/);
  const collected = [];
  let inside = false;

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      inside = match[1].trim() === heading;
      continue;
    }
    if (inside) collected.push(line);
  }

  return collected.join("\n").trim();
}

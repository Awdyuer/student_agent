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
//
// 【为什么标记点写入要重写】
// n8n 版本直接把模型给的 fileName 拼成路径写盘，没有任何校验。
// 实测后果：模型在讲课时记录学生提问，返回了 `point-001.json`
// ——那是**已存在**的标记点，于是原有记录被整条覆盖。
// 模型同时还编造了时间戳和 source_link，并用了 `kp_id` 这个
// 第三种字段名变体。
//
// 所以这里改成：**编号由代码分配，已存在的文件绝不覆盖**。

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  PATHS,
  STATE_FILES,
  readJsonDirectory,
  writeJsonFile,
  writeTextFile,
} from "../../store.mjs";
import { parseDialogueLog } from "../render.mjs";
import { fileContentFromOutput, replyFromOutput } from "./invokeAgent.mjs";

/** 标记点文件名白名单：只允许 `point-NNN.json` 形式 */
const POINT_FILE_PATTERN = /^point-\d{3}\.json$/;

/** 合法的标记点状态 */
const POINT_STATUS = new Set(["open", "已解决", "延后"]);

/**
 * 用于拼 source_link 的外部地址。
 *
 * 规则里说 source_link 正式环境由接口提供、当前是样例。
 * 但实测模型会自己编一个（如 `local-sample:seg-006 ...`），
 * 那种链接点不开、也没法追溯。这里统一按 server.mjs 里
 * 学生标注的同一套格式生成，保证两边一致且可点击。
 */
const PUBLIC_BASE_URL =
  process.env.CLASSROOM_CHAT_PUBLIC_URL ||
  `http://127.0.0.1:${process.env.CLASSROOM_CHAT_PORT || 4173}`;

/** 生成指向学生 workspace 的标记点链接（格式与 server.mjs 一致） */
function buildSourceLink(lessonId, pointId) {
  return `${PUBLIC_BASE_URL}/student/#course/${lessonId}?point=${pointId}`;
}

/** 剥离模型可能带上的目录部分（Windows 与 POSIX 分隔符都要处理） */
function baseName(rawName) {
  const name = String(rawName || "").trim();
  const slashIndex = Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/"));
  return slashIndex >= 0 ? name.slice(slashIndex + 1) : name;
}

/**
 * 校验模型给出的标记点文件名。
 *
 * n8n 版本从不校验——提示词里虽然写了"fileName 只允许 points 下的 json 文件名"，
 * 但那是靠模型自觉。这里补上白名单，顺带挡掉路径穿越。
 *
 * @returns {string|null} 合法则返回文件名，否则 null
 */
export function sanitizePointFileName(rawName) {
  const fileName = baseName(rawName);
  return POINT_FILE_PATTERN.test(fileName) ? fileName : null;
}

/**
 * 归一化知识点字段名。
 *
 * 存量数据里同一个含义有三种写法，模型还会继续发明新的：
 *   knowledge_point_id   （多数文件）
 *   knowledge_point_ids  （point-005，复数数组）
 *   kp_id                （模型实测输出）
 */
function canonicalKnowledgePointId(raw) {
  if (typeof raw.knowledge_point_id === "string" && raw.knowledge_point_id) {
    return raw.knowledge_point_id;
  }
  if (Array.isArray(raw.knowledge_point_ids) && raw.knowledge_point_ids.length > 0) {
    return String(raw.knowledge_point_ids[0]);
  }
  if (typeof raw.kp_id === "string" && raw.kp_id) return raw.kp_id;
  return null;
}

/** 读磁盘上标记点的最大编号，用于分配新编号 */
async function maxPointNumber() {
  const points = await readJsonDirectory(PATHS.pointsDir);
  let max = 0;
  for (const point of points) {
    const match = String(point?.point_id || "").match(/^point-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** 读一个已存在的标记点文件，不存在返回 null */
async function readExistingPoint(fileName) {
  try {
    return JSON.parse(await readFile(resolve(PATHS.pointsDir, fileName), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 判断模型这次是要**更新**已有标记点，还是**新建**一条。
 *
 * 只在一种情况下认定为更新：目标文件已存在，且模型回传的 `created_at`
 * 与该文件的 `created_at` 完全一致——说明它确实读到了那条记录。
 * 只要对不上（实测中模型会编造时间戳），就一律当作新建，
 * 宁可多一条记录，也不能覆盖学生的真实标注。
 */
function isUpdateOfExisting(existing, incoming) {
  if (!existing) return false;
  const a = String(existing.created_at || "").trim();
  const b = String(incoming?.created_at || "").trim();
  return Boolean(a) && a === b;
}

/**
 * 把模型给出的标记点补全成完整记录。
 *
 * 编号、时间戳、归属字段一律由代码决定，只保留模型真正该判断的那几个值
 * （mark_level、reason_tags、student_note、type）。
 */
function buildPointRecord(incoming, { pointId, segmentId, lessonId, knowledgePointId, now, existing }) {
  const markLevel = ["掌握", "没掌握"].includes(incoming?.mark_level)
    ? incoming.mark_level
    : "没掌握";

  const reasonTags = Array.isArray(incoming?.reason_tags)
    ? incoming.reason_tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 4)
    : [];

  const status = POINT_STATUS.has(incoming?.status) ? incoming.status : "open";

  return {
    point_id: pointId,
    student_id: "student-001",
    lesson_id: lessonId,
    segment_id: segmentId,
    knowledge_point_id: knowledgePointId,
    type: incoming?.type === "marker" ? "marker" : "question",
    mark_level: markLevel,
    reason_tags: reasonTags,
    student_note: String(incoming?.student_note || incoming?.content || "").slice(0, 500),
    // 更新时保留原链接；新建时由代码按统一格式生成，不用模型编的那个
    source_link:
      existing?.source_link || buildSourceLink(lessonId, pointId),
    status,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
}

/**
 * 规划本轮的标记点写入。
 *
 * @returns {Promise<Array<{fileName: string, record: object, mode: "create"|"update"}>>}
 */
export async function planPointWrites(agentOutput, state) {
  const entries = agentOutput?.parsed?.class_point_files;
  if (!Array.isArray(entries)) return [];

  const segmentMap = new Map(
    (state.segments || []).map((segment) => [segment.segment_id, segment]),
  );

  let nextNumber = await maxPointNumber();
  const now = new Date().toISOString();
  const planned = [];

  for (const entry of entries) {
    const targetName = sanitizePointFileName(entry?.fileName || entry?.name);
    const raw = entry?.fileContent ?? entry?.content;
    if (raw === undefined || raw === null) continue;

    let incoming;
    if (typeof raw === "string") {
      try {
        incoming = JSON.parse(raw);
      } catch {
        continue; // 模型给了坏 JSON，跳过而不是写坏文件
      }
    } else {
      incoming = raw;
    }
    if (!incoming || typeof incoming !== "object") continue;

    const existing = targetName ? await readExistingPoint(targetName) : null;
    const updating = isUpdateOfExisting(existing, incoming);

    // 更新：沿用原文件名与编号；新建：由代码分配全新编号
    let pointId;
    if (updating) {
      pointId = existing.point_id;
    } else {
      nextNumber += 1;
      pointId = `point-${String(nextNumber).padStart(3, "0")}`;
    }

    const segmentId = String(
      incoming.segment_id || existing?.segment_id || state.activeSegmentId || "",
    );
    const segment = segmentMap.get(segmentId);
    const knowledgePointId =
      canonicalKnowledgePointId(incoming) ||
      canonicalKnowledgePointId(existing) ||
      segment?.knowledge_point_ids?.[0] ||
      null;

    const record = buildPointRecord(incoming, {
      pointId,
      segmentId,
      lessonId: String(
        incoming.lesson_id || existing?.lesson_id || segment?.lesson_id || "",
      ),
      knowledgePointId,
      now,
      existing: updating ? existing : null,
    });

    planned.push({
      fileName: `${pointId}.json`,
      record,
      mode: updating ? "update" : "create",
    });
  }

  return planned;
}

/** 图节点：写回所有文件，并返回本轮实际写了什么 */
export async function persist(state) {
  const agentOutput = state.agentOutput;
  const reply = replyFromOutput(agentOutput);

  const written = [];

  // 1. 七个状态 md：只在模型给了非空内容时才写
  for (const { field, name } of STATE_FILES) {
    const content = fileContentFromOutput(agentOutput, field);
    if (!content) continue;

    await writeTextFile(resolve(PATHS.testDir, name), content);
    written.push(name);
  }

  // 2. 标记点：编号与字段由代码决定
  const pointWrites = await planPointWrites(agentOutput, state);
  for (const { fileName, record, mode } of pointWrites) {
    await writeJsonFile(resolve(PATHS.pointsDir, fileName), record);
    written.push(`${fileName}(${mode})`);
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

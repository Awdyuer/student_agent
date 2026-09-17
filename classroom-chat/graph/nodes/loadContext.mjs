// 每轮第一步：把文件系统里的内容读进 state。
//
// 对应 n8n 的四个读取节点（Read Rule Files / Read State Files /
// Read Class Point Files / Combine Sources）加 Combine Context。
//
// 与 n8n 的关键差异：
//
// n8n 每轮都从 DIALOGUE-LOG.md 重新读出 host_phase，也就是说文件是真相。
// 这里改成：状态由 checkpointer 持有，**只在一条会话的第一次装载时**
// 才从 DIALOGUE-LOG.md 播种。
//
// 这样做的两个好处：
//   1. 状态不再被文件的文本格式绑架——模型抄错一个字不再影响控制流
//   2. 刷新页面拿到新 sessionId 时，仍能从文件恢复进度
//      （n8n 版本刷新即失忆，见 docs/PROJECT-SPEC.md:280）

import {
  readKnowledgeBase,
  readPoints,
  readRuleFiles,
  readSegments,
  readStateFiles,
} from "../../store.mjs";
import { controlFromStateFiles } from "../render.mjs";

/**
 * 把 DIALOGUE-LOG.md 里的控制字段映射成 state 字段。
 * 只在会话首轮调用。
 */
function seedControlFromFiles(stateFiles) {
  const { control } = controlFromStateFiles(stateFiles);
  return {
    hostPhase: control.host_phase,
    activeSegmentId:
      control.active_segment_id === "无" ? null : control.active_segment_id,
    hostFlow: control.host_flow,
    speaker: control.speaker,
    currentTarget:
      control.current_target === "无" ? null : control.current_target,
    currentQuestion:
      control.current_question === "无" ? null : control.current_question,
    attempts: control.attempts,
    mastered: control.mastered,
    unresolved: control.unresolved,
    studentStatus: control.student_status,
    waitWhatUsed: control.wait_what_used,
    researchUsed: control.research_used,
    helpUsed: control.help_used,
  };
}

/**
 * @param {object} state
 * @returns {Promise<object>} state 的局部更新
 */
export async function loadContext(state) {
  const [ruleFiles, stateFiles, segments, points, knowledgeBase] =
    await Promise.all([
      readRuleFiles(),
      readStateFiles(),
      readSegments(),
      readPoints(),
      readKnowledgeBase(),
    ]);

  // stateFiles 为空对象 = 这条会话的首轮（checkpointer 里还没有内容）
  const isFirstTurn = !state.stateFiles || Object.keys(state.stateFiles).length === 0;

  return {
    ruleFiles,
    stateFiles,
    segments,
    points,
    knowledgeBase,
    studentId: "student-001",
    ...(isFirstTurn ? seedControlFromFiles(stateFiles) : {}),
  };
}

/**
 * 把规则文件、状态文件、课程片段拼成给模型的上下文文本。
 *
 * 对应 n8n 的 `Combine Context` 节点。
 *
 * @param {object} state
 */
export function buildContextText(state) {
  const rulesText = (state.ruleFiles || [])
    .map((file) => `### ${file.fileName}\n${file.text}`)
    .join("\n\n");

  const stateText = Object.entries(state.stateFiles || {})
    .filter(([, text]) => String(text || "").trim())
    .map(([field, text]) => `### ${field}\n${text}`)
    .join("\n\n");

  const segmentText = (state.segments || [])
    .map((segment) => {
      const content = String(segment.content || "").trim();
      const summary = String(segment.summary || "").trim();
      return [
        `### ${segment.segment_id} ${segment.title || ""}`,
        summary ? `摘要: ${summary}` : "",
        content ? `正文: ${content}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return { rulesText, stateText, segmentText };
}

/**
 * 当前片段里状态为 open 的标记点。
 *
 * 部署版提示词明确要求"列出待处理标记点时只允许使用 activeOpenPoints，
 * 不得列出已解决或其它片段的标记点"——这个过滤在 n8n 里靠提示词约束，
 * 在这里直接由代码算出来，模型没有机会列错。
 */
export function activeOpenPoints(state) {
  const segmentId = state.activeSegmentId;
  if (!segmentId) return [];

  return (state.points || []).filter(
    (point) => point.segment_id === segmentId && point.status === "open",
  );
}

/** 把 open 标记点渲染成给模型看的清单 */
export function renderOpenPoints(points) {
  if (!points || points.length === 0) return "（当前片段没有待处理的标记点）";

  return points
    .map((point) =>
      [
        `- ${point.point_id}`,
        `  mark_level: ${point.mark_level ?? "未填"}`,
        `  reason_tags: ${(point.reason_tags || []).join(" / ") || "无"}`,
        `  student_note: ${point.student_note || point.content || "无"}`,
        `  source_link: ${point.source_link || "待接口提供"}`,
      ].join("\n"),
    )
    .join("\n");
}

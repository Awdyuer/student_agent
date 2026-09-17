// 图的 state schema。
//
// 这是与 n8n 时代最本质的区别。
//
// n8n 没有"跨轮次状态"这个概念——每次执行都是全新的，工作流跑完什么都不剩。
// 所以"这节课讲到哪了"只能写进 DIALOGUE-LOG.md 的文本里，下轮再读回来，
// 并靠提示词要求模型自己维护。
//
// LangGraph 的 state 在轮次之间自动持久化（由 checkpointer 承担），
// 于是 hostPhase 成为程序里的一个字段：代码随时能读、能改、能测，
// 不再需要模型"记得"更新它。

import { Annotation } from "@langchain/langgraph";
import { HOST_PHASE, HOST_FLOW, SPEAKER, STUDENT_STATUS } from "./render.mjs";

/** 写后即覆盖——绝大多数字段的语义 */
const last = Annotation({ reducer: (_previous, next) => next });

/** 数组字段整体替换（模型每轮给出完整列表，与旧行为一致） */
const replaceList = Annotation({
  reducer: (_previous, next) => (Array.isArray(next) ? next : _previous),
  default: () => [],
});

export const TeachState = Annotation.Root({
  // --- 会话标识 -----------------------------------------------------------
  /** 会话 ID，来自前端；用作 checkpointer 的 thread_id */
  sessionId: last,
  /** 第一版固定 student-001，但所有数据结构都保留该字段以便扩展 */
  studentId: Annotation({ reducer: (_p, n) => n, default: () => "student-001" }),

  // --- 本轮输入 -----------------------------------------------------------
  studentMessage: Annotation({ reducer: (_p, n) => n, default: () => "" }),
  uploadedFileName: Annotation({ reducer: (_p, n) => n, default: () => "" }),
  uploadedText: Annotation({ reducer: (_p, n) => n, default: () => "" }),
  /** 老师端接口/网站材料，字段已预留，当前恒为空 */
  teacherMaterial: Annotation({ reducer: (_p, n) => n, default: () => "" }),

  // --- 路由 ---------------------------------------------------------------
  /**
   * 本轮消息属于哪一类。
   * 由 classify 节点用正则优先判定，模糊情况才交给模型。
   */
  intent: Annotation({ reducer: (_p, n) => n, default: () => "chat" }),

  // --- 状态机（迁移的核心：从提示词搬进代码）------------------------------
  hostPhase: Annotation({
    reducer: (_p, n) => n,
    default: () => HOST_PHASE.UNINITIALIZED,
  }),
  activeSegmentId: Annotation({ reducer: (_p, n) => n, default: () => null }),
  /** 学生已请求推进到下一步，等主持人开新片段 */
  hostFlow: Annotation({ reducer: (_p, n) => n, default: () => HOST_FLOW.NONE }),
  /** 正在处理的标记点（point_review 阶段） */
  currentPointId: Annotation({ reducer: (_p, n) => n, default: () => null }),

  // --- 会话控制（原 DIALOGUE-LOG 的控制字段）-----------------------------
  speaker: Annotation({ reducer: (_p, n) => n, default: () => SPEAKER.STUDENT }),
  currentTarget: Annotation({ reducer: (_p, n) => n, default: () => null }),
  currentQuestion: Annotation({ reducer: (_p, n) => n, default: () => null }),
  /** 同一题已尝试次数，达到 2 次触发换策略 */
  attempts: Annotation({ reducer: (_p, n) => n, default: () => 0 }),
  mastered: replaceList,
  unresolved: replaceList,
  studentStatus: Annotation({
    reducer: (_p, n) => n,
    default: () => STUDENT_STATUS.ACTIVE,
  }),
  waitWhatUsed: Annotation({ reducer: (_p, n) => n, default: () => 0 }),
  researchUsed: Annotation({ reducer: (_p, n) => n, default: () => 0 }),
  helpUsed: Annotation({ reducer: (_p, n) => n, default: () => 0 }),

  // --- 只读上下文（每轮从文件加载，不改写）--------------------------------
  /** `class agent/` 下的规则与格式文档 */
  ruleFiles: Annotation({ reducer: (_p, n) => n, default: () => [] }),
  /** `teach test/` 七个状态文件的内容 */
  stateFiles: Annotation({ reducer: (_p, n) => n, default: () => ({}) }),
  /** 课程片段（只读） */
  segments: Annotation({ reducer: (_p, n) => n, default: () => [] }),
  /** 学生标记点（可读可写） */
  points: Annotation({ reducer: (_p, n) => n, default: () => [] }),
  /** 稳定知识点目录（只读） */
  knowledgeBase: Annotation({ reducer: (_p, n) => n, default: () => [] }),

  // --- 模型产出 -----------------------------------------------------------
  /**
   * 阶段 0 保留：模型的原始 JSON 产出。
   * 阶段 2 会拆成真正的工具调用，届时该字段退场。
   */
  agentOutput: Annotation({ reducer: (_p, n) => n, default: () => null }),

  // --- 本轮证据（写回 DIALOGUE-LOG.md 的两段散文）-------------------------
  evidence: Annotation({ reducer: (_p, n) => n, default: () => "" }),
  nextFocus: Annotation({ reducer: (_p, n) => n, default: () => "" }),

  // --- 输出给前端 ---------------------------------------------------------
  reply: Annotation({ reducer: (_p, n) => n, default: () => "" }),
  /** teacher_guidance（主持人引导）| answer（普通答疑） */
  speechKind: Annotation({
    reducer: (_p, n) => n,
    default: () => "answer",
  }),
});

/**
 * 把 state 里的控制字段收成一个对象，供 `renderDialogueLog()` 使用。
 * @param {object} state
 */
export function controlFromState(state) {
  return {
    student_id: state.studentId,
    speaker: state.speaker,
    host_phase: state.hostPhase,
    active_segment_id: state.activeSegmentId || "无",
    current_target: state.currentTarget || "无",
    current_question: state.currentQuestion || "无",
    attempts: state.attempts,
    mastered: state.mastered,
    unresolved: state.unresolved,
    student_status: state.studentStatus,
    host_flow: state.hostFlow,
    wait_what_used: state.waitWhatUsed,
    research_used: state.researchUsed,
    help_used: state.helpUsed,
  };
}

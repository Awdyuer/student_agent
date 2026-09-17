// 图的组装与对外入口。
//
// 对应 n8n 的工作流定义本身（`teach-workflow.mjs` 里的
// `.add(...).to(...)` 那一串）。
//
// 【阶段 0 的形态】
// 还是一条直线：读文件 → 分类 → 调模型 → 写文件 → 出回复。
// 与 n8n 的区别只有两点：跑在进程内、状态由 checkpointer 持有。
//
// 【阶段 1 起会变成岔路口】
// classify 之后接条件边，按 hostPhase 分流到 hostEvent / lecturingQuestion /
// pointReview 等节点，每条分支只带自己那一小段提示词。

import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { TeachState } from "./state.mjs";
import { assembleOutput, buildResponse } from "./output.mjs";
import { classify } from "./nodes/classify.mjs";
import { invokeAgent } from "./nodes/invokeAgent.mjs";
import { loadContext } from "./nodes/loadContext.mjs";
import { persist, syncControlFromOutput } from "./nodes/persist.mjs";

/**
 * 写文件 + 把模型给出的控制字段同步回 state。
 *
 * 拆成两个独立函数是为了阶段 1 做准备：届时 `syncControlFromOutput`
 * 会被删掉，因为状态将改由代码决定，不再从模型输出里读。
 */
async function persistTurn(state) {
  const result = await persist(state);
  return { ...result, ...syncControlFromOutput(state) };
}

/** 产出给前端的回复结构与语音类型 */
function renderReply(state) {
  return assembleOutput(state);
}

const checkpointer = new MemorySaver();

const compiled = new StateGraph(TeachState)
  .addNode("loadContext", loadContext)
  .addNode("classify", classify)
  .addNode("invokeAgent", invokeAgent)
  .addNode("persist", persistTurn)
  .addNode("renderReply", renderReply)
  .addEdge(START, "loadContext")
  .addEdge("loadContext", "classify")
  .addEdge("classify", "invokeAgent")
  .addEdge("invokeAgent", "persist")
  .addEdge("persist", "renderReply")
  .addEdge("renderReply", END)
  .compile({ checkpointer });

export const teachGraph = compiled;

/**
 * 跑一轮对话。
 *
 * 这是 server.mjs 唯一需要调用的入口——替代原来那次
 * `fetch(N8N_CHAT_WEBHOOK, ...)` 的 HTTP 往返。
 *
 * @param {object} params
 * @param {string} params.sessionId 会话标识，用作 checkpointer 的 thread_id
 * @param {string} params.chatInput 本轮消息
 * @param {string} [params.uploadedFileName]
 * @param {string} [params.uploadedText]
 * @param {string} [params.teacherMaterial]
 * @returns {Promise<{ text: string, speech: object|null, speechKind: string, raw: object }>}
 */
export async function runTurn({
  sessionId,
  chatInput,
  uploadedFileName = "",
  uploadedText = "",
  teacherMaterial = "",
}) {
  const result = await compiled.invoke(
    {
      sessionId,
      studentMessage: String(chatInput || "").trim(),
      uploadedFileName,
      uploadedText,
      teacherMaterial,
    },
    { configurable: { thread_id: sessionId } },
  );

  return buildResponse(result);
}

/** 读取某条会话当前的图状态（调试与测试用） */
export async function getThreadState(sessionId) {
  return compiled.getState({ configurable: { thread_id: sessionId } });
}

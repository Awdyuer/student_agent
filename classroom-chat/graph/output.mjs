// 产出给前端的响应结构。
//
// 【这个契约不能变】
// classroom-chat/public/app.js:664-665 读的是：
//     data.message.text
//     data.message.speech
// 所以无论后端怎么重构，这两个字段的形态必须保持原样。
//
// n8n 时代这里很乱：`normalizeN8nResponse` 要处理 n8n 返回的各种包裹
// （数组、`{json:...}`、`{data:...}`、内嵌 JSON 字符串……），因为
// n8n 的返回结构不可控。
// 现在图的返回值是我们自己造的，那些容错逻辑全部不需要了。

import { resolveSpeechKind } from "./nodes/classify.mjs";

/** 语音类型：主持人引导会被前端自动朗读，普通答疑不会 */
export const SPEECH_KIND = {
  TEACHER_GUIDANCE: "teacher_guidance",
  ANSWER: "answer",
};

/** 图节点：算出本轮回复的语音类型 */
export function assembleOutput(state) {
  return { speechKind: resolveSpeechKind(state) };
}

/**
 * 把 state 组装成前端契约。
 *
 * @param {object} state 图跑完后的最终 state
 * @returns {{ text: string, speech: object, raw: object }}
 */
export function buildResponse(state) {
  const text = String(state.reply || "").trim() || "本轮已处理";
  const kind = state.speechKind || SPEECH_KIND.ANSWER;

  return {
    text,
    // 保持与 n8n 版本一致的形态：即使不需要朗读也给出对象，前端按 enabled 判断
    speech: {
      enabled: kind === SPEECH_KIND.TEACHER_GUIDANCE,
      kind,
      text,
    },
    raw: {
      hostPhase: state.hostPhase,
      activeSegmentId: state.activeSegmentId,
      intent: state.intent,
      speechKind: kind,
    },
  };
}

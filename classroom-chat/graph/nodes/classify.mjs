// 消息分类。
//
// 【为什么这段要变成代码】
//
// 生产提示词（`prompts/legacy-agent.txt:16-22`）用一整段列出"六类消息"，
// 然后把判断权交给模型。但六类里有五类是可以直接判定的：
//   - 命令以 `/` 开头，是确定的字符串
//   - 上传文件看 fileCount
//   - "继续"是确定的词
// 只有"学生提问 vs 答疑回答 vs 普通发言"需要语义理解。
//
// 把这些确定的部分交给代码，模型就不用每轮重新猜自己该干嘛，
// 也就不会出现"学生在讲课中提问，模型却开始讲题"这类漂移。
//
// 【已应用的规则修正】
//   D42 — `/结束` 原本不在命令清单里（`:17` 只列了 4 个命令，`:175` 却要处理它），
//         这里补上，命令表才闭合。

export const INTENT = {
  /** /上课开始 */
  HOST_START: "host_start",
  /** /开始播放 <segment_id> */
  HOST_PLAY: "host_play",
  /** /段落结束 <segment_id> */
  HOST_SEGMENT_END: "host_segment_end",
  /** /下课 */
  HOST_END: "host_end",
  /** /结束 —— D42 补入 */
  END: "end",
  /** /帮助 */
  HELP: "help",
  /** /research */
  RESEARCH: "research",
  /** ??? 或 /wait-what */
  WAIT_WHAT: "wait_what",
  /** 继续 —— 语义随 host_phase 变化，见提示词【继续事件】 */
  CONTINUE: "continue",
  /** 本轮带上传文件 */
  UPLOAD: "upload",
  /** 其余交给模型判断（提问 / 回答 / 普通发言） */
  CHAT: "chat",
};

/**
 * 主持人命令前缀。
 *
 * 与 `classroom-chat/public/app.js` 里的 `HOST_COMMANDS` 和
 * `server.mjs` 原来的 `isHostCommand()` 保持同一份定义——
 * 三处各写一份是 n8n 时代的旧账，现在收敛到这里。
 */
export const HOST_COMMANDS = ["/上课开始", "/开始播放", "/段落结束", "/下课"];

/** 该消息是否为主持人命令（用于决定回复的语音类型） */
export function isHostCommand(text) {
  const value = String(text || "").trim();
  return HOST_COMMANDS.some((command) => value.startsWith(command));
}

/** 从 `/开始播放 seg-002` 这类命令里取出片段 ID */
function extractSegmentId(text) {
  const match = String(text || "").match(/seg-[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}

/**
 * 判定本轮消息类型。
 *
 * 只做确定性判定；判断不了的一律返回 CHAT，由模型按提示词处理。
 * 这样阶段 0 的行为与 n8n 完全一致——模型仍然拿得到整段提示词。
 *
 * @param {string} message 学生/主持人的原始输入
 * @param {{ fileCount?: number }} [context]
 * @returns {{ intent: string, segmentId: string|null }}
 */
export function classifyMessage(message, context = {}) {
  const text = String(message || "").trim();
  const segmentId = extractSegmentId(text);

  if (!text) {
    return { intent: INTENT.CHAT, segmentId: null };
  }

  // 带上传文件：优先于文本判定（上传状态文件时必须走这条）
  if (Number(context.fileCount) > 0) {
    return { intent: INTENT.UPLOAD, segmentId };
  }

  if (text.startsWith("/上课开始")) return { intent: INTENT.HOST_START, segmentId };
  if (text.startsWith("/开始播放")) return { intent: INTENT.HOST_PLAY, segmentId };
  if (text.startsWith("/段落结束")) return { intent: INTENT.HOST_SEGMENT_END, segmentId };
  if (text.startsWith("/下课")) return { intent: INTENT.HOST_END, segmentId };
  // D42：原命令清单漏了 /结束，但收尾规则要求处理它
  if (text.startsWith("/结束")) return { intent: INTENT.END, segmentId };

  if (text.startsWith("/帮助")) return { intent: INTENT.HELP, segmentId };
  if (text.startsWith("/research")) return { intent: INTENT.RESEARCH, segmentId };
  if (text === "???" || text.startsWith("/wait-what")) {
    return { intent: INTENT.WAIT_WHAT, segmentId };
  }
  if (text === "继续" || text === "/继续") return { intent: INTENT.CONTINUE, segmentId };

  return { intent: INTENT.CHAT, segmentId };
}

/** 图节点：把分类结果写进 state */
export function classify(state) {
  const { intent, segmentId } = classifyMessage(state.studentMessage, {
    fileCount: state.uploadedFileName ? 1 : 0,
  });

  const update = { intent };

  // 命令里带了片段 ID 时，顺手记下——但这不等于推进状态机，
  // 状态转移由 hostEvent 节点按 hostPhase 决定。
  if (segmentId) update.activeSegmentId = segmentId;

  return update;
}

/**
 * 本轮回复应该用哪种语音类型。
 *
 * 对应 n8n 的 `Format Chat Reply` 节点里那段正则——
 * 它在用正则去匹配 DIALOGUE-LOG.md 的文本格式来判断 speaker 是不是 host。
 * 状态结构化之后，这里直接读 state 字段即可，不必再解析 markdown。
 */
export function resolveSpeechKind(state) {
  if (isHostCommand(state.studentMessage)) return "teacher_guidance";
  if (state.speaker === "host") return "teacher_guidance";
  if (state.hostPhase === "post_class") return "answer";
  return "answer";
}

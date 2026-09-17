// DIALOGUE-LOG.md 的结构化读写。
//
// 这是整个迁移的关键转折点。
//
// 在 n8n 时代，DIALOGUE-LOG.md 是"真相来源"：状态存在这个文件的文本里，
// 模型每轮读它、推断自己在哪个阶段、再把它整个写回去。模型一忘，进度就卡住。
//
// 迁移后，真相存在图的 state 里；本模块负责两件事：
//   parseDialogueLog()  — 启动时把文件里的控制字段读进 state（兼容存量数据）
//   renderDialogueLog() — 每轮结束时把 state 确定性地打印回文件
//
// 也就是说：文件从"决策依据"降级为"渲染产物"，格式不变、人照样能读，
// 但不再需要模型记得维护它。
//
// 已应用的规则决策：
//   D5  — 删除 inactivity_step（递增规则全仓库缺失，且定时器不存在）
//   46  — 统一为 student_status（原提示词里的 session_status 是笔误）
//   47  — speaker 统一为 host / student / assistant

/** 课堂阶段。第 7 个值 post_class 是为课后答疑新增的（D4）。 */
export const HOST_PHASE = {
  UNINITIALIZED: "uninitialized",
  INTRO: "intro",
  LECTURING: "lecturing",
  SEGMENT_SUMMARY: "segment_summary",
  POINT_REVIEW: "point_review",
  ENDING: "ending",
  /** 课后答疑窗口：课已结束，但 AI 正常回答并记录 */
  POST_CLASS: "post_class",
};

export const HOST_PHASES = Object.values(HOST_PHASE);

/** 本轮发言者 */
export const SPEAKER = {
  HOST: "host",
  STUDENT: "student",
  /** AI 的直接回复（与 AI 扮演的 host 区分开） */
  ASSISTANT: "assistant",
};

export const STUDENT_STATUS = {
  ACTIVE: "active",
  PRACTICING: "practicing",
  WAITING: "waiting",
  ENDED: "ended",
};

export const HOST_FLOW = {
  NONE: "none",
  /** 学生已请求进入下一步，等主持人开新片段 */
  NEXT_STEP_REQUESTED: "next_step_requested",
};

/** 无值时的占位符，沿用既有文件的写法 */
export const NONE_TEXT = "无";

/**
 * `## 会话状态` 段的字段顺序。
 *
 * 顺序固定，这样每轮渲染出来的文件 diff 干净——只有真正变化的行会变。
 * 注意这里没有 `phase` 和 `inactivity_step`：
 *   - `phase` 由 hostPhase 派生（见 deriveLegacyPhase），不再单独存储
 *   - `inactivity_step` 已删除（D5）
 */
export const CONTROL_FIELD_ORDER = [
  "student_id",
  "speaker",
  "host_phase",
  "active_segment_id",
  "current_target",
  "current_question",
  "attempts",
  "mastered",
  "unresolved",
  "student_status",
  "host_flow",
  "wait_what_used",
  "research_used",
  "help_used",
];

/** 控制字段的默认值 */
export function defaultControl() {
  return {
    student_id: "student-001",
    speaker: SPEAKER.STUDENT,
    host_phase: HOST_PHASE.UNINITIALIZED,
    active_segment_id: NONE_TEXT,
    current_target: NONE_TEXT,
    current_question: NONE_TEXT,
    attempts: 0,
    mastered: [],
    unresolved: [],
    student_status: STUDENT_STATUS.ACTIVE,
    host_flow: HOST_FLOW.NONE,
    wait_what_used: 0,
    research_used: 0,
    help_used: 0,
  };
}

/**
 * 由 hostPhase 派生旧的 `phase` 字段。
 *
 * 旧的 `phase`（未初始化 / dialogue / ended）与 `host_phase` 语义重叠，
 * 两套状态并存正是状态漂移的来源之一。现在只保留 hostPhase 作为真相，
 * `phase` 在渲染时算出来，让文件对读它的人和旧文档仍然说得通。
 */
export function deriveLegacyPhase(hostPhase) {
  if (hostPhase === HOST_PHASE.UNINITIALIZED) return "未初始化";
  if (
    hostPhase === HOST_PHASE.ENDING ||
    hostPhase === HOST_PHASE.POST_CLASS
  ) {
    return "ended";
  }
  return "dialogue";
}

/** `mastered` / `unresolved` 在文件里是分号分隔的一行；在 state 里是数组 */
function parseList(raw) {
  const text = String(raw ?? "").trim();
  if (!text || text === NONE_TEXT) return [];
  return text
    .split(/[；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatList(value) {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length > 0 ? items.join("；") : NONE_TEXT;
  }
  const text = String(value ?? "").trim();
  return text || NONE_TEXT;
}

function parseInteger(raw, fallback = 0) {
  const value = Number(String(raw ?? "").trim());
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 解析 DIALOGUE-LOG.md。
 *
 * 容错：文件缺失、字段缺失、格式跑偏都不会抛错——缺的字段用默认值补上。
 * 存量文件的 `## 会话状态` 里可能有 `phase`、`inactivity_step` 这类已废弃字段，
 * 会被忽略。
 *
 * @param {string} markdown
 * @returns {{ control: object, evidence: string, nextFocus: string }}
 */
export function parseDialogueLog(markdown) {
  const text = String(markdown || "");
  const control = defaultControl();

  // 按 H2 切段，取"会话状态"段里的 `- key: value` 行
  const sections = new Map();
  let currentSection = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      currentSection = heading[1].trim();
      sections.set(currentSection, []);
      continue;
    }
    if (currentSection) sections.get(currentSection).push(line);
  }

  const statusLines = sections.get("会话状态") || text.split(/\r?\n/);
  for (const line of statusLines) {
    const match = line.match(/^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const value = match[2].trim();

    switch (key) {
      case "student_id":
        control.student_id = value || control.student_id;
        break;
      case "speaker":
        control.speaker = Object.values(SPEAKER).includes(value) ? value : control.speaker;
        break;
      case "host_phase":
        // 不认识的取值退回 uninitialized，避免非法状态流进状态机
        control.host_phase = HOST_PHASES.includes(value)
          ? value
          : HOST_PHASE.UNINITIALIZED;
        break;
      case "active_segment_id":
        control.active_segment_id = value || NONE_TEXT;
        break;
      case "current_target":
        control.current_target = value || NONE_TEXT;
        break;
      case "current_question":
        control.current_question = value || NONE_TEXT;
        break;
      case "attempts":
        control.attempts = parseInteger(value, 0);
        break;
      case "mastered":
        control.mastered = parseList(value);
        break;
      case "unresolved":
        control.unresolved = parseList(value);
        break;
      case "student_status":
      case "session_status": // 旧文件的笔误字段，读到就当作 student_status
        if (Object.values(STUDENT_STATUS).includes(value)) {
          control.student_status = value;
        }
        break;
      case "host_flow":
        control.host_flow = Object.values(HOST_FLOW).includes(value)
          ? value
          : HOST_FLOW.NONE;
        break;
      case "wait_what_used":
        control.wait_what_used = parseInteger(value, 0);
        break;
      case "research_used":
        control.research_used = parseInteger(value, 0);
        break;
      case "help_used":
        control.help_used = parseInteger(value, 0);
        break;
      default:
        // phase / inactivity_step 等已废弃字段：忽略
        break;
    }
  }

  return {
    control,
    evidence: (sections.get("本轮证据") || []).join("\n").trim(),
    nextFocus: (sections.get("下次重点") || []).join("\n").trim(),
  };
}

/**
 * 把 state 渲染回 DIALOGUE-LOG.md。
 *
 * 控制字段由代码确定性生成；`## 本轮证据` 和 `## 下次重点` 是模型供文的内容，
 * 这两段才需要教学判断。
 *
 * @param {object} params
 * @param {object} params.control 控制字段
 * @param {string} params.evidence 本轮证据（markdown 列表或段落）
 * @param {string} params.nextFocus 下次重点
 */
export function renderDialogueLog({ control, evidence, nextFocus }) {
  const merged = { ...defaultControl(), ...control };
  const lines = ["# DIALOGUE-LOG", "", "## 会话状态"];

  for (const field of CONTROL_FIELD_ORDER) {
    let value = merged[field];
    if (field === "mastered" || field === "unresolved") {
      value = formatList(value);
    } else if (Array.isArray(value)) {
      value = formatList(value);
    } else if (value === null || value === undefined || value === "") {
      value = NONE_TEXT;
    }
    lines.push(`- ${field}: ${value}`);
  }

  // 派生字段：让文件对人和旧文档仍然说得通，但不是真相来源
  lines.push(`- phase: ${deriveLegacyPhase(merged.host_phase)}`);

  lines.push("", "## 本轮证据");
  lines.push(String(evidence || "").trim() || `- ${NONE_TEXT}`);
  lines.push("", "## 下次重点");
  lines.push(String(nextFocus || "").trim() || `- ${NONE_TEXT}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * 从整份状态文件集合里取出 DIALOGUE-LOG 并解析。
 * @param {Record<string, string>} stateFiles `readStateFiles()` 的结果
 */
export function controlFromStateFiles(stateFiles) {
  return parseDialogueLog(stateFiles?.dialogue_log_md || "");
}

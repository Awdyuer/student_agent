// 0-5 星掌握度规则。
//
// 唯一权威来源是 `class agent/class-interaction/MASTERY-STAR-RULES.md`。
// 本模块由 server.mjs（学生标注路径）与 graph/（AI 答疑路径）共同使用——
// 这两条写入路径过去是完全分离的，各写各的，是 n8n 时代最大的缺口。
//
// 星级与状态的对应关系：
//   0 未检测    有知识点，但无任何标注 / 答题 / 考核记录
//   1 已标注    产生与该知识点关联的有效标注
//   2 初步理解  能识别概念或复述要点，仍需明显提示
//   3 理解中    能用自己的话解释，并完成带提示的基础任务
//   4 接近掌握  能独立解释并完成基础任务，但未通过正式考核
//   5 已掌握    通过正式考核，证据满足掌握表现

/** 星级 → 状态名。前端不显示星星时状态为"未检测"。 */
export const STAR_STATUS = {
  0: "未检测",
  1: "已标注",
  2: "初步理解",
  3: "理解中",
  4: "接近掌握",
  5: "已掌握",
};

/** 考核状态，只允许这三个值 */
export const ASSESSMENT_STATUS = {
  NONE: "未考核",
  IN_PROGRESS: "考核中",
  PASSED: "已通过",
};

/**
 * 掌握变化的来源。
 *
 * `post_class` 是为课后答疑新增的（区别于课内答疑的 `dialogue`），
 * 这样 `mastery-history.json` 能区分证据产生于课内还是课后。
 */
export const MASTERY_SOURCE = {
  CLASS_POINT: "class_point",
  DIALOGUE: "dialogue",
  POST_CLASS: "post_class",
  ASSESSMENT: "assessment",
  MANUAL: "manual",
  KNOWLEDGE_BASE: "knowledge_base",
};

/**
 * 各来源能把星级推到多高。
 *
 * - 标注（class_point）只到 1 星：学生自报"掌握"不等于掌握证据
 * - 课内答疑（dialogue）到 4 星：2-4 星来自答疑过程中表现出的真实理解
 * - 课后答疑（post_class）封顶 2 星：课后来问通常正是因为没懂，问明白就算初步理解，
 *   但课外的松散问答不足以证明"理解中"及以上
 * - 正式考核（assessment）才能到 5 星
 * - 手动（manual）不设限：老师直接改，属于人工裁决
 */
export function maxStarsForSource(source) {
  switch (source) {
    case MASTERY_SOURCE.ASSESSMENT:
      return 5;
    case MASTERY_SOURCE.POST_CLASS:
      return 2;
    case MASTERY_SOURCE.CLASS_POINT:
      return 1;
    case MASTERY_SOURCE.MANUAL:
      return 5;
    case MASTERY_SOURCE.DIALOGUE:
      return 4;
    default:
      return 4;
  }
}

/** 把 0-5 之外的取值钳制回合法范围 */
export function clampStars(value) {
  return Math.max(0, Math.min(5, Number(value) || 0));
}

/** 旧版四值掌握度 → 星级（v1 数据迁移用） */
export function legacyStatusToStars(status) {
  if (status === "掌握") return 4;
  if (status === "部分掌握") return 3;
  if (status === "未掌握") return 1;
  return 0;
}

/** 星级 → 默认考核状态 */
export function defaultAssessmentStatus(stars) {
  return stars === 5 ? ASSESSMENT_STATUS.PASSED : ASSESSMENT_STATUS.NONE;
}

/**
 * 归一化掌握状态。
 *
 * 以知识点目录为全集：`mastery-state.json` 里缺失的知识点会被补成 0 星，
 * 多出来的知识点会被丢弃。这样掌握表始终与知识点目录对齐。
 *
 * @param {object} rawState `mastery-state.json` 的原始内容
 * @param {Array<{kp_id: string}>} knowledgePoints 知识点目录
 */
export function normalizeMasteryState(rawState, knowledgePoints) {
  const source =
    rawState && typeof rawState === "object" && rawState.knowledge_points
      ? rawState.knowledge_points
      : rawState || {};

  const states = {};
  for (const knowledgePoint of knowledgePoints) {
    const raw = source[knowledgePoint.kp_id];

    // v1 扁平格式：值是一个中文字符串
    if (typeof raw === "string") {
      const stars = legacyStatusToStars(raw);
      states[knowledgePoint.kp_id] = {
        kp_id: knowledgePoint.kp_id,
        stars,
        status: STAR_STATUS[stars],
        assessment_status: defaultAssessmentStatus(stars),
        annotation_ids: [],
        last_annotation_id: null,
        last_source: MASTERY_SOURCE.MANUAL,
        last_evidence: `从旧状态“${raw}”迁移。`,
        updated_at: null,
      };
      continue;
    }

    const stars = clampStars(raw?.stars);
    states[knowledgePoint.kp_id] = {
      kp_id: knowledgePoint.kp_id,
      stars,
      status: raw?.status || STAR_STATUS[stars],
      assessment_status: raw?.assessment_status || defaultAssessmentStatus(stars),
      annotation_ids: Array.isArray(raw?.annotation_ids) ? raw.annotation_ids : [],
      last_annotation_id: raw?.last_annotation_id || null,
      last_source: raw?.last_source || MASTERY_SOURCE.KNOWLEDGE_BASE,
      last_evidence: raw?.last_evidence || "",
      updated_at: raw?.updated_at || null,
    };
  }

  return {
    version: 2,
    student_id: rawState?.student_id || "student-001",
    updated_at: rawState?.updated_at || null,
    knowledge_points: states,
  };
}

/**
 * 计算一次证据应当把星级推到多少。
 *
 * 只在"有真实证据"时才调用；无证据时应保留原星级、只更新标注状态与最近证据。
 *
 * @param {object} params
 * @param {number} params.oldStars 当前星级
 * @param {number} params.proposedStars 证据支持的星级
 * @param {string} params.source 证据来源
 * @returns {{ stars: number, capped: boolean, ceiling: number }}
 */
export function applyStarCeiling({ oldStars, proposedStars, source }) {
  const ceiling = maxStarsForSource(source);
  const capped = clampStars(proposedStars) > ceiling;
  return {
    stars: Math.max(clampStars(oldStars), Math.min(clampStars(proposedStars), ceiling)),
    capped,
    ceiling,
  };
}

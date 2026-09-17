// 共享的路径常量与文件读写工具。
//
// 由 server.mjs 与 graph/ 共同使用。这些函数原本内联在 server.mjs 中，
// 抽取出来是为了让图节点和 HTTP 服务共用同一套读写语义，
// 避免"两套实现各自漂移"——这正是 n8n 时代的老问题。
//
// 容错语义（必须保留）：坏文件静默跳过，不让单个损坏的 JSON 导致整个请求 500。

import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = fileURLToPath(new URL("./", import.meta.url));

/** 仓库根目录 */
export const PROJECT_DIR = resolve(SERVER_DIR, "..");

export const PATHS = {
  /** 老师规则与格式文档，只读 */
  agentDir: resolve(PROJECT_DIR, "class agent"),
  /** 本节课运行状态，可读写 */
  testDir: resolve(PROJECT_DIR, "teach test"),
  classPointDir: resolve(PROJECT_DIR, "class-point"),
  /** 课程片段，只读 */
  segmentsDir: resolve(PROJECT_DIR, "class-point", "segments"),
  /** 学生标记点，可读写 */
  pointsDir: resolve(PROJECT_DIR, "class-point", "points"),
  /** 学生掌握档案，可读写 */
  workspaceDataDir: resolve(PROJECT_DIR, "student-workspace", "data"),
  /** 稳定知识点目录，只读 */
  knowledgeBaseFile: resolve(PROJECT_DIR, "class agent", "KNOWLEDGE-BASE.md"),
  envFile: resolve(SERVER_DIR, ".env"),
};

/**
 * `teach test` 下的七个状态文件。
 *
 * 字段名沿用 n8n 工作流的契约（`tmission_md` 等），
 * 因为模型输出和既有状态文件都以此为约定，改名会引入无谓的迁移成本。
 */
export const STATE_FILES = [
  { field: "tmission_md", name: "TMISSION.md" },
  { field: "smission_md", name: "SMISSION.md" },
  { field: "notes_md", name: "NOTES.md" },
  { field: "lesson_interaction_md", name: "LESSON-INTERACTION.md" },
  { field: "glossary_md", name: "GLOSSARY.md" },
  { field: "learning_record_md", name: "LEARNING-RECORD.md" },
  { field: "dialogue_log_md", name: "DIALOGUE-LOG.md" },
];

export const STATE_FILE_BY_FIELD = new Map(
  STATE_FILES.map((entry) => [entry.field, entry]),
);
export const STATE_FILE_BY_NAME = new Map(
  STATE_FILES.map((entry) => [entry.name, entry]),
);

// ---------------------------------------------------------------------------
// .env 加载
// ---------------------------------------------------------------------------

/**
 * 读取 `.env` 文件并写入 process.env。
 *
 * @param {string} filePath
 * @param {boolean} override 为 true 时覆盖已有的环境变量（用于热更新密钥）
 */
export function loadLocalEnv(filePath = PATHS.envFile, override = false) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value && (override || !process.env[key])) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// 基础读写
// ---------------------------------------------------------------------------

/** 读取 JSON 文件；解析失败或文件不存在时返回 fallback（不抛错） */
export async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

/** 读取目录下所有 `.json` 文件；坏文件静默跳过，目录不存在返回 [] */
export async function readJsonDirectory(directory) {
  try {
    const files = await readdir(directory);
    const records = [];

    for (const fileName of files) {
      if (!fileName.toLowerCase().endsWith(".json")) continue;
      const record = await readJsonFile(resolve(directory, fileName), null);
      if (record) records.push(record);
    }

    return records;
  } catch {
    return [];
  }
}

/** 读取单个文本文件；失败返回空字符串 */
export async function readTextFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/** 写文本文件，统一 UTF-8 + 结尾换行（与既有状态文件保持一致） */
export async function writeTextFile(filePath, content) {
  const body = String(content ?? "");
  await writeFile(filePath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
}

/** 写 JSON 文件，2 空格缩进 + 结尾换行（与既有数据文件保持一致） */
export async function writeJsonFile(filePath, value) {
  await writeTextFile(filePath, JSON.stringify(value, null, 2));
}

/**
 * 递归读取目录下所有匹配后缀的文本文件。
 *
 * 对应 n8n 的 `readWriteFile` + glob（`class agent/**\/*.md`）。
 */
export async function readTextDirectory(directory, extensions = [".md"]) {
  const results = [];

  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        results.push({
          fileName: entry.name,
          filePath: full,
          text: await readTextFile(full),
        });
      }
    }
  }

  await walk(directory);
  return results.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

// ---------------------------------------------------------------------------
// 领域读取
// ---------------------------------------------------------------------------

/** 读取 `teach test/` 下七个状态文件的当前内容，返回 `{ 字段名: 文本 }` */
export async function readStateFiles() {
  const result = {};
  for (const { field, name } of STATE_FILES) {
    result[field] = await readTextFile(resolve(PATHS.testDir, name));
  }
  return result;
}

/**
 * 读取 `class agent/` 下的规则与格式文档。
 *
 * 对应 n8n 的 `/data/class-teach/class agent/**\/*.md`。
 * 只读——规则只能由老师维护。
 */
export async function readRuleFiles() {
  return readTextDirectory(PATHS.agentDir, [".md", ".yaml"]);
}

/** 读取课程片段并按 `order` 排序 */
export async function readSegments() {
  const segments = await readJsonDirectory(PATHS.segmentsDir);
  return segments.sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
}

/** 读取学生标记点，按创建时间倒序 */
export async function readPoints() {
  const points = await readJsonDirectory(PATHS.pointsDir);
  return points.sort((left, right) =>
    String(right.created_at || "").localeCompare(String(left.created_at || "")),
  );
}

/**
 * 解析 `class agent/KNOWLEDGE-BASE.md` 的知识点目录。
 *
 * 格式严格：每个知识点为 `## KP-xxx 标题`，下辖 `- 定义: ` / `- 检测问题: ` / `- 掌握表现: ` 三个字段。
 * 字段名是中文 + 半角冒号 + 空格，不合规的行会被静默忽略（无报错）。
 */
export function parseKnowledgeBase(markdown) {
  const blocks = String(markdown || "").split(/^## /m).slice(1);
  const knowledgePoints = [];

  for (const block of blocks) {
    const [heading = "", ...lines] = block.split(/\r?\n/);
    const headingMatch = heading.trim().match(/^(KP-\d+)\s+(.+)$/);
    if (!headingMatch) continue;

    const item = {
      kp_id: headingMatch[1],
      title: headingMatch[2].trim(),
      definition: "",
      detection_question: "",
      mastery_criteria: "",
      order_index: knowledgePoints.length + 1,
    };

    for (const line of lines) {
      const fieldMatch = line.match(/^-\s*(定义|检测问题|掌握表现):\s*(.+)$/);
      if (!fieldMatch) continue;

      if (fieldMatch[1] === "定义") item.definition = fieldMatch[2].trim();
      if (fieldMatch[1] === "检测问题") item.detection_question = fieldMatch[2].trim();
      if (fieldMatch[1] === "掌握表现") item.mastery_criteria = fieldMatch[2].trim();
    }

    knowledgePoints.push(item);
  }

  return knowledgePoints;
}

/** 读取并解析知识点目录 */
export async function readKnowledgeBase() {
  return parseKnowledgeBase(await readTextFile(PATHS.knowledgeBaseFile));
}

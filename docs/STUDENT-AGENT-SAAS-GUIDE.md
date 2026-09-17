# 学生端智能体 SaaS 部署与集成指南

基于当前代码的运行链路与上线清单  |  版本 1.0  |  2026-09-17

适用对象：SaaS 平台架构、部署、后端、前端与运维人员。本文说明**当前代码实际如何运行**以及**移植到多租户 SaaS 前要补齐什么**，两者不混同。

> **与教师端的关键差异**：教师端平台（OpenMAIC）当前**不依赖 LangGraph**，其部署指南明确将 LangGraph 列为非必需组件。本仓库的课堂编排**已经构建在 LangGraph 上**——这是两者最大的架构分叉，集成时不要假定它们可以共用同一套编排假设。

---

## 1. 先看结论：当前产品边界

| 模块 | 当前代码中的状态 | 部署含义 |
| --- | --- | --- |
| 课堂对话页（学生主入口） | `classroom-chat/server.mjs` 提供，单进程 Node HTTP 服务。聊天、主持人指令、语音朗读都在这一页 | 零框架依赖，Node 原生 `http`；新增 LangGraph 依赖后不再是"零依赖" |
| 学生 workspace | `/student/` 路由，展示课程、掌握星级、标注记录，支持学生自己打标注 | 与课堂对话共用同一个 Node 进程和文件系统 |
| 课堂编排 | **LangGraph**（`classroom-chat/graph/`）。读文件 → 分类 → 调模型 → 写文件 | 图跑在 Web 进程内，无独立服务、无 Docker |
| 模型调用 | DeepSeek `deepseek-chat`，`temperature=0.4`，要求返回 JSON | 需要出网访问模型 API；密钥只在服务端 `.env` |
| 语音合成 | 阿里云百炼 Qwen TTS，可选。未配置时回退浏览器内置语音 | 非必需组件；未配置不影响主链路 |
| 数据存储 | **纯文件系统**，无数据库 | SaaS 迁移的最大缺口，见第 6 节 |
| 会话状态 | LangGraph `MemorySaver`（**进程内存**） | 进程重启即失忆；刷新页面靠 `DIALOGUE-LOG.md` 恢复 |
| 多学生 | `student_id` 硬编码为 `student-001` | 单学生原型，多租户能力尚未建立 |

**一句话结论**：主链路可以跑通并有真实模型调用，但它是**单进程、单学生、纯文件**的原型。距离"每个学生一个学习智能体"的 SaaS 目标，缺的不是模型能力，而是身份、并发、持久化和与教师平台的数据接口。

---

## 2. 学生端的页面与路径

| 页面 | 路由 | 学生操作与后端依赖 |
| --- | --- | --- |
| 课堂对话 | `/` | 课堂主界面。学生在这里发言、提问；主持人指令也从这里输入。调用 `POST /api/chat` |
| 学习空间 | `/student/` | 课程中心、课内嵌课堂对话（iframe）、掌握星级、查缺补漏、标注记录 |
| 打标注 | `/student/` 内表单 | `POST /api/workspace/annotations`，写标记点并自动升 1 星 |
| 语音 | 任意回复 | `POST /api/tts`，单段 ≤ 600 字符，服务端内存缓存 64 条 |

> **注意**：当前课堂对话页同时服务"主持人"和"学生"两个角色——没有独立的教师入口。主持人指令（`/开始播放` 等）和学生发言从同一个输入框进入，靠 `speaker` 字段区分。真实课堂部署时这是必须拆分的一处。

---

## 3. 一次课堂的三条链路

课堂阶段由 `host_phase` 驱动，共 7 个值：

```
uninitialized → intro → lecturing → segment_summary → point_review
                                      ↓                    ↓
                                   （继续）──────────────→ segment_summary
   
任意阶段 ──/下课 或 /结束──→ ending → post_class（课后答疑，一直开放）
```

### 3.1 主持人事件链

| 事件 | 当前实现 | 部署注意 |
| --- | --- | --- |
| `/上课开始`（兼容 `/开始上课`） | 以主持人身份介绍主题与节奏，**不提问**；`host_phase → intro` | 平台事件接口接入前，靠学生/教师在输入框手打 |
| `/开始播放 <seg-id>` | 宣布播放，`host_phase → lecturing`，记录 `active_segment_id` | 片段 ID 必须来自已发布课件，当前读本地 `class-point/segments/` |
| `/段落结束 <seg-id>` | 做片段总结，列出该片段 `status=open` 的标记点请学生选择 | 列出标记点的过滤由代码完成，模型无法列错 |
| `/下课` | 总结整节课，然后执行 `/结束` 的收尾规则 | |

> **已知缺口**：`/段落结束` 目前**不会把 `host_phase` 置为 `segment_summary`**——原提示词里只描述了行为、没有状态赋值，全靠模型自行推断。这会导致进度卡在 `lecturing`，后续"学生选标记点"的分支永远不触发。**修复在迁移阶段 1**，尚未完成。

### 3.2 课堂提问链（打断抑制）

| 环节 | 当前实现 | 说明 |
| --- | --- | --- |
| 学生上课中提问 | **不讲解、不评价、不追问**，只回复一句"已记下，等这一段讲完一起处理" | 由 `host_phase=lecturing` 门控 |
| 落成标记点 | 写 `class-point/points/point-NNN.json`，`type=question`、`mark_level=没掌握`、`reason_tags` 含 `课堂提问` | **编号与字段由代码分配**，模型只提供问题原文 |
| 掌握度 | 关联知识点后最低升为 1 星 | 学生自报"掌握"不等于掌握证据，不产生 5 星 |

> **这里修过一个真实缺陷**：原实现直接采用模型返回的文件名，实测中模型复用了已存在的 `point-001.json`，**覆盖了学生的真实标注**。现在编号由代码分配、已存在的文件绝不覆盖。详见提交 `d68d779`。

### 3.3 标记点答疑链

| 环节 | 当前实现 | 说明 |
| --- | --- | --- |
| 进入答疑 | 学生选择 `point_id`，`host_phase → point_review` | 读取所属片段与知识点 |
| 策略选择 | `mark_level × reason_tags` → 教学策略（从基础讲 / 快速重讲 / 追问缺口） | 策略映射可由代码决定，**话术执行**必须留给模型 |
| 对话规则 | 答对简短确认并推进；部分答对追问更小缺口；答错先给提示不讲答案；同一题两次未答对换策略；**每次只问一个问题** | 纯教学法，必须留在提示词 |
| 结束时 | 更新该标记点 `status` 为 `已解决` 或 `延后` | "继续"本身不能作为掌握证据 |
| 课后答疑 | **设计已定、代码未实现**。规则为：`/结束` 后进入 `post_class`，AI **正常回答**并记录到 `dialogue-log.json`，证据**最多升到 2 星** | `HOST_PHASE.POST_CLASS` 已定义、`maxStarsForSource()` 已写好，但**尚无对应节点，函数也未被调用**。属迁移阶段 3 |

---

## 4. 运行形态与最小依赖

| 级别 | 组件 / 配置 | 要求 |
| --- | --- | --- |
| **必须：跑通主链路** | Node.js ≥ 20（实测 22.16）；`npm install`；可访问的 DeepSeek API | `npm install && node classroom-chat/server.mjs`，或双击 `start-classroom-chat.cmd`。默认 `127.0.0.1:4173` |
| **必须：模型密钥** | `classroom-chat/.env` 内的 `DEEPSEEK_API_KEY` | 未配置时 `/api/health` 返回 503、`/api/chat` 返回 `LLM_NOT_CONFIGURED`，页面明确提示，不会静默失败 |
| **必须：SaaS 持久化** | PostgreSQL（**当前完全没有**） | 课程数据、标记点、掌握档案、会话状态都还是文件。多实例部署会互相覆盖，SaaS 前必须落库 |
| 按需 | Qwen TTS（`TTS_QWEN_API_KEY`） | 未配置自动回退浏览器语音，不影响文字链路 |
| 非必需 | Docker、Redis、消息队列 | 当前架构不需要；图跑在 Web 进程内 |
| 已移除 | **n8n** | 原编排层已从运行时路径移除（迁移阶段 0 完成），`workflow/` 目录仅作历史留档 |

**资源起点建议**：单实例 1–2 vCPU、2–4 GB RAM 即可支撑一路课堂。真正的成本在模型调用（每轮一次完整上下文），不在计算。

---

## 5. 配置、存储与迁移注意事项

| 配置项 | 作用 / 当前行为 | 生产要求 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 模型调用密钥。仅服务端 `.env` 读取，不下发浏览器 | 密钥托管与轮换；禁止写入会提交的模板文件 |
| `DEEPSEEK_MODEL` / `DEEPSEEK_TEMPERATURE` | 模型与随机性。默认 `deepseek-chat` / `0.4` | 温度过高会导致模型写坏 JSON。项目要求严格 JSON 输出 |
| `DEEPSEEK_BASE_URL` | 走代理或自建网关时填写 | 留空即用官方地址 |
| `TTS_QWEN_API_KEY` | 语音合成密钥，可选 | 未配置时能力降级，不报错 |
| `CLASSROOM_CHAT_HOST` / `PORT` | 监听地址与端口，默认 `127.0.0.1:4173` | SaaS 部署需置于反向代理之后并处理 CORS |

### 数据分层

| 层 | 位置 | 当前载体 | 生命周期 |
| --- | --- | --- | --- |
| 老师规则与知识点目录 | `class agent/` | Markdown + YAML | 只读，AI 不得改写 |
| 课程片段 | `class-point/segments/` | JSON | 只读，来自课件 |
| 学生标记点 | `class-point/points/` | JSON | 长期保存，可读写 |
| 本课运行状态 | `teach test/` | 7 个 Markdown | 当前课堂有效 |
| 掌握状态与历史 | `student-workspace/data/` | JSON | 长期保存，历史只追加 |
| 完整问答 | `student-workspace/data/dialogue-log.json` | JSON | 只追加，不覆盖 |
| 图会话状态 | 进程内存（`MemorySaver`） | — | **进程重启丢失** |

> **`MemorySaver` 是当前最脆弱的一环**。它让 `host_phase` 在轮次间保持，但进程一重启就没了。好在代码会在会话首轮从 `DIALOGUE-LOG.md` 播种状态，所以**刷新页面能恢复进度**（这是相对 n8n 版本的改进——n8n 版本刷新即失忆）。但多实例部署下这条路走不通，必须换成持久化 checkpointer。

### 已知的数据漂移（迁移时需处理）

| 问题 | 位置 |
| --- | --- |
| 同义字段三种写法：`knowledge_point_id` / `knowledge_point_ids` / `kp_id` | 存量标记点文件 |
| v1 扁平键残留（`"KP-001": "初步理解"`）与嵌套结构自相矛盾 | `mastery-state.json` |
| 历史条目字段不统一（`time` vs `occurred_at`，缺 `history_id` 等） | `mastery-history.json` |
| `speaker` 出现未定义的 `assistant` 值 | `dialogue-log.json` 存量 43 条 |

---

## 6. SaaS 集成：必须补齐的生产边界

| 主题 | 代码现状 / 风险 | 服务方动作 |
| --- | --- | --- |
| **身份与租户** | `student_id` 硬编码 `student-001`；无登录、无鉴权 | 接入平台 SSO 取得 `studentId`/`tenantId`；每次读写校验归属；禁止信任客户端传入的身份 |
| **与教师平台的数据接口** | **完全未接入**。课程片段、知识点、材料都读本地文件 | 接入 `/api/student-agent/v1`（见平台文档 2）：`get_course_context` / `get_lesson_context` / `get_artifact` / `get_classroom`。只读已发布数据 |
| **并发** | 标记点编号靠"扫描目录取最大值 +1"，**无锁**；多实例必然撞号 | 编号改由数据库序列或 UUID 提供；写入走事务 |
| **会话持久化** | `MemorySaver` 在内存 | 换持久化 checkpointer（SQLite/Postgres），或用平台身份绑定 `thread_id` |
| **存储引擎** | 纯文件，无数据库 | 落 PostgreSQL。注意文档 2 的 `mentra_*` 表结构可作参考，但学生档案属于**学习数据**，与课程数据分层不同 |
| **角色隔离** | 主持人指令与学生发言共用同一输入框 | 拆分为教师端/学生端两个入口；主持人事件改由平台事件驱动，而非手打命令 |
| **课后复习通道** | **不存在**。课堂结束即终止，无间隔复习、无遗忘曲线调度 | 这是产品愿景（文档 1）的核心能力之一，当前完全空白 |
| **可观测性** | 只有 `console.error` | 为每轮对话分配 request ID，记录阶段、耗时、模型用量、失败原因 |
| **掌握度模型** | 0-5 星离散值 | 产品愿景建议升级为认知模型（掌握概率、置信度、遗忘速率、误区库）。**两套模型不兼容，需先决策再动手** |

---

## 7. 上线顺序与验收

① 配置 `DEEPSEEK_API_KEY`，`npm install`，启动服务；确认 `GET /api/health` 返回 `connected: true`。

② 走通主持人事件流：`/上课开始` → `/开始播放 <seg>` → `/段落结束 <seg>` → `/下课`。**每一步都要确认 `DIALOGUE-LOG.md` 的 `host_phase` 真的变了**（当前 `/段落结束` 这一步会失败，属已知缺口）。

③ 验证打断抑制：讲课中输入一个提问，回复必须**只有**"已记下"，且 `class-point/points/` 下新增文件、**已有文件未被改动**。

④ 验证掌握度往返：**当前只有学生端打标注这一条路径真正生效**（`POST /api/workspace/annotations`，升到 1 星并追加历史）。AI 答疑路径尚未接上——见第 9 节的 `mastery_updates` 说明。课后答疑的 2 星封顶**本条现在无法验收**（未实现）。

⑤ 验证刷新恢复：中途刷新页面（新 `sessionId`），确认进度从 `DIALOGUE-LOG.md` 正确恢复。

⑥ 检查多学生隔离前，**不要**开启多实例——会在标记点编号上冲突。

⑦ 通过以上验收后，再进入 SaaS 化：落库 → 接平台接口 → 接身份 → 换持久化会话。

---

## 8. 关键接口与代码定位

| 用途 | 入口 |
| --- | --- |
| HTTP 服务与路由 | `classroom-chat/server.mjs` |
| 图的组装与对外入口 `runTurn` | `classroom-chat/graph/index.mjs` |
| 状态 schema（`host_phase` 等） | `classroom-chat/graph/state.mjs` |
| 消息分类（命令判定、别名表） | `classroom-chat/graph/nodes/classify.mjs` |
| 读文件进状态 | `classroom-chat/graph/nodes/loadContext.mjs` |
| 调模型 | `classroom-chat/graph/nodes/invokeAgent.mjs` |
| 写回文件（编号分配、字段归一） | `classroom-chat/graph/nodes/persist.mjs` |
| `DIALOGUE-LOG.md` 解析与渲染 | `classroom-chat/graph/render.mjs` |
| 0-5 星规则（唯一权威实现） | `classroom-chat/mastery-rules.mjs` |
| 路径常量与文件读写 | `classroom-chat/store.mjs` |
| 系统提示词 | `classroom-chat/graph/prompts/legacy-agent.txt` |
| 学生 workspace 前端 | `student-workspace/public/` |
| 课堂对话前端 | `classroom-chat/public/` |

**HTTP 接口**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/chat` | 本轮对话。返回 `{ ok, message: { text, speech } }` |
| `GET` | `/api/workspace` | 学习空间 bootstrap（课程、知识点、标注、掌握档案） |
| `POST` | `/api/workspace/annotations` | 学生打标注，写标记点并升 1 星 |
| `POST` | `/api/tts` | 语音合成，单段 ≤ 600 字符 |
| `GET` | `/api/health` | 健康检查，`connected` 反映模型密钥是否配置 |

---

## 9. 迁移状态（写给接手的人）

本仓库正在从 n8n 迁移到 LangGraph，**阶段 0 已完成**：

- n8n 已从运行时路径移除，图的骨架、四个基础节点、前端契约已对齐并验证
- 模型调用、文件读写、前端交互均已实测通过

**尚未完成**（会改变现有行为）：

| 阶段 | 内容 | 影响 |
| --- | --- | --- |
| 1 | `host_phase` 转移改为代码决定 | 修复 `/段落结束` 不推进状态的缺口；删除提示词中的防御性约束 |
| 2 | 文件写入改为工具调用 | 打通 `mastery_updates` 通道（见下方说明） |
| 3 | 按阶段拆分提示词 + 实现 `post_class` 课后答疑 | 提示词瘦身；课后答疑可用 |
| 4 | 文档与前端文案清理 | |

完整方案见仓库规划文档。接手时请以本节的"尚未完成"为准——**不要把阶段 0 的现状当作终态**。

### 设计要求 vs 代码现状（务必先看这张表）

产品规则里写了、但**代码尚未实现**的能力：

| 设计要求 | 出处 | 代码现状 |
| --- | --- | --- |
| AI 答疑产生的掌握证据可升 2–4 星 | `MASTERY-STAR-RULES.md` | ❌ **无写入通道**。提示词要求模型返回 `mastery_updates`，但没有任何代码处理该字段。模型会在输出里**声称**"已更新掌握状态"，实际一个字节都没写。当前唯一真正写掌握度的路径是学生端手动打标注（只能到 1 星） |
| 5 星只能由正式考核产生 | `MASTERY-STAR-RULES.md` | ⚠️ 无考核流程，该星级当前不可达 |
| `/段落结束` 推进到 `segment_summary` | 部署版提示词 `:39` | ❌ 提示词只描述行为、没有状态赋值，靠模型自行推断。**实测进度会卡在 `lecturing`** |
| 课后答疑（`post_class`） | 迁移决策 D4 | ❌ 状态值已定义、封顶函数已写好，但**无节点、函数未被调用** |
| 每轮问答写入 `dialogue-log.json` | 部署版提示词 `:121` | ❌ 提示词要求，无代码处理。该文件当前是孤儿（29 KB 存量、全代码库无读写者） |
| 未回应阶梯（`inactivity_step`） | `PROJECT-SPEC.md` 6.8 | ❌ 已**决策删除**（迁移决策 D5）——定时器不存在，字段永远无法递增 |
| 命令打错时的容错 | 实测 | ⚠️ 目前靠模型理解兜底。阶段 1 把状态机代码化后，`/上课开始` 这类判定将完全依赖正则，**打错字状态机不会动** |

> 上面这几条不是实现疏漏，而是**产品规则先行、编排层没跟上**的累积结果。这也正是迁移到 LangGraph 要解决的核心问题：把"靠提示词约束模型"换成"由代码保证"。

---

*本文档与《教师端智能体 SaaS 部署与集成指南》《AI 教育平台数据存储与学生智能体接口说明》《课堂互动智能体数据说明》配套使用。三者分别描述教师端平台、平台数据接口、学生端智能体，请勿混同。*

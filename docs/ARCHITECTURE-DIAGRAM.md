# 课堂互动智能体 - 架构图

生成时间: 2026-09-15

```text
图 1  分层总览 - 谁连谁

┌──────────────────────────────────────────────────────────────────────────────────┐
│ [1] 用户层 - 浏览器   (前端只连本地服务器, 不直连 n8n)                           │
│ ─────────────────────────────────────────────────────────────────────────────────│
│   ┌──────────────────────────────────┐  ┌──────────────────────────────────┐     │
│   │ 老师端 - 课堂对话窗口            │  │ 学生端 - 学习空间                │     │
│   │ classroom-chat/public/           │  │ student-workspace/public/        │     │
│   │                                  │  │                                  │     │
│   │ - 聊天输入 + 逐条朗读            │  │ - 课程中心 (视频占位)            │     │
│   │ - 音色 / 朗读模式设置            │  │ - 课内嵌课堂对话 iframe          │     │
│   │ - 老师指令:                      │  │ - 掌握情况 (0-5 星)              │     │
│   │     /上课开始                    │  │ - 查缺补漏                       │     │
│   │     /开始播放 <seg-id>           │  │ - 标注记录                       │     │
│   │     /段落结束 <seg-id>           │  │ - 打标注表单                     │     │
│   │     /下课                        │  │                                  │     │
│   └──────────────────────────────────┘  └──────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────────┘
                   │                                     │                        
                   │  POST /api/chat                     │  GET  /api/workspace
                   │  POST /api/tts                      │  POST /api/workspace/annotations
                   │  GET  /api/health                   │  GET  /api/health
                   ▼                                     ▼                        
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [2] 本地服务层 - Node 服务器   classroom-chat/server.mjs   :4173                 │
│     零依赖, 只用 Node 内置模块. 兼任 静态文件服务器 + API 网关                   │
│ ─────────────────────────────────────────────────────────────────────────────────│
│ POST  /api/chat                           转发 n8n Webhook, 规范化返回值         │
│ POST  /api/tts                            调 Qwen 语音, 内存缓存 64 条           │
│ GET   /api/workspace                      读文件组装 bootstrap 给学习空间        │
│ POST  /api/workspace/annotations          写 point json + 升 1 星                │
│ GET   /api/health                         探测 n8n /healthz + TTS 配置           │
│ GET   /* (静态)                             / -> classroom-chat/public           │
│                                           /student/ -> student-workspace/public  │
│ ─────────────────────────────────────────────────────────────────────────────────│
│ 关键作用: 1) 绕开浏览器跨域   2) 藏 n8n 地址与密钥                               │
│           3) 直连文件系统, 补上 n8n 读不到的学生档案                             │
└──────────────────────────────────────────────────────────────────────────────────┘
                                        │                                         
                                        │  HTTP POST  action=sendMessage
                                        ▼                                         
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [3] 工作流层 - n8n (Docker 容器)   :5678                                         │
│     工作流名 teach    Chat 页面 /webhook/24c2ba65-.../chat                       │
│ ─────────────────────────────────────────────────────────────────────────────────│
│ 每轮固定动作:                                                                    │
│   收消息 -> 读 class agent 规则 -> 读 teach test 状态                            │
│          -> 读 class-point 数据 -> 合成上下文                                    │
│          -> Teach Session Agent (DeepSeek + 20 轮记忆)                           │
│          -> 解析 JSON -> 写回 7 个状态 md + point 文件                           │
│          -> 返回给学生的回复                                                     │
│                                                                                  │
│ Docker 挂载: 宿主机 D:\project\Dify 课堂互动智能体                               │
│              -> 容器 /data/class-teach      [!] 该主机路径现已不存在             │
└──────────────────────────────────────────────────────────────────────────────────┘
                                        │  HTTPS
                                        ▼                                         
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [4] 外部服务层                                                                   │
│ ─────────────────────────────────────────────────────────────────────────────────│
│   ┌──────────────────────────────────┐  ┌──────────────────────────────────┐     │
│   │ DeepSeek API (外网)              │  │ 语音服务 (外网, 可选)            │     │
│   │ model: deepseek-chat             │  │ 阿里云百炼 Qwen TTS              │     │
│   │ responseFormat: json_object      │  │ model: qwen3-tts-flash           │     │
│   │ temperature: 0.4                 │  │ 13 种音色, 默认 Cherry           │     │
│   │ 凭据: n8n "DeepSeek account"     │  │ 没配 key -> 退化浏览器语音       │     │
│   │                                  │  │                                  │     │
│   └──────────────────────────────────┘  └──────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────────────┘
                                        │                                         
                                        ▼  读写本地文件
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [5] 数据层 - 本地文件系统   (当前没有数据库, 全靠文件)                           │
│ ─────────────────────────────────────────────────────────────────────────────────│
│   目录                            内容                                    权限   │
│   class agent/                    老师规则 + KNOWLEDGE-BASE               只读   │
│   class-point/segments/           课程片段 seg-xxx                        只读   │
│   class-point/points/             学生标记 point-xxx                      读写   │
│   teach test/                     7 个课堂状态 md                         读写   │
│   student-workspace/data/         mastery / dialogue json                 读写   │
└──────────────────────────────────────────────────────────────────────────────────┘

图 2  n8n 工作流内部节点流 (一轮对话的完整链路)

  节点                          作用
  ────────────────────────────── ──────────────────────────────────────────────
  Chat Trigger                  hostedChat, 允许上传文件, responseMode=lastNode
                                ↓
  Normalize Input               取 studentMessage / studentId=student-001 / fileCount
                                ↓
  Check Uploaded File           IF: 本轮有没有上传文件?
                                ↓
  Extract Uploaded Text         [有文件分支] 提取正文 -> Attach Upload Context
                                ↓
  Read Rule Files               读 class agent/**/*.md
                                ↓
  Read State Files              读 teach test/*.md
                                ↓
  Read Class Point Files        读 class-point/**/*.json
                                ↓
  Combine Sources               Merge: 5 路输入合并
                                ↓
  Combine Context               拼成给模型的大上下文
                                ↓
  Teach Session Agent           DeepSeek + Simple Memory(20轮) -> 输出一个 JSON
                                ↓
  Parse Agent JSON              容错解析, 失败走回退分支
                                ↓
  Prepare State Writes          决定写哪几个文件 (空字符串=不写)
                                ↓
  State Markdown to Binary      文本转 n8n 二进制, 才能落盘
                                ↓
  Write State Files             写 7 个状态 md + class-point/points/*.json
                                ↓
  Format Chat Reply             组装 {output:{text,speechKind}} 返回

  模型每轮必须返回的 JSON 字段 (其余字段为空字符串 = 不写该文件):
    reply                  -> 唯一给学生看的内容
    dialogue_log_md        -> DIALOGUE-LOG.md     (必须非空)
    class_point_files      -> class-point/points/*.json
    tmission_md            -> TMISSION.md
    smission_md            -> SMISSION.md
    notes_md               -> NOTES.md
    lesson_interaction_md  -> LESSON-INTERACTION.md
    glossary_md            -> GLOSSARY.md
    learning_record_md     -> LEARNING-RECORD.md

图 3  数据读写权限矩阵 - 谁产生 / 谁读 / 谁写

  数据                                        谁产生        谁读          谁写          
  ──────────────────────────────────────────────────────────────────────────────────────
  class agent/**/*.md                         老师          n8n + server  禁止          
  class-point/segments/*.json                 老师/平台     n8n + server  禁止          
  class-point/points/*.json                   学生打标注    n8n + server  n8n + server  
  teach test/*.md (7 个)                      老师初始化    n8n           n8n           
  student-workspace/data/mastery-state.json   server.mjs    server.mjs    server.mjs    
  student-workspace/data/mastery-history.json server.mjs    server.mjs    server.mjs    
  student-workspace/data/dialogue-log.json    (历史遗留)    (无人)        (无人)        

  两条写入路径 (互不相通):
    A. AI 答疑路径   n8n -> 7 个状态 md + class-point/points
    B. 学生标注路径   server.mjs -> class-point/points + mastery json

图 4  缺口与未接线部分  [X] = 规则里要求了, 但代码里不存在

  [X] n8n 不读 student-workspace/data/**
      AI 根本看不到 mastery 星级 / 历史 / 逐字对话
  [X] AI 不能写 mastery-state.json
      规则说答疑证据可升 2-4 星, 但工作流没有这个写入通道
  [X] dialogue-log.json 是孤儿文件
      29 KB 存量数据, 全代码库无写入者也无读取者
  [X] Docker 挂载指向 D:\project\...
      该主机路径已不存在, n8n 读写的是另一个位置
  [X] 仓库源码 != 运行中的 n8n
      Combine Context 节点体内是 Prepare State Writes 的代码
  [X] /research / 定时器 / 多学生
      占位逻辑; 无主动唤醒; student-001 写死

```

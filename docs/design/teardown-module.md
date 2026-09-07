# oh-story WebUI 拆文工作台与剧情模块库（v0.1）

> 配套 [`standalone-webui.md`](standalone-webui.md)（主案）与 [`webui-frontend.md`](webui-frontend.md)（前端 P4 拆文）。
> 本文把「**拆文**」从"分析查看"深化为**可复用的创作资产闭环**：拆到库里，重组到新书。这是 oh-story 核心主张「爆款逆向 · 剧情模块化重组」的 WebUI 落地。

---

## 1. 定位与原则
- **拆文 = 读别人的书，沉淀自己的模块库**。产物全部落在 `拆文库/{书名}/`，与新书隔离，但可被「模块库」索引复用。
- **原则**：只读分析（对原文不改写），AI 拆解报告（写作手法/拆文报告）可编辑；任何"拆出物"入模块库前需人工确认。
- 对齐现有 CLI：`story-long-analyze`（黄金三章/爽点/节奏/情绪模块）、`story-short-analyze`（故事核/反转/情感线/共鸣）、`chapter-extractor`（章节摘要）。

---

## 2. 拆文库数据模型（文件系统真相）

```
拆文库/{书名}/
├── _meta.json                 # 来源/导入时间/章节数/拆解轮次/模型
├── 原文/原文.txt               # 原始文本（仅供参考，不入模块库）
├── 章节/                      # chapter-extractor 输出（并行）
│   ├── 第001章_摘要.md
│   └── 第001章_情节点.md
├── 角色/*.md                  # 拆出的角色卡（实例态，标注"出自本书"）
├── 设定/                      # 世界观/势力/力量体系（实例态）
├── 剧情/                      # 模块化剧情资产 ★可进模块库
│   ├── 故事线.md
│   ├── 情节点.md
│   ├── 节奏.md                # 每章快慢条带数据（JSON/表格）
│   ├── 情绪模块.md            # 情绪曲线数据（JSON/表格）
│   └── 散落情节.md
├── 写作手法.md                # 技巧观察（宏观）
└── 拆文报告.md                # 总体结论：题材/受众/爽点清单/钩子清单
```
- `_meta.json`：
```json
{ "source_title": "盘龙", "source_platform": "起点", "imported_at": "…",
  "chapter_count": 23, "extracted_by": ["chapter-extractor: ck-…"],
  "analyzed_by": ["story-architect: md-…"], "module_library_ids": ["wQ3"] }
```

---

## 3. 拆文流程（不占用创作 pipeline，独立工作流）

```
[导入原文]
   → 分章: 按"第X章/第X节/章回"启发式切分（武误区/番外标记）
   → chapter-extractor(并行, 只读, 廉价模型): 每章 → 摘要 + 情节点 json
[编排分析]（串行/受控并行 ≤2）
   → 角色抽取 (character-designer)           → 输出 角色/*.md
   → 设定抽取 (story-architect)              → 输出 设定/*
   → 剧情模块/节奏/情绪曲线 (story-architect)  → 输出 剧情/*
   → 写法与总结 (story-architect)            → 输出 写作手法/拆文报告
[人工精修]
   → 界面逐模块审（勾选"入模块库"）
[沉淀]
   → 勾选项打包为模块库条目 → 索引入库
```

### 3.1 章节切分与章节摘要规格
| 字段 | 说明 |
|---|---|
| `chapter_idx` | 全书序号（正文分卷可含 `V1-` 前缀） |
| `summary` | 2-3 句情节摘要 |
| `plot_points[]` | `{ type: 'hook'|'crisis'|'resolution'|'reveal', desc, strength: 0-5 }` |
| `rhythm` | `'slow'|'steady'|'fast'|'climax'`（供节奏条带） |
| `emotion` | `-3..3`（供情绪曲线） |
| `notes[]` | 散落情节/伏笔观察（入"散落情节.md"） |

---

## 4. 剧情模块库（复用闭环）★

### 4.1 模块库数据（`webui.db` + 文件）
```sql
CREATE TABLE IF NOT EXISTS modules (
  id           TEXT PRIMARY KEY,          -- md_<ulid>
  kind         TEXT NOT NULL,             -- plot|emotion|rhythm|hook|character-trait|worldbuilding
  title        TEXT NOT NULL,
  source       TEXT NOT NULL,             -- 拆文库:{书名}/路径 或 user
  tags         TEXT NOT NULL DEFAULT '[]',
  usable_for   TEXT NOT NULL DEFAULT '[]',-- 题材类型标签（新书选题时匹配）
  body         TEXT NOT NULL,             -- 模块正文（可复制的"重组素材"）
  excerpt      TEXT,                      -- 1 行摘要（列表展示）
  usage_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
```
- **入库确认**：拆文界面「✓ 入模块库」勾选 → 写 `modules` + 回写 `_meta.module_library_ids`。
- **来源追溯**：`source` 指向拆文库路径，保证"借鉴可溯源、不直接照搬"。

### 4.2 新书如何复用（重组，不是照搬）
- 新建小说向导/`outline` 阶段：「从模块库导入」面板：
  - 按 `kind+topic(题材) 匹配` 列出候选（如"都市系统流 + hook/emotion"）；
  - 选择后**注入 `context-outline`/`context-chapter` 的知识块**（作为"参考手法"，不出现在产物正文）；
  - 复用计数 +1；产物可标注 `参考模块: md_xx`（供审查用）。
- **红线**：模块只供"结构/手法"参考，正文仍走门禁（ai-patterns/degeneration/outline-copy 照搬检测不会因模块引入而放松——拆文库原文不在门禁输入内，杜绝"抄原文"）。

---

## 5. 可视化（前端 §3.5 / P4 深化）
- **节奏条带**：全书按章横向条带，高度=快慢，色阶=情绪（暖=爽点/冲突，冷=铺垫）——一眼看"在哪该切、哪章注水"。
- **情绪曲线**：折线图（x=章，y=-3..3），叠加**爽点事件**标记（🚩）。
- **钩子链**：`plot_points(hook) → 下一章(承接)` 连线小图，标出"钩子断线"（上一章钩子下章未接 → 黄签警告）。
- **切章建议**：由"节奏"栏生成"建议切章点"（当前章太长/太弱）。

---

## 6. 与创作管线的关系
- 拆文**不进入**创作 stage 状态机（独立工作流），因此"每步确认"不套用到拆解过程；但**入模块库**与**移除模块**写 audit。
- `story-short-analyze` 拆短篇同理：产物为单文件（正文.md + 拆文报告），抽取"故事核/反转设计"入库（kind=plot）。
- 模块库是本工具「人无我有」的记忆资产：跨书、跨会话可用（SQLite 持久），是"拆解越多、写越好"的复利点。

---

*拆文与模块库 v0.1 —— M2 实现拆文库建模与可视化，M3 打通「模块库→新书大纲」注入；模块库 JSON/表结构保持 CLI 技能可读（`拆文库/{书}` 仍是文件真相）。*

# 拆文 → 模块库 → 新书：前端 UI 流程详设（v0.1）

> 配套 [`teardown-module.md`](teardown-module.md)（数据/闭环）、[`webui-frontend.md`](webui-frontend.md)（P4 拆文）、[`process-definition.md`](process-definition.md)（context 注入点）。
> 本文专讲**界面**：三屏 + 一条链路 + 组件 + 交互状态机 + 新增 API。目标：作者在 UI 上把"别人的爆款"变成"自己的弹药库"，再在新书里**只抄结构、不抄文字**。

---

## 0. 用户旅程（一条链，四个角色路径）

```
P① 拆书人: 拆文工作台 → 勾选单元 → 入库抽屉(tags/usable_for) → 模块库可见
P② 开新书: 新建小说向导 →「从模块库取结构」(seed) → 书创建时绑定
P③ 写大纲: 大纲工作台 → 模块库检索 → 注入预览 → attach → 产物标注参考
P④ 维护者: 模块库页 → 详情/改 tags/看使用历史/软删
```
- 全文一个隐喻延续「书稿编辑部」：模块 = **"活页卡片匣"**；入库 = 归档进匣；attach = 抽一张卡摆在书桌上（仍能按卡溯源）。

---

## 1. 入口矩阵

| 入口 | 位置 | 动作 |
|---|---|---|
| 拆文工作台 | `/projects/:p/teardowns/:id` | 每个可入库单元的 `☆ 入库` |
| 模块库（项目级） | **`/projects/:p/modules`**（新标签） | 检索/管理/attache 历史 |
| 新建小说向导 | Step.2 之后的可选区 | 「从模块库取结构」 |
| 新书大纲工作台 | 右侧工具廊「模块库」页签 | 检索→注入 |
| 书房/全局（M4） | `/modules`（跨项目聚合） | 全库检索 |

> 同步更新：项目内二级标签 = `小说书架 · 拆文库 · 模块库 · 流程看板`。

---

## 2. Screen A：拆文工作台（入库交互）

```
┌ 拆文:盘龙 ───────────── 顶栏：导入 | 拆解中… | [入库 N 项]（带角标） ──┐
│ Tabs: 原文 | 章节 ▍角色 ▍设定 ▍剧情模块 ▍节奏 ▍情绪曲线 ▍爽点钩子 ▍写法   │
│────────────────────────────────────────────────────────────── │
│ 剧情模块（数据源: 剧情/）                           筛选: kind ▾ 全部   │
│ ┌ ModuleCard: 越级打脸三连（1-3章） ─────────┐  ┌ ModuleCard: 系统奖励结算 ┐
│ │ kind:plot · 来源:盘龙/剧情/情节点.md        │  │ kind:plot │ 复用 0 次     │
│ │ 摘录:「弱者挑衅→强者碾压→围观反转→爽点结算」│  │ 摘录:…                     │
│ │ [☆ 入库]  [打开出处]                       │  │ [☆ 入库]  [打开出处]        │
│ └───────────────────────────────────────────┘  └───────────────────────────┘
│ 节奏: 全书条带 ▓▓▓░░▓▓▄▄▄▓  → 长条上有「节选为模块」手柄（圈选区间入情绪/节奏模块）
```
- **可入库单元**：`kind ∈ {plot, emotion, rhythm, hook, character-trait, worldbuilding}`；普通卡片（角色/设定）只在"抽取报告"里给「并入模块库」整体选项。
- **节选入库**（节奏/情绪曲线）：在图表上框选区间 → 生成节奏/情绪模块（标题自动 = 区间章号范围）。
- **入库状态**：已入库卡片变青黛方章「已入库」；再点 → 重新入库（覆盖/更新条目，保留 attach 历史）。

### Screen A.1 入库存档抽屉（批量）
```
┌─ 入库 N 项 ──────────────────────────────┐
│ 已选: [剧情模块·越级打脸] [情绪·憋屈到释放] … ✗拆   │
│ 默认标签(可改/可加): 都市系统流、打脸、爽文       │
│ usable_for(题材): 都市系统流 ▍修仙 ▍……（多选）   │
│ 一句话摘要(每项可改)                          │
│   · 越级打脸: 弱者挑衅→碾压→围观反转→结算        │
│ 来源书: 《盘龙》(拆文) ✅ 已在库？无           │
│ [存进模块库]（盖章动效） → [去模块库看看]  [继续拆] │
└──────────────────────────────────────────┘
```
- 校验：至少 1 项；摘要默认取卡片摘录，允许改；`usable_for` 预填拆文库 `_meta` 的平台/题材。
- 后端 `POST /books/:id/modules/archive`，进度走 SSE（多条目时逐条落库）。

---

## 3. Screen B：模块库页（`/projects/:p/modules`）

```
│ 模块库 · 共 64 条 · 本月被用 12 次 · 来自 7 本拆文          [+ 手动录入]  │
│ 搜索 关键词…  ▍筛选: kind▾ tags▾ usable_for▾ 来源书▾   排序: 复用最多▾   │
│ ┌ ModuleCard ───────────────┐ ┌ ModuleCard ──────────────┐            │
│ │ 越级打脸三连      plot     │ │ 系统奖励结算      plot    │            │
│ │ 来源:盘龙  tags:爽文/打脸   │ │ 来源:盘龙   tags:系统流   │            │
│ │ 复用 3 次 · 今日注入 1 本书  │ │ 复用 osocial…             │            │
│ │ [打开] [复制引用]                    │ │ [打开] [复制引用]           │            │
│ └──────────────────────────┘ └──────────────────────────┘            │
```
- **卡片信息**：标题 / kind 徽章 / 来源(拆文库:书 或 手工) / tags / **复用计数**（注入了几本书·几处）/ 更新时间。
- **详情抽屉**：正文预览 → 来源路径（可跳拆文该书对应章节/模块）→ tags 编辑、usable_for 编辑 → **使用历史**（`used_in: [{书,阶段,时间}]`）→ [软删除]（二次确认 + audit）。
- **空态**：「模块匣是空的。去拆一本爆款，把好结构存进来。」+ [去拆文] [手动录入]。
- **手工录入**（可选项）：空白模块（source=user），给作者自己沉淀"自创套路"。

---

## 4. Screen C：新建小说向导「从模块库取结构」（可选步骤）

```
Step 2 后半（选题已定）:
┌─ 从模块库取结构（可选 0-N 项）────────────────────────┐
│ 推荐（按 题材:都市系统流 × kind:plot/hook）：           │
│  ☑ [越级打脸三连·plot]  ☐ [系统奖励结算·plot]          │
│  ☑ [开局三章钩子模板·hook]                             │
│  ── 全部（可筛选）──                                     │
│  ☐ [憋屈→释放·emotion]  …                             │
│ 说明: 勾选项将作为"种子模块"写入本书；之后在大纲/章节阶段可再增/减。│
│                [不取，直接开始]      [下一步：确认骨架]      │
└────────────────────────────────────────────────────┘
```
- 勾选 → 写入 `book.meta.seed_modules[]`；向导确认页展示注入数量。
- 推荐端 `POST /books/:id/modules/recommend {genre, kinds}` 返回 `{score, reason}`（score 高亮为"推荐"）。

---

## 5. Screen D：新书大纲阶段「模块库注入」

```
大纲工作台 右侧工具廊 → [模块库] 页签
├─ 搜索/筛选（kind/tags/usable_for）
├─ 卡片列表（点击=详情）
├─ ☑ 多选 → [注入到本次大纲]
└─ 注入预览抽屉:
   ┌────────────────────────────────────────┐
   │ 将注入 3 个模块 → 组装器 context-outline  │
   │   · 越级打脸三连  → knowledge 块(plot)   │
   │   · 开局三章钩子    → knowledge 块(hook)  │
   │   · 憋屈→释放       → 情绪参考(emotion)    │
   │ 预估额外 token: 1480（在预算内）           │
   │ 红线提示(仅首次): 只抄结构/手法，不抄原文； │
   │   门禁(ai-patterns/outline-copy)不放松。 │
   │            [取消]   [确认注入]            │
   └────────────────────────────────────────┘
确认 → POST /novels/:id/modules/attach → context 组装读取 → 产物标注
```
- **产物标注**：细纲/章节头注释 `<!-- 参考模块: md_xx（来源拆文:盘龙） -->`；审查界面可点开核对"是否只用了结构"。
- **复用计数**：attach 成功 → `modules.usage_count+1` + 写入 `used_in`。
- 大纲工具廊可随时增/减模块；减掉不删库条。

---

## 6. 交互与状态机（前端）

```
[拆文页] ☆入库 → 勾选态 → 入库抽屉 → archive 成功(SSE 逐条) → toast(盖章) → 空勾选
[模块库] 检索/筛选 → 列表(Query cache) → 详情/编辑/软删(audit)
[向导]  推荐 → 勾选 seed → 写 book.meta.seed_modules
[大纲]  search → 多选 → attach → 注入预览确认 → context 生效 → RefBadge 标注 → usage+1
```
- Load/Empty/Error 三态统一（书架材质）；SSE `module:archived / module:attached` 事件增量更新计数。
- 乐观更新：attach/入库后本地先 +1 计数，失败回滚。

---

## 7. 组件增补清单

| 组件 | 说明 |
|---|---|
| `ModuleCard` | 标题/kind 徽章/来源/tags/复用计数/入库态 |
| `ArchiveDrawer` | 批量入库：tags/usable_for/摘要编辑 |
| `ModulePicker` | 搜索+筛选+多选（向导/大纲工具廊复用） |
| `InjectPreview` | 注入影响预估（命中组装器/知识块/token/来源） |
| `ModuleDetailDrawer` | 正文+来源跳转+tags 编辑+使用历史+软删 |
| `SeedModuleSection` | 向导推荐区（含 score 徽章） |
| `RefBadge` | 产物"参考模块"标注（可点开核对） |
| `RangeToModule` | 节奏/情绪图上的框选→建模块手柄 |

---

## 8. 新增 API（对齐 api-contract）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/modules?kind&tag&usable_for&source&sort` | 列表（项目级/全局） |
| GET | `/modules/:id` | 详情（含 used_in） |
| PUT | `/modules/:id` | 改 tags/usable_for/摘要/正文（手工） |
| DELETE | `/modules/:id` | 软删（移"回收" + audit） |
| POST | `/books/:id/modules/archive` | 拆文批量入库（单元列表）→ SSE |
| POST | `/books/:id/modules/recommend` | 按 {genre,kinds} 返回 {id,score,reason}[] |
| POST | `/novels/:id/modules/attach` | 注入 {module_ids[], scope} → 返回影响预估+生效 |

> 前端只消费上述端点；数据落在 `data-model` 的 `modules` 表（缺字段增补：`used_in_json`、`summary`、`deleted_at`）。

---

## 9. 反塑挂点（与既有文档闭环）
- `teardown-module.md §4 模块库数据` ← ArchiveDrawer / ModulePicker 读写
- `webui-frontend.md §3.2 大纲` ← 工具廊挂 ModulePicker + RefBadge
- `webui-frontend.md P2 向导` ← SeedModuleSection
- `process-definition.md context-outline/chapter` ← attach_modules 为注入源（`seed_modules` 出生、`attach` 生效）
- `data-model.md` ← `modules` 表增 `summary / used_in_json / deleted_at`

---

*拆文→模块库→新书 UI 流程 v0.1 —— M2 随拆文工作台落地（Screen A/B），M2.5-M3 随向导/大纲落地（Screen C/D）。*

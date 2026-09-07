# oh-story WebUI 规模与性能（v0.1）

> 目标规模：**单用户 · 长书多卷 · 上千章 · 数百万字** 依旧流畅、门禁与 AI 调用不"卡死界面"。
> 定位：性能不是"优化后置"，而是在 M0-M2 就按这些约束选型和实现。

---

## 1. 规模基线
| 维度 | 设计值 | 说明 |
|---|---|---|
| 单书章节 | 至千章 | 正文 1000+ 文件，细纲 1:1 |
| 单章正文 | 2k-4k 字 | 文本 ~15KB，编辑器单文件量级小 |
| 追踪状态 | <200KB JSON | 角色/伏笔/时间线条目随章线性增长，需归档 |
| gate_runs/jobs | 每章 ~7 gate 行 | 千章 ~7k 行/书，可接受，但需定期归档 |
| 拆文 | 单书 300+ 章节摘要 | 结构树懒加载 |
| 模块库 | 千条级 | 检索走索引，不用扫全文 |

---

## 2. 前端性能
- **CodeMirror 6 单文件编辑**：永远只编辑"一章/一卡/一个片段"，**不做全书大文件编辑器**；整书视图用只读列表/虚拟化表格（`@tanstack/react-virtual`）。
- **结构树懒加载**：左树只在展开节点时请求该层（`GET tree?path=`）；`demo` 千章目录首屏 <80ms。
- **diff/检查**：大规模 diff（整章）也按行虚拟化渲染（`diff` 行数多时折叠不变行）。
- **状态看板**：伏笔/时间线分页 + 按状态过滤；角色网格分页。
- **草稿与保存**：正文 debounce 1.5s 存 localStorage；「保存并门禁」才触达后端；保存冲突走 409 提示，不整文件覆盖。
- **首屏分包**：Vite 代码分割；`PageEditor`/`StateBoard`/`AIEditDrawer` 异步 import。

---

## 3. 后端性能与缓存
### 3.1 上下文组装缓存（关键：避免每次重复读盘）
```
server/agents/contexts/cache.ts（内存 LRU + 文件指纹失效）
├─ recentChapters(bookId)      缓存《最近 N 章摘要》→ 新 commit 后失效
├─ outlineDigest(bookId, 章)    细纲解析结果 → 文件 mtime 失效
├─ trackingDigest(bookId)        _tracking-state.json 摘要（裁剪好的块）→ state_revision 失效
└─ knowledgeRefs(模块)           references/** 常驻内存（启动读一次，包更新才重载）
```
- 命中率目标：`chapter` 任务组装 <200ms（不含模型调用）。

### 3.2 读写路径
- 文件读：`server/fs` 统一 `Buffer→utf8`，配合 OS 页缓存（单机可依赖）；写入用**临时文件+rename**原子写（沿用归一化原子写思路）。
- DB：WAL + 只读查询走 prepared；`gate_runs/jobs` 按 `book_id+created_at` 范围查询有索引；**大表按季度归档**到 `webui.db__archive_YYYYMM`（`VACUUM INTO` 后删除）。

### 3.3 门禁耗时预算（大书典型）
| gate | 目标 | 说明 |
|---|---|---|
| char-count | <10ms | 纯文本 |
| ai-patterns | <300ms/章 | 正则扫描，缓存编译 |
| degeneration | <200ms | 行级扫描 |
| normalize-punctuation | <300ms | 原子写为主 |
| outline-detail / outline-copy | <400ms | 单章细纲 |
| chapter-consistency / project-consistency | <1s | 跨文件但只读相关集 |
| tracking-commit | <100ms | SQLite-JSON 事务 |
- 全批目标：`chapter` 阶段 gates <3s（并行化后）；超时兜底见 gates-runner §1.1。

---

## 4. 任务与 AI 调用
- **队列**：默认并发 1（写任务）/2（读任务）；AI 调用节流（同一渠道 N 并发，默认 1，防限流与成本）。
- **流式**：SSE 心跳 25s；断线重连全量刷新（`jobs` + `stages` 幂等）。
- **大输入防护**：`context_max_tokens_in` 硬上限；超限按 process §5 裁剪顺序丢块（knowledge→tracking→history）。
- **后台助手**（consistency 快检/extractor）只在空闲时排队，不抢写任务。

---

## 5. DB 增长治理
- `gate_runs` 保留最近 3 个月热数据，冷数据 `VACUUM INTO` 归档；`audit` 全量保留（可搜索）。
- 定期 `PRAGMA optimize` + `wal_checkpoint(TRUNCATE)`（每日后台一次）。
- 备份时 `VACUUM INTO` 单文件（见 data-model §4）。

---

## 6. 度量（放进 diag，见 ops）
`GET /api/health?depth=full` 返回：`db_bytes / gate_count / jobs_pending / ctx_cache_hit / last_gate_ms_p95 / ai_calls_24h / cost_24h`；前端「设置→诊断」一页可视化。

---

*规模与性能 v0.1 —— M0/M1 按 §2 前端与 §3 缓存约束实现；§5/§6 归档与 diag 随 M4 补。*

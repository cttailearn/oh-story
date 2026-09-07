# oh-story WebUI 已有小说导入（v0.1）

> 对接 [`api-contract.md`](api-contract.md) `POST /import` 与 [`webui-frontend.md`](webui-frontend.md) 导入向导（P1 项目类型三）。
> 目标：把**已有的书**逆向解析为标准项目结构，让用户能在 WebUI **继续写作/日更**，而不是白抄一遍。

---

## 1. 支持类型与输入
| 输入 | 说明 | 备注 |
|---|---|---|
| 单个文本文件（.txt/.md） | 完整正文（可能无章分界） | 最常见 |
| 目录（正文/ 大纲/ 设定/ 已有拆文…） | 已是半标准结构 | 走"打开已有项目"，不走解析 |
| 拆文库目录 | 作为拆文项目挂载 | 见 teardown-module |
| 粘贴文本 | 不落文件草稿，直接导入 | 同 .txt |

---

## 2. 导入流水线（service 级）

```
POST /import { mode:'text-file'|'dir'|'clipboard', path?/text? }
  ├─ 1 文本读取与清洗（BOM/全角/连续空行归一化，不丢字）
  ├─ 2 分章：启发式切分（优先章回锚）
  │     规则序：`第[一二三…0-9]+[章回]` | `卷一…`(分卷) | `Chapter N` | 空行距≥3
  │     → 输出 chapters[]（含标题、正文、分卷归属；武误区/番外标记）
  ├─ 3 结构猜测（置信度）
  │     能识别"大纲/设定"目录 → 直接复用；否则按正文推断（序言/设定区→设定候选）
  ├─ 4 追踪状态生成（离线确定性 + AI 精修两段式）
  │     a) 确定性：last_committed_chapter=最大连续章；纯文本 tokens 统计
  │     b) AI 精修（story-architect，串行）：前半卷每章摘要（recent_chapters 取尾部 N 章）、
  │        主要角色卡初稿、伏笔种子（明显"伏笔/埋/暗示"句）、时间线事件(高置信)
  │     c) 生成 _tracking-state.json（schema_version 4 对齐），全部标 置信度+来源行号
  ├─ 5 建书 + 落盘标准结构 + entry 记录
  └─ 6 返回「校对清单」→ 前端进入"导入校对"页
```

### 2.1 追踪状态置信度模型
JSON 顶层字段约定：
```json
{
  "schema_version": 4,
  "characters": { "<名>": { "state": "…", "confidence": 0.7, "evidence": ["第050章:…"] } },
  "foreshadow":   { "F001": { "summary": "…", "confidence": 0.5, "evidence": […] } },
  "context":       { "position": {…}, "recent_chapters": [ {chapter,summary,confidence} ] },
  "timeline":      { "E001": { "objective_fact": "…", "confidence": 0.8, "reveal_status": "已揭示" } },
  "imported_through_chapter": 320,
  "last_committed_chapter": 320,
  "state_revision": 0
}
```
- `confidence<0.5` 的条目归入「待校对」；无证据高置信的只建空壳。
- **承诺**：导入只求"可续写"，不求"完美还原"——低置信项靠后续 `consistency-checker`/一致性门禁在写作中逐步修正。

---

## 3. 前端「导入校对」页（webui-frontend §P1 扩展）
```
[导入结果] 识别 320 章 / 主要角色 14 / 伏笔种子 23 / 时间线 9
  ├─ 章节分界: [可视清单] 可合并/切分/改名；误切章标黄 → 手工调整
  ├─ 角色卡:  列表（置信度条）→ 点开补"身份/目标" → 忽略则删
  ├─ 伏笔:    列表（置信度条）→ 标记"误报" 或 留档待确认
  ├─ 时间线:  高置信直接入，低置信列"候选事件"
  └─ [开始续写] → 书进入 pipeline（active_stage=chapter，从 last_committed+1 起跑）
```
- 校对页**不强制全改**：可"先写第 321 章，之后再回头补档"；但 `last_committed_chapter` 未认定时不得解锁 chapter 阶段（fail-closed）。

---

## 4. 边界与幂等
| 边界 | 处理 |
|---|---|
| 无章分界的纯文本 | 按统一 chunk（如 3000 字/章）+ 提示，允许手工修 |
| 番外/请假条/武理区 | 识别并标记，不计入正文连续性 |
| 重复导入 | `Idempotency-Key`；目录/书名重复 → 返回既有书，不覆盖 |
| 超大文件（>2MB） | 拒绝直导，提示拆分 |
| 导入中途中断 | 事务化：分章/追踪写临时目录 → 全部完成才 `rename` 为正式书；失败清理 |

---

## 5. 与 CLI `story-import` 对齐
- 复用其解析经验（章回锚、`_tracking-state.json` 字段语义），但 WebUI 版本**两段式（确定性+AI 精修）且带置信度**，更好进入人校闭环。
- 产物结构完全兼容 CLI：导入后的书 CLI 也能直接 `/skill:story-long-write 日更`（追踪状态唯一权威不变）。

---

*导入 v0.1 —— M4 实现（属打磨项）；分章启发式先以确定性规则 + 人工校对为主，AI 精修作为可选增强。*

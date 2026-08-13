# story-image portrait/turnaround 实测报告

> 2026-08-13 晚 — 任务：测试人物形象图（portrait）+ 三视图（turnaround front/side/back、白背景）生成；
> 内置模板提示词；本地 ComfyUI + 字节 Seedream 双后端验证；按结果优化。

## 结论

- ✅ **portrait**：两个后端都出图成功（竖版，文件 0.3-1.6MB），视觉表现稳定
- ⚠️ **turnaround 单图三格**：**三格水平布局依赖模型能力**——单图生成模型对 "three panels" 指令的遵循度有限，是当前模型能力边界
  - **字节 Seedream 4.0**：尺寸按 aspect 3:1 走**达成横版**，白背景 ~56%（合理）
  - **ComfyUI Krea2 竖版工作流**：始终竖版（被工作流锁死尺寸）
  - **ComfyUI 自带横版工作流**（1536x512）：达成横版，白背景 ~26%（三格被人物+服饰占满）
  - **最优策略**：字节 Seedream 单图三格 + 横版尺寸 / ComfyUI 专用三格布局工作流

## 内置工具

| 工具 | 作用 |
|---|---|
| `scripts/prompt-template.py` | 角色描述串 + 画风 → 标准化英文提示词（portrait/turnaround/cover/scene）|
| `tests/comfyui/krea2_turnaround_api.json` | 1536x512 横版工作流（turnaround 推荐 ComfyUI 起点）|
| `tests/portrait_test/analyze.py` | 测试产物客观指标（尺寸比例、白背景占比、文件大小）|

## 提示词优化迭代

### portrait 模板（v1 一次性稳定）
```
Character portrait, [style], [face], [outfit], [accessory].
half-body/full body, single character, looking at viewer.
background: simple blurred atmospheric scene, [atmosphere].
high detail digital painting, no text, no watermark
```
v1 → v2 → v3 改动极少，模板稳定。

### turnaround 模板（v1 → v2 重大改进 → v3 反例）

| 版本 | 关键变化 | 字节 v 白底 | ComfyUI v 白底 |
|---|---|---|---|
| v1 | `three-panel character turnaround sheet, front view / side view / back view, same character, same outfit, standing pose` + `pure white background` | 39.4% | 0.4%（竖版）|
| v2（最终）| 强化布局：`horizontal triptych character turnaround reference sheet. three equal panels arranged side by side from left to right. panel 1: front view, panel 2: side view, panel 3: back view.`，同一性多句强调，白背景多句表达 | 56.1% | 26.4%（横版工作流）|
| v3（反例）| 在 v2 基础上加 `each panel: generous empty white margins around the figure, figure occupies center 60-70%` | 56.1%（持平）| **7.1%（反降）|

**结论**：v2 模板为最终版。v3"留边指令"对字节无影响、对 ComfyUI 反降——明确"留白边"被 ComfyUI 模型理解成"全部白色 = 人物也白"，反而减少了白底占比。

## 关键发现与建议

1. **三视图的"画布方向"由尺寸决定，不是提示词**：竖版 720x1280 永远出不来三格横排；ComfyUI 必须用横版工作流（aspect ≥ 2:1）；字节端用像素比例 ≥ 2:1（且像素 ≥ 3686400）
2. **白背景是模型能力问题，不是提示词问题**：当前主流生图模型对 "white background" 指令遵循度有限（即使专门指令也只 ~50%），人物+服饰占据部分画面
3. **三视图最优实践**：
   - 字节端：2048x896 横版 + v2 提示词（实测白底 56%）
   - ComfyUI 端：专用三格布局工作流（用户自选）+ 1536x512 起步
   - 一致性：人物描述串（`hair:...face:...outfit:...accessory:...`）在 portrait 与 turnaround 之间保持完全一致——这是 v2 模板的设计原则
4. **face 字段决定"脸部特定"约束**（任务要求）：`face: ...` 显式录入面部特征（瞳形/泪痣/肤色/表情），模板把它放在 "same face in all three views" 同一性指令之后，强化"三视图是同一个人"
5. **prompt-template 内部约定**：`hair`/`face`/`outfit`/`accessory` 是显式字段，`extra` 收纳未归类描述；`--desc` 可直接传逗号分隔多短语，智能归类
6. **测试产物（PNG/JPG）不入库**：.gitignore 已忽略 `skills/story-image/tests/**/*.png|jpg|jpeg|webp|gif`——重跑测试会重新生成，不污染仓库

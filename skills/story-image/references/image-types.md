# 图像类型规范

story-image 支持四类图像生成。每类定义：触发意图、输入信息、提示词模板、输出目录、质量检查表。
风格/题材/光效/构图关键词统一取 [visual-styles.md](visual-styles.md)，本文件只写类型差异。

## 类型一览

| 类型 | 触发 | 输出目录 | 有无文字层 | 默认尺寸 |
| :----- | :----- | :--------- | :----------- | :--------- |
| `cover` 封面 | 封面、封面图 | `covers/<书名>/封面/` | 有（书名+作者名） | 番茄 768x1024(3:4)，默认 1024x1536(2:3) |
| `portrait` 人物形象图 | 人物图、立绘、人设图 | `characters/<角色名>/` | 无 | 1024x1536 |
| `turnaround` 三视图 | 三视图、正侧背面 | `characters/<角色名>/` | 无 | 1024x1024（三格） |
| `scene` 场景图 | 场景图、场景设定 | `scenes/<场景名>/` | 无 | 横版 1536x1024，竖版 1024x1536 |

> 尺寸是提示词里的目标比例说明；各后端 size 参数语义不同（见 SKILL.md「后端差异」），最终平台上传尺寸由裁剪步骤兜底。

---

## cover 封面

### 输入信息

必填：书名、作者名（笔名）、目标平台。选填：参考图（图生图）、风格偏好。

### 提示词三层结构

提示词 = **文字层** + **风格层** + **画面层**，全部英文：

```text
Chinese web novel cover design, [平台风格关键词，取自 visual-styles.md 平台风格节].
Title text '{书名}' at top center in [书名字体风格].
Author name '{作者名}' at bottom center in [作者名字体风格].
[题材风格标签]. [人物描述]. [背景描述].
[色彩指令]. [光效指令].
Professional book cover, high detail digital painting, portrait [3:4|2:3] ratio, keep title and author name inside the central safe area away from edges (inner ~85%), no watermark
```

### 书名字体风格（按题材）

| 题材 | 书名字体 | 作者名装饰 |
| :----- | :--------- | :----------- |
| 玄幻/仙侠 | `bold golden brush calligraphy with metallic glow and sharp strokes` | `small refined white serif text with faint golden glow, flanked by cloud-scroll ornaments, resting on a thin horizontal gold line` |
| 都市 | `modern bold sans-serif with metallic silver finish` | `small clean white modern text with subtle drop shadow, above a thin silver horizontal divider line` |
| 古言/宫斗 | `elegant golden traditional Kai script with ornate decoration` | `small elegant dark red traditional text inside a thin golden rectangular border frame with corner decorations` |
| 现言/甜宠 | `soft rounded handwritten style in white with pink glow` | `small soft pink-white handwritten text with a tiny heart motif on the left side, light sparkle effect` |
| 悬疑/推理 | `distorted bold cracked letters in blood red` | `small pale grey text with slight blur effect, a thin cracked line underneath` |
| 科幻/末世 | `neon glowing futuristic font in electric blue` | `small crisp white monospace text with subtle cyan scanline overlay, flanked by small geometric brackets` |
| 西幻 | `metallic embossed fantasy lettering with glow effect` | `small bronze medieval script text with aged parchment texture, enclosed in a small decorative shield or banner shape` |
| 历史/军事 | `heavy stone-carved seal script in deep red` | `small dignified white Song typeface text above a double horizontal line in dark red` |
| 灵异/恐怖 | `eerie dripping handwritten font in sickly green` | `small faded grey-green text slightly tilted, with a thin dripping ink line above` |
| 轻小说 | `colorful cartoon outlined bubbly font` | `small playful rounded white text with pastel color outline, tiny star decorations on both sides` |

作者名通用规则：`small` 字号、`at bottom center`、必须有装饰元素（线条/边框/小图标/光效至少一种）、与背景对比但不刺眼。

### 平台尺寸

| 平台 | 上传尺寸 | 比例 | 生成 size（openai 像素） |
| :----- | :-------- | :----- | :------------------- |
| 番茄小说 | 600×800 | 3:4 | `768x1024` |
| 其它（默认竖版） | 按平台规格 | 2:3 | `1024x1536` |

有固定上传像素时设 `UPLOAD_SIZE`（番茄 `600x800`），生成后居中裁剪+缩放导出 `_上传` 版（magick/convert/sips 任选其一）。

### 质量检查

文字渲染清晰、字体风格匹配题材、题材视觉一致、构图主体突出、平台比例与尺寸合规（缩放后书名笔名完整可见）。

---

## portrait 人物形象图

### 输入信息

角色名（`设定/角色/{名}.md` 存在则读取外貌特征/身份标签/性格关键词）、半身或全身、表情与姿态、道具（可选）。

### 提示词模板

见 [visual-styles.md](visual-styles.md)「人物形象图规范」。

**一致性约束**：同一角色的「外貌特征+服饰+发型」描述串固定复用，不逐次改写——人设图是后续封面/三视图的事实源。

### 质量检查

外貌与角色卡一致（硬事实表逐项核对）、服饰符合身份题材、单角色构图、无文字。

---

## turnaround 三视图

### 输入信息

角色名（复用 portrait 已固化的外貌描述串）、服装（通常与立绘同一套）。

### 提示词模板

见 [visual-styles.md](visual-styles.md)「三视图规范」。

**后端差异**：

- openai/volcengine/dashscope：单图三格提示词（`three-panel character turnaround sheet, front view / side view / back view`）
- comfyui：使用 `workflows/turnaround.json`（三格布局节点控制，需本地 ComfyUI 安装对应节点）

### 质量检查

三视角同一性逐项比对（发型/服饰颜色/饰品位置/体态），任一不一致即不合格；姿态统一站立；背景极简。

---

## scene 场景图

### 输入信息

场景名、地点类型（城镇/宗门/战场/内景…）、时间/季节/天气、横竖版、是否有世界观设定文件可参考（`设定/世界观/{主题}.md`）。

### 提示词模板

见 [visual-styles.md](visual-styles.md)「场景图规范」。

### 质量检查

场景元素与世界观规则一致（如力量体系对应的建筑/环境特征）、光影与时间设定一致、前中后景层次完整、无文字。

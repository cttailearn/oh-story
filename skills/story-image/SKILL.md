---
name: story-image
version: 2.1.0
description: "故事图像生成。生成小说封面、角色卡图（统一立绘/人设/三视图）、场景图，支持多后端（GPT-Image-2、GrsAI、火山方舟 Seedream、阿里通义万相、本地 ComfyUI），自动探测已配置后端，未配置时主动询问用户提供 API Key。触发方式：/skill:story-image、/封面、/人物图、/立绘、/三视图、/角色卡图、/场景图、「帮我做个封面」「生成封面图」「做个小说封面」「封面设计」「生成人物形象图」「生成三视图」「生成场景图」。"
---

# story-image：故事图像生成

你是故事图像设计师。按用户意图生成四类图像之一：封面（含书名/作者名文字层）、人物形象图（立绘）、角色三视图、场景图。一次只处理一个意图；生成后按类型检查表自检，不合格迭代。

**核心原则：图像是故事视觉资产——封面卖相、人设一致性、场景设定可视化，三类资产的共同底线是「与设定一致」。**

## 环境变量

| 变量 | 后端 | 必填 | 说明 |
| :----- | :----- | :----: | :----- |
| `GPT_IMAGE_API_KEY` | openai | ✅ | OpenAI 或兼容代理的 API Key |
| `GPT_IMAGE_BASE_URL` | openai | | 兼容代理时改；默认 `https://api.openai.com/v1` |
| `GRSAI_API_KEY` | grsai | ✅ | GrsAI（grsai.ai）API Key，控制台创建；OpenAI 风格 GPT-Image 接口 |
| `GRSAI_BASE_URL` | grsai | | 默认 `https://api.grsai.com`（海外）；国内可设 `https://api.grsai.cn` |
| `GRSAI_MODEL` | grsai | | 默认 `gpt-image-2` |
| `ARK_API_KEY` | volcengine | ✅ | 火山方舟 Key（字节 Seedream） |
| `ARK_IMAGE_MODEL` | volcengine | | 默认 `doubao-seedream-4-0-250828`（最兼容，实测通过）；可用模型 `GET /api/v3/models` 查询。**模型 size 语义不同**：4.0 支持 `1K/2K/4K` 或任意 `宽x高`；5.0/4.5 只支持 `2k/3k/4k`（小写）或 `宽x高`（像素 ≥ 3686400，如 1440x2560） |
| `DASHSCOPE_API_KEY` | dashscope | ✅ | 阿里云百炼 Key（通义万相） |
| `DASHSCOPE_IMAGE_MODEL` | dashscope | | 默认 `wanx2.1-t2i-turbo` |
| `DASHSCOPE_MODE` | dashscope | | `async`（默认，原生异步+轮询）/ `compatible`（OpenAI 兼容同步） |
| `COMFYUI_URL` | comfyui | | 默认 `http://127.0.0.1:8188`；本机整合包（FaboroHacks 版）端口为 **8198**，需设置 `COMFYUI_URL=http://127.0.0.1:8198` |
| `COMFY_CKPT` | comfyui | | 检查点名（不设则用工作流内已有配置或 `--ckpt`） |
| `COMFYUI_WORKFLOW_DIR` | comfyui | | 本地工作流 JSON 目录，默认 `~/ComfyUI/user/default/workflows/`（`--list-workflows` 列出） |
| `IMG_BACKEND` | 全局 | | 显式指定后端，跳过探测 |
| `UPLOAD_SIZE` | 封面 | | 平台固定上传像素（番茄 `600x800`），生成后居中裁剪导出 |
| `REF_IMAGE` | openai | | 参考图本地路径或 URL（图生图） |

**外部依赖**：curl；JSON 处理内置 Python 脚本（`api-json.py` 云后端 / `comfyui-json.py` ComfyUI 后端，均无需 jq）；ComfyUI 后端用 Python 生成 client_id（无需 uuidgen）；openai/dashscope 后端另需 base64。脚本入口有前置检查，缺依赖会给出中文提示。**已实测环境**：Windows Git Bash + 本地 Python 3.13 + ComfyUI 0.30（FaboroHacks 整合包，端口 8198）；火山方舟 Seedream 4.0（720x1280 竖版实测通过）。

## 生成流程

> **配置前置（进入任何 Step 前先做一次）**：跑 `bash <skill-dir>/scripts/imagegen.sh --list-backends` 检测已配置后端。**未配置任何后端时，先用 AskUserQuestion 询问用户提供 API Key 或选择后端**（询问文案见 Step 4「先检测配置」），不得直接开始生成或报错退出。

### Step 1：确定图像类型与收集信息

从用户意图确定类型（[references/image-types.md](references/image-types.md)），按类型收集信息：

| 类型 | 必填信息 | 选填 |
| :----- | :--------- | :----- |
| cover 封面 | 书名、作者名（笔名）、目标平台 | 参考图、风格偏好、平台上传尺寸 |
| **char-sheet 角色卡图** | 角色名（读 `设定/角色/{名}.md` 的 基础信息/形象与能力/身份标签/性格关键词；用 `scripts/character-card.py` 自动提取） | 表情网格、色板、简介、关键词标签、中英双语（--lang） |
| portrait 人物形象图 | 角色名（旧单图模式；新项目建议用 char-sheet 替代） | 半身/全身、表情姿态、道具 |
| turnaround 三视图 | 角色名（旧三格模式；新项目建议用 char-sheet 替代） | 服装（默认与立绘同一套） |
| scene 场景图 | 场景名、地点类型、时间/天气 | 横/竖版、`设定/世界观/{主题}.md` 参考 |

> **char-sheet 角色卡图（推荐）**：统一替代 portrait/turnaround——参考表布局（大标题+基本信息面板+三视图+表情网格+服装分解+色板），从角色卡自动提取信息构建提示词，支持中英双语（`--lang en|zh`）与模块裁剪（`--modules`）。角色图强烈建议先有 `设定/角色/{名}.md`——人设卡是图像一致性的唯一事实源；没有卡片时先让用户提供或先用 generation 草稿后回写入设卡。缺书名/作者名/角色名等必填信息必须问用户，不得编造。

**封面卖点注入**（cover 类型）：写作项目内生成封面时，先读 `设定/题材定位.md` 的「表层卖点」「核心梗三分法」，把表层卖点化为一个画面元素写进提示词画面层（例：卖点「混剪引爆全网」→ 画面加入“视频剪辑风暴/屏幕弹出爆款数据”元素），封面不是只有书名——卖点要一眼可见。

### Step 2：题材判定

扫描书名/角色卡/场景关键词，对照 [references/visual-styles.md](references/visual-styles.md) 的「题材推断规则」表选定题材。多命中按优先级：仙侠 > 西幻 > 古言 > 现言 > 都市 > 悬疑 > 科幻 > 历史 > 灵异 > 轻小说；零命中默认都市。

### Step 3：构建提示词

按类型读对应模板：

- cover：image-types.md「cover 封面」（文字层+风格层+画面层；书名字体表/作者名装饰表）
- char-sheet / portrait / turnaround / scene：image-types.md 对应章节 + visual-styles.md 的类型规范节（角色卡图/人物形象图/三视图/场景图规范）

风格/题材/光效/构图关键词统一取自 visual-styles.md。全英文提示词写入临时文件（`mktemp`），调用脚本时传 `--prompt-file`。

**内置提示词模板（推荐）**：用 `scripts/prompt-template.py` 一键生成标准化提示词，避免手写拼接出错。

**char-sheet 角色卡图（首选）**：先用 `scripts/character-card.py` 从 `设定/角色/{名}.md` 自动提取素材，再组装提示词（支持中英双语）：

```bash
# 1) 提取角色卡素材（--json 输出供程序消费；人类可读输出可直接参考）
python <skill-dir>/scripts/character-card.py "{项目}/设定/角色/{名}.md" --json

# 2) 中文版角色卡图（参考表布局）
python <skill-dir>/scripts/prompt-template.py char-sheet jinjin --lang zh \
  --name {角色名} --pinyin {拼音} \
  --info "姓名={名}; 年龄={X}岁; 身份={身份}; 气质={性格}" \
  --desc "face: {外貌记忆点}, hair: {发型}, outfit: {服饰}, accessory: {饰品}" \
  --colors "#FFFFFF,#000000" --bio "{核心目标}" --tags {性格关键词逗号分隔}

# 英文版：--lang en（模型对英文布局指令理解更稳）；提示词过长时可 --modules 裁剪
# （如 --modules header,info,expressions,breakdown 去掉 palette）
```

**旧模式（兼容保留）**：

```bash
# portrait 半身/全身单图
python <skill-dir>/scripts/prompt-template.py portrait jinjin \
  --desc "hair: long black hair straight bangs covering eyebrows, \
          face: almond eyes with a small tear mole under left eye, \
          outfit: red and white hanfu crossed collars wide sleeves, \
          accessory: silver hairpin and white jade earring"

# turnaround 三视图（front/side/back，纯白背景，水平 triptych）
python <skill-dir>/scripts/prompt-template.py turnaround jinjin \
  --desc "hair: ..., face: ..., outfit: ..., accessory: ..."
```

> **三视图局限**：单图三格提示词对当前主流模型（Krea2/Seedream 4.0）是**能力边界**——三格布局+纯白背景难两全。优化提示词能稳住横版（aspect 3:1）与多数白底（实测字节 Seedream 4.0 白底 ~56%），但人物+服饰仍会占据一部分画面。最稳的方案是 **ComfyUI 专用三格布局工作流**（用户自选）；本仓库在 `tests/comfyui/` 提供了 1536x512 的精简横版工作流 `krea2_turnaround_api.json` 作为默认起点。char-sheet 的三视图部分同样适用此注意点。

### Step 4：调用后端

**先检测配置（调用前必做，不直接跑脚本碰壁）**：

1. 先跑 `bash <skill-dir>/scripts/imagegen.sh --list-backends` 列出**所有**已配置的后端（openai/grsai/volcengine/dashscope/comfyui 每行一个；无任何配置时退出码 1 且无输出）。`IMG_BACKEND` 已设置时直接用该后端并跳过探测。
2. **无任何后端已配置时，不得直接报错退出**——用 AskUserQuestion 询问用户：
   - 选项 1：**我提供 API Key** → 让用户粘贴 key，然后引导用户配置到环境（当前会话导出 + 提示持久化方式，如写入 `~/.bashrc` 或 pi 配置）；配置后可继续本次生成
   - 选项 2：**本地 ComfyUI** → 提示先启动 ComfyUI（`COMFYUI_URL` 默认 `http://127.0.0.1:8188`），探测到后继续
   - 选项 3：**先跳过** → 停止生成，告知用户随时可回来继续
   - 询问时把各后端用途列清楚：GPT-Image（OpenAI 或兼容代理）/ GrsAI（grsai.ai，需在控制台创建 key）/ 火山方舟 Seedream / 通义万相 / 本地 ComfyUI。用户明确指定后端时优先该后端。
3. 用户提供 key 后，**先做一次连通性验证**再进入正式生成：用极小成本请求（或直接跑本次生成并在失败时定位）——至少确认 key 格式非空且后端可达（curl 一次 API 根路径或文档端点）；失败时给出该后端典型错误对照（401=key 无效/过期，429=限流，5xx=服务端）。
4. 多后端已配置时默认按探测顺序取第一个，但可提示用户指定：`IMG_BACKEND=openai|grsai|volcengine|dashscope|comfyui`。

统一入口 `scripts/imagegen.sh`，先探测后端（`IMG_BACKEND` 显式指定优先）：

```bash
bash <skill-dir>/scripts/imagegen.sh auto \
  --prompt-file "$PROMPT_FILE" \
  --size "<后端语义的尺寸>" \
  --out "<输出路径>"
```

**后端差异（size 语义与专属参数）**：

| 后端 | size 语义 | 专属 |
| :----- | :---------- | :----- |
| openai | 像素 `1024x1536` 等 | `--ref` 图生图（REF_IMAGE） |
| grsai | **宽高比** `1:1`/`2:3`/`3:4`（aspectRatio 语义，默认 `1:1`） | 同步返回 `results[].url` 下载；`--ref` 图生图（参考图 URL 或本地路径自动转 data URL）；输出为 JPEG 时自动修正扩展名 |
| volcengine | 规格串 `1K`/`2K`/`4K` 或像素（透传；4.0 任意，5.0/4.5 需 ≥3686400 像素或 2k/3k/4k） | 响应 url 下载；**输出为 JPEG**，脚本按实际格式自动修正扩展名（传 `.png` 也会改为 `.jpg`） |
| dashscope | 规格串 `1024*1024`、`720*1280`（星号分隔） | 异步轮询（默认） |
| comfyui | 不适用（尺寸在工作流里） | `--workflow <API格式JSON> --prompt <文本> --negative <文本> [--ckpt]` |

**ComfyUI 工作流：不内置模板，查询本地已有工作流由用户自主选择**：

1. 先列出本地工作流：`bash <skill-dir>/scripts/imagegen-comfyui.sh --list-workflows`。目录自动探测（全通用规则，无本机路径硬编码）：显式参数 > `COMFYUI_WORKFLOW_DIR` > `~/ComfyUI` 默认路径 > 便携版常见位置 > **从正在运行的 ComfyUI 进程反推安装目录**（先启动 ComfyUI 有助探测）；探测失败会提示手动输入路径或设置 `COMFYUI_WORKFLOW_DIR`。列表自动标注类型（文生图/图生图/视频/其他）；用户自己保存/下载的工作流 JSON 也可直接给路径
2. 列出清单让用户选一个（用 AskUserQuestion）；选好把路径传给 `--workflow`
3. 只接受 **API 格式**（ComfyUI 里菜单 Workflow → Export (API) 导出）；传了界面格式（UI format）脚本会提示转换，不静默失败。本地工作流目录里如果全是 UI 格式，可用配套转换工具：`python <skill-dir>/scripts/ui2api.py --url "$COMFYUI_URL" --input <UI格式.json> --output <输出.json>`（实验性：标准节点可靠；旧版自定义节点参数可能错位，转换时会按节点定义校验并警告，需人工核对后再用）
4. 提示词注入：工作流里把提示词节点文本设为 `__PROMPT__`（负向 `__NEGATIVE__`、检查点 `__CKPT__`）最可控；未设占位符时脚本自动注入到 CLIPTextEncode 节点（ID 最小=正向、次小=负向）并打印注入位置供核对
5. 需要本地 ComfyUI 已启动；检查点名可用 `--ckpt` 或 `COMFY_CKPT` 指定，或在工作流里用 `__CKPT__` 占位
6. **出图耗时提示**：含放大/重绘环节的工作流（如 UltimateSDUpscale）单张可能超过默认 300s，用 `--timeout <秒>` 调大；已实测精简文生图（8 步 Krea2）约 20s 出图

**输出路径约定**（自增版本号，不覆盖历史版本）：

- cover → `covers/<书名>/封面/封面_v{N}.png`
- **char-sheet → `characters/<角色名>/char-sheet_v{N}.png`（角色卡图首选；portrait/turnaround 旧图不迁移）**
- portrait → `characters/<角色名>/portrait_v{N}.png`（兼容旧模式）
- turnaround → `characters/<角色名>/turnaround_v{N}.png`（兼容旧模式）
- scene → `scenes/<场景名>/scene_v{N}.png`

脚本自动落盘同名 `.prompt.txt`（提示词副本，便于迭代微调）。

### Step 5：平台尺寸导出（仅封面）

设了 `UPLOAD_SIZE`（番茄 `600x800`）时把原图居中裁剪+缩放导出 `_上传` 版（magick/convert/sips 任选其一），原图保留。书名/笔名在中心安全区（内 85%），裁剪不切字。

### Step 6：质量检查 + 迭代

按 image-types.md 各类型检查表自检；不合格则调整方向重试：

- cover：文字渲染/题材匹配/构图/平台尺寸
- portrait：与角色卡一致/服饰身份题材/单角色无文字
- turnaround：三视角同一性逐项比对（发型/服饰颜色/饰品/体态）——不一致即不合格
- scene：与世界观规则一致/光影时间一致/层次完整

### Step 7：回写写作资产（char-sheet/portrait/turnaround 必做）

- char-sheet/portrait/turnaround 生成验收后，把最新图路径写进 `设定/角色/{名}.md` 的「形象图」字段（`characters/{名}/char-sheet_v{N}.png` + 生成日期；旧模式图为 `portrait_v{N}.png`/`turnaround_v{N}.png`），角色卡无该字段则补一行——形象图从此成为卡片的可检索事实；已有多图记录时把版本号 N 递增并**替换**旧行（不叠加历史版本）
- 读取角色卡外貌描述串时跳过「形象图」行本身（它是生成记录不是描述素材），描述素材取「形象与能力」标题的外貌记忆点/分时期表；用 `scripts/character-card.py` 提取时该行为已自动跳过
- cover 生成后不需要回写（封面属于书目而非角色）

## 参考资料

| 文件 | 何时加载 |
|:-----|:---------|
| [references/image-types.md](references/image-types.md) | 任何生成任务：类型模板/输出目录/质量检查表 |
| [references/visual-styles.md](references/visual-styles.md) | 题材判定、风格标签、平台风格、光效构图关键词 |

## 语言

- 跟随用户的语言回复；中文回复遵循《中文文案排版指北》

# story-image ComfyUI 后端测试报告

> 更新：2026-08-13 晚 — 追加火山方舟（volcengine）后端实测章节。

测试日期：2026-08-13
测试环境：Windows + Git Bash + Python 3.13（G:\AI\miniconda3）+ ComfyUI 0.30.0（FaboroHacks 整合包，端口 **8198**）

## 结论

story-image 的 ComfyUI 后端**核心链路可用**：工作流选择 → 提示词注入 → 提交 → 轮询 → 下载全流程实测通过。测试中发现并修复 3 个脚本级问题、新增 2 个工具。

## 环境画像（整合包实际资源）

| 资源 | 内容 |
|------|------|
| 检查点 | 无传统 checkpoint（空） |
| 扩散模型 | `krea 2\moodyCutieMixKrea2_v40.safetensors`、`minimaxh3\minimax_h3_fl2va/ref2va_int8`、`moodyWildMixZIBZID_v40` |
| LoRA | `minimaxh3\minimax_h3_turbo_4step*` ×3 |
| CLIP | `qwen3vl_4b_fp8_scaled.safetensors`（krea2 类型） |
| VAE | `qwen_image_vae.safetensors`、`ae.safetensors` 等 |
| 文生图工作流 | `moodyKrea24KHD_v20.json`、`文生图_Moody Zimage Base Simple Workflow - V1.2.json`（均 UI 格式） |
| 关键节点 | Krea2ImageNode / MiniMaxH3Turbo* / KSamplerAdvanced / UltimateSDUpscale（2124 个节点类） |

## ComfyUI 后端实测结果

| 测试项 | 结果 | 耗时 |
|--------|------|------|
| 精简 Krea2 文生图（888x1336, 8步, euler_ancestral+beta） | ✅ PNG 有效 | ~20s |
| imagegen.sh 主入口分发（IMG_BACKEND=comfyui） | ✅ | — |
| --list-workflows 指定目录 | ✅ 列出 7 个本地工作流 | — |
| 占位符注入（__PROMPT__） | ✅ 打印注入方式 | — |
| 自动注入（无占位符 → CLIPTextEncode ID 最小） | ✅ 打印注入节点 | — |
| USDU 放大（512x768→768x1152, 1.5x, tiled_decode） | ✅ PNG 有效 | ~3-4min |
| USDU 大尺寸（888x1336→2.5x, tiled_decode=False） | ⚠️ 60min+ 未完成，已中断 | — |

## 火山方舟 volcengine 后端实测（2026-08-13）

### 结论

字节 Seedream 文生图 **实测通过**：脚本修复 jq 依赖后全流程可用（auto 分发 → 提交 → 下载 → 格式修正）。

### 实测记录

| 测试项 | 结果 |
|--------|------|
| API key 有效性（GET /api/v3/models，129 个模型） | ✅ |
| doubao-seedream-4-0-250828（脚本默认）| ✅ 1K 横版 1152x864 出图 |
| 竖版 720x1280 | ✅ 出图 + 扩展名自动修正 png→jpg |
| imagegen.sh auto 分发（ARK_API_KEY > ComfyUI 探测顺序）| ✅ |
| doubao-seedream-5-0-260128 | ✅ size=2k 可用；像素需 ≥3686400 |
| doubao-seedream-5-0-pro-260628 | ❌ 404（账号未开通）| 

### 发现并修复的问题

**P6 云后端脚本全部依赖 jq（与 P1 同类，Git Bash 缺失直接阻塞）**
`imagegen-volcengine.sh` / `imagegen-openai.sh` / `imagegen-dashscope.sh` 均硬依赖 jq。
**修复**：新增 `scripts/api-json.py`（通用云后端 JSON helper：body / has-error / field / first-image / task-id / task-status / fix-ext），三个脚本全部改为 curl + python，jq 依赖清零。dashscope 原生异步模式（task 轮询）同步改造（无阿里 key，未实测，逻辑与 volcengine 同构）。

**P7 输出格式与扩展名不符**
Seedream 返回 **JPEG**，但 `--out` 约定 `.png`。**修复**：`fix-ext` 按 magic bytes 检测实际格式（JPEG/PNG/WebP/GIF），不符时自动改名（如 `ark_v2.png` → `ark_v2.jpg`），三个云脚本统一接入。

**P8 模型 size 语义差异（实测发现，文档化）**
| 模型 | size 支持 |
|------|----------|
| 4.0（默认）| `1K`/`2K`/`4K` 或任意 `宽x高`（1K=1152x864 横版）|
| 4.5 / 5.0 | `2k`/`3k`/`4k`（小写）或 `宽x高`（像素 ≥ 3686400，如 1440x2560）|
| 5.0-pro | 未开通（404）|
已写入 SKILL.md 环境变量表。

### 使用注意

- 竖版封面：4.0 直接传 `720x1280`（封面 600x800 语义接近）；5.0 需 `1440x2560` 等大像素
- 输出 JPEG：脚本自动改扩展名，`UPLOAD_SIZE` 导出逻辑按实际文件处理

| 测试项 | 结果 | 耗时 |
|--------|------|------|
| 精简 Krea2 文生图（888x1336, 8步, euler_ancestral+beta） | ✅ PNG 有效 | ~20s |
| imagegen.sh 主入口分发（IMG_BACKEND=comfyui） | ✅ | — |
| --list-workflows 指定目录 | ✅ 列出 7 个本地工作流 | — |
| 占位符注入（__PROMPT__） | ✅ 打印注入方式 | — |
| 自动注入（无占位符 → CLIPTextEncode ID 最小） | ✅ 打印注入节点 | — |
| USDU 放大（512x768→768x1152, 1.5x, tiled_decode） | ✅ PNG 有效 | ~3-4min |
| USDU 大尺寸（888x1336→2.5x, tiled_decode=False） | ⚠️ 60min+ 未完成，已中断 | — |

## 发现并修复的问题

### P1 脚本依赖 jq/uuidgen（Git Bash 缺失，直接阻塞）
`imagegen-comfyui.sh` 前置检查要求 jq + uuidgen，本机 Git Bash 均缺失。
**修复**：新增 `scripts/comfyui-json.py`（format/inject/nodeinfo/firstimage 四个子命令，Python 标准库实现），脚本改为 curl + python，零第三方依赖。

### P2 UI 格式工作流无法使用（本地工作流全是 UI 格式）
脚本只接受 API 格式，本地 7 个工作流全部是 UI 格式。
**修复**：新增 `scripts/ui2api.py`（实验性转换工具）：
- 按 object_info 的 input 定义把 widgets_values 映射到无连接 input（有连接的 input 同样消耗 widget 值——ComfyUI 前端行为）
- 复杂类型（MODEL/CLIP/IMAGE…）无 widget 不消耗；INT/FLOAT/STRING/BOOLEAN 是基本类型有 widget（初期误归类为复杂类型导致系统性错位，已修）
- KSampler/KSamplerAdvanced/USDU 的 seed 后 'randomize' toggle 自动跳过（值可能是字符串 'randomize' 或整数 1）
- Reroute 透传内联、SetNode/GetNode 按 widget 名配对解析
- 转换后按 spec 校验每个值（combo 合法性/INT 范围/FLOAT/BOOLEAN 类型），错位自动警告
- 实测：标准节点（UNETLoader/CLIPTextEncode/KSamplerAdvanced/VAEDecode/SaveImage/ConditioningSwitch 等）转换 100% 正确；两个工作流提交验证的 node_errors 全部能在转换警告中找到对应项

**已知局限**：旧版节点保存的工作流（如 UltimateSDUpscale 的 seed_control toggle 已在新版移除）widget 顺序与当前定义不一致，无法自动修复——转换器给出精确警告，需在 ComfyUI 中核对参数后重新 Export (API)。**优先建议：用户在 ComfyUI 里直接 Export (API) 格式。**

### P3 多输出工作流下载错图（输出顺序不稳定）
`firstimage` 取 outputs 第一个有图的节点——多 SaveImage 工作流（原图+放大图）时 ComfyUI 并行执行完成顺序不稳定，两次运行输出顺序相反，下载到原图而非最终产物。
**修复**：改取**节点 ID 最大**的输出（通常=流程末端最终产物），实测两次均下载到放大图。

### P4 环境端口差异（非 bug，记录）
整合包启动脚本用 **8198** 端口，SKILL.md 已注明（COMFYUI_URL 环境变量覆盖）。

### P5 工作流目录无法自动发现（改进：通用探测 + 询问）
`--list-workflows` 原默认只扫 `~/ComfyUI/user/default/workflows`（本机不存在，整合包在 G 盘）。
**改进**（全通用规则，无本机路径硬编码）：
1. `comfyui-json.py discover-workflows`：显式参数 → `COMFYUI_WORKFLOW_DIR` → `~/ComfyUI` 默认 → 便携版常见位置 → **进程反推**（Windows 查 Win32_Process 的 python 进程命令行，Linux 查 /proc；从 python 可执行路径上溯推导 workflows 目录）
2. 列表模式：找到 1 个直接用；多个候选列出供选择（非交互默认取第一个）；0 个提示手动输入路径或设置环境变量
3. 列表自动标注类型：文生图/图生图/视频/其他（按节点名粗判，实测本机 7 个工作流分类全部正确）
4. Git Bash 路径转换：python 输出的 Windows 风格路径经 cygpath 转 MSYS 风格（无 cygpath 的环境原样）
5. 踩坑：powershell 输出是 GBK 编码，中文路径 utf-8 解码会损坏——已加 `[Console]::OutputEncoding=UTF8` 前缀

**实测**：无参数 `--list-workflows` 直接发现整合包目录并正确标注 7 个工作流（5 视频 + 2 文生图）。

## 使用建议（写入 SKILL.md）

1. **优先用 ComfyUI 导出 API 格式工作流**（Workflow → Export (API)），占位符 `__PROMPT__` 最可控
2. 本地 UI 格式工作流用 `ui2api.py` 转换 + 核对警告
3. 含放大环节的工作流单张 >300s，用 `--timeout <秒>` 调大
4. USDU 参数建议：`tiled_decode=True`、`force_uniform_tiles=False`、控制 upscale_by（大尺寸 2.5x + 非 tiled decode 实测 60min+ 未完成）

## 测试产物

- `tests/comfyui/krea2_t2i_api.json` — 精简 Krea2 文生图 API 模板（带 __PROMPT__ 占位符，可直接复用）
- `tests/comfyui_out/` — 各次生成结果（test_krea2_v1 / dispatch_v1 / usdu_small_v3 / regress_v1 等，含 .prompt.txt）

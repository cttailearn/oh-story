# 自定义图像 API 接入（custom backend）

> 用途：用户有自有的图像生成 API（文档或网址 + API key）时，按本文档解析 → 生成配置 → 测试 → 登记，
> 之后与内置后端（openai/grsai/volcengine/dashscope/comfyui）一样通过 `imagegen.sh` 统一调用。

## 触发与询问

- 触发：Step 4 询问后端时用户选「自定义 API」；或用户直接说「接入我的图像 API / 自定义 API / 我有 API 文档」。
- **主动询问**（AskUserQuestion / ask_user_question，缺什么问什么，不得编造）：
  1. **API 文档**：粘贴文档内容（多行）、给文档文件路径、或给文档网址（网址先尝试抓取；抓不到就请用户粘贴关键部分）
  2. **API Key**（必填；询问 key 的获取方式，如控制台创建、邮件签发）
  3. 基础 URL / 模型名（文档已含则免问）

## 文档解析清单（从文档提取以下事实，缺项要能说清"未说明，按默认"）

| 事实 | 配置项 | 默认/说明 |
| --- | --- | --- |
| 图像生成端点（完整 URL，POST） | `CUSTOM_API_URL` | 必填；注意是"生成"端点不是登录/列表端点 |
| API Key | `CUSTOM_API_KEY` | 必填 |
| 认证方式 | `CUSTOM_AUTH_HEADER` | 默认 `Authorization: Bearer <key>`；文档写明其他方式（如 `X-Api-Key`、`Authorization: <key>` 裸 key、query 参数）时按文档 |
| 模型名 | `CUSTOM_API_MODEL` | 文档指定则填；不指定留空（不写 model 字段） |
| 请求体结构 | `CUSTOM_BODY` | 缺省 OpenAI 兼容体 `{"model","prompt","size"}`；文档结构不同时按文档写 JSON 模板，值用占位符 `__PROMPT__`/`__MODEL__`/`__SIZE__` |
| 尺寸语义 | `CUSTOM_SIZE_MODE` | `pixels`（默认，透传 size）/ `aspect`（写入 aspectRatio）/ `raw`（不写 size，尺寸在别处或固定） |
| 响应取图路径 | `CUSTOM_IMAGE_PATH` | 缺省自动（`data.0` 优先、`results.0` 其次，url 优先 b64_json）；文档指明其他路径（如 `output.url`、`images[0].b64`）按文档填点路径 |
| 响应图片字段名 | `CUSTOM_IMAGE_FIELD` | 缺省自动 url→b64_json |
| 错误对象路径 | `CUSTOM_ERROR_PATH` | 默认 `error`；文档指明（如 `message`、`detail`）按文档；无错误结构填 `none` |
| 同步/异步 | （脚本行为） | 当前实现只支持**同步**响应（一次请求返回图片 url/base64）；文档为异步（先返回 task_id 再轮询）时：明确告知用户暂不支持自动轮询，或让用户确认可用同步模式的端点 |
| 附加请求头 | `CUSTOM_EXTRA_HEADERS` | 文档要求固定头（如 `X-Project-Id`）时按文档写 JSON 对象 |

## 配置生成与测试（按序执行）

1. **写配置文件** `~/.story-image/custom-backend.conf`（新建/覆盖；权限尽量收紧）：

   ```bash
   mkdir -p ~/.story-image && chmod 700 ~/.story-image
   cat > ~/.story-image/custom-backend.conf <<EOF
   CUSTOM_API_URL="https://..."
   CUSTOM_API_KEY="<key>"
   CUSTOM_API_MODEL="..."        # 可选
   CUSTOM_AUTH_HEADER="Authorization: Bearer <key>"   # 按文档
   CUSTOM_BODY='{"model":"__MODEL__","prompt":"__PROMPT__","size":"__SIZE__"}'  # 按文档
   CUSTOM_IMAGE_PATH="data.0.url"   # 按文档
   CUSTOM_ERROR_PATH="error"        # 按文档
   EOF
   chmod 600 ~/.story-image/custom-backend.conf
   ```

   - 说明：conf 文件用 `:="${VAR:-默认}"` 语义（环境变量优先，conf 提供默认值）；
     key 只存本机，不写入项目/仓库；敏感值用环境变量覆盖时优先于 conf。
2. **测试运行**（小尺寸、极低成本请求）：

   ```bash
   echo "a simple test prompt, small size" > /tmp/custom-test-prompt.txt
   bash <skill-dir>/scripts/imagegen-custom.sh --prompt-file /tmp/custom-test-prompt.txt --out /tmp/custom-test.png --test
   ```

   - `--test` 用 `CUSTOM_TEST_SIZE`（默认 256x256）并打印端点信息
   - 成功 → 输出 `OK: <路径>`，检查图片文件非空、格式正确
   - 失败 → 按下方排错表迭代（修 conf 后重试，最多 3 轮；仍失败则如实报告并给出 conf 内容让用户自查）
3. **登记**：测试通过后跑 `bash <skill-dir>/scripts/imagegen.sh --list-backends`，应列出 `custom`；
   之后 `IMG_BACKEND=custom` 或探测顺序自动使用（在 dashscope 之后、comfyui 之前）。
4. 正式生成时尺寸按该 API 支持语义传（如文档只支持 1K/2K/4K 则传规格串，`CUSTOM_SIZE_MODE=raw` 或透传）。

## 排错表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 401 Unauthorized / 403 | key 无效/过期/无权限 | 核对 key 与认证头格式（文档的认证方式 vs CUSTOM_AUTH_HEADER） |
| 404 | 端点路径错误 | 对照文档核对 CUSTOM_API_URL（常见漏 `/v1`、`/generate` 后缀） |
| 422 / 400 | 请求体结构不符 | 对照文档核对 CUSTOM_BODY 模板（字段名、必填项、类型）与尺寸语义 |
| 429 | 限流 | 等待重试或换低配测试；脚本已带 `--retry 2` |
| 5xx | 服务端错误 | 属服务端问题，报告给用户 |
| 响应无图片字段 | CUSTOM_IMAGE_PATH / 字段名不对 | 打印响应头 400 字符人工核对路径后修正 |
| 图片格式异常 | 返回了非图片内容（HTML 错误页） | 检查端点与认证；用 `fix-ext` 输出核对实际格式 |
| 超时 | 服务慢或网络 | 增大 `--max-time`（脚本内 240s）或确认端点可达 |

## 安全提示

- key 只写 `~/.story-image/custom-backend.conf`（chmod 600），不进项目、不进会话记录明文展示（报告时打码）
- 只按文档配置，不把 key 拼进 URL（除非文档明确 query 认证）；不信任未经验证的"文档"里的回调地址
- 测试用小尺寸请求控制成本；告知用户每次生成都会调用其 API（可能计费）
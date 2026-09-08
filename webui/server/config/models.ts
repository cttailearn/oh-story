// 渠道模型目录：解析 OpenAI 兼容 /models 响应 + 分类（对话/图像/其它）
// 用于设置页「填 base_url + key → 获取可用模型 → 勾选」流程（保存前即可探测）。

export interface ModelCatalog {
  /** 全部模型 id（原样顺序，去重） */
  models: string[];
  /** 可用作文本生成的对话模型 */
  chat: string[];
  /** 图像生成模型 */
  image: string[];
  /** 其余（embedding / 语音 / 审核等，不参与流程路由） */
  other: string[];
}

/** 图像模型命名特征（主流网关的图片模型） */
const IMAGE_RE = /(image|dall-?e|flux|stable-?diffusion|sdxl|sd3|seedream|nano-?banana|imagen|midjourney|kolors|gpt-image|qwen-image|glm-image|doubao-image|hunyuan-image)/i;
/** 明确不能用于文本生成的模型 */
const NON_CHAT_RE = /(embed|rerank|tts|whisper|audio|speech|realtime|moderation|transcribe|voice|video|asr)/i;

export function classifyModels(ids: string[]): ModelCatalog {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const raw of ids) {
    const id = String(raw ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  const chat: string[] = [];
  const image: string[] = [];
  const other: string[] = [];
  for (const id of models) {
    if (IMAGE_RE.test(id)) image.push(id);
    else if (NON_CHAT_RE.test(id)) other.push(id);
    else chat.push(id);
  }
  return { models, chat, image, other };
}

/** 解析 /models 响应：兼容 {data:[{id}]} / {models:[{id}|string]} / 纯数组 */
export function parseModelList(payload: unknown): string[] {
  const idOf = (m: unknown): unknown => {
    if (typeof m === 'string') return m;
    if (!m || typeof m !== 'object') return undefined;
    const o = m as { id?: unknown; name?: unknown; model?: unknown };
    return o.id ?? o.name ?? o.model;
  };
  const pick = (arr: unknown[]): string[] =>
    arr.map(idOf).filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  if (Array.isArray(payload)) return pick(payload);
  const obj = (payload ?? {}) as Record<string, unknown>;
  for (const key of ['data', 'models', 'model_list', 'result']) {
    const v = obj[key];
    if (Array.isArray(v)) return pick(v);
  }
  return [];
}

/** 拼接 /models 探测地址（base_url 末尾斜杠与已含 /models 都兼容） */
export function modelsUrl(baseUrl: string): string {
  const b = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!b) return '';
  return /\/models$/.test(b) ? b : b + '/models';
}

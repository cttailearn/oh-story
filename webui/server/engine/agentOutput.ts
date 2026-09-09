// Agent 产物切分：正文 / 控制块（追踪事务 + 写章三查）
//
// 为什么需要：skills 的写章流程要求「正文直接落盘、事务 JSON 落 .story-txn/、三查 JSON 落 .story-txn/review.json」，
// 三者是分开的产物。WebUI 的 Agent 只有一段文本输出，若不切分就会把 JSON 一起写进手稿
// （违反 skills「正文不得出现自检注释」），或者反过来——像修复前那样用机械填充伪造三查。
// 这里只剥离「能解析成约定形状」的 json 代码块，其余原样保留。
export interface ReviewItemPayload {
  item: string;
  ok?: boolean;
  note?: string;
}

export interface ReviewPayload {
  chapter?: number;
  chapter_name?: string;
  /** 查2：细纲兑现差异（AI 判定，引擎不代填） */
  check2: { items: ReviewItemPayload[] };
  /** 结论（未提供时由引擎按门禁结果推导） */
  conclusion?: string;
}

export interface SplitOutput {
  /** 落盘用的正文（已剔除控制块） */
  body: string;
  /** 追踪事务（skills tracking-transaction 契约） */
  tx: Record<string, unknown> | null;
  /** 写章三查载荷（查2/结论；查1/查3 由引擎用真实状态与门禁结果填） */
  review: ReviewPayload | null;
  /** 被剥离的控制块数量（供 UI 提示） */
  stripped: number;
}

const FENCE = '\u0060\u0060\u0060';

function asTx(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, any>;
  if (o.schema_version === undefined) return null;
  if (o.mode !== 'append' && o.mode !== 'revision') return null;
  if (!Number.isInteger(o.chapter)) return null;
  if (!o.delta || typeof o.delta !== 'object') return null;
  return o as Record<string, unknown>;
}

function asReview(v: unknown): ReviewPayload | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, any>;
  const items = o?.check2?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const norm: ReviewItemPayload[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') return null;
    const item = String((it as any).item ?? '').trim();
    if (!item) return null;
    const okRaw = (it as any).ok;
    norm.push({
      item,
      ok: typeof okRaw === 'boolean' ? okRaw : undefined,
      note: (it as any).note !== undefined ? String((it as any).note) : undefined,
    });
  }
  return {
    chapter: Number.isInteger(o.chapter) ? Number(o.chapter) : undefined,
    chapter_name: o.chapter_name !== undefined ? String(o.chapter_name) : undefined,
    check2: { items: norm },
    conclusion: o.conclusion !== undefined ? String(o.conclusion) : undefined,
  };
}

/** 切分 Agent 输出：剥离 json 控制块，返回正文 + 事务 + 三查载荷 */
export function splitAgentOutput(text: string): SplitOutput {
  const re = new RegExp(FENCE + '(?:json)?\\s*\\n([\\s\\S]*?)\\n' + FENCE, 'g');
  let body = '';
  let cursor = 0;
  let tx: Record<string, unknown> | null = null;
  let review: ReviewPayload | null = null;
  let stripped = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(m[1] ?? '').trim());
    } catch {
      continue;
    }
    const txCandidate = asTx(parsed?.tracking_tx ?? parsed?.trackingTx);
    const reviewCandidate = asReview(parsed?.review ?? parsed?.review_data ?? parsed?.reviewData);
    if (!txCandidate && !reviewCandidate) continue;
    body += text.slice(cursor, m.index);
    cursor = m.index + m[0].length;
    stripped++;
    if (txCandidate && !tx) tx = txCandidate;
    if (reviewCandidate && !review) review = reviewCandidate;
  }
  body += text.slice(cursor);
  return { body: body.replace(/\n{3,}/g, '\n\n').trimEnd(), tx, review, stripped };
}

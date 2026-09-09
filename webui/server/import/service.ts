// 已有小说导入服务（importing-existing.md v0.1 => M4 打磨项）
// 两段式：①确定性分章 + ②离线启发式追踪候选（角色/伏笔/时间线，带置信度+证据行号）
//   + 导入校对（applyImportReview：分章调整/条目取舍/last_committed 认定，fail-closed 解锁 chapter 阶段）
// AI 精修为可选增强（后续接入 story-architect 串行，不阻塞本轮确定性闭环）。
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { dirname, resolve, sep, join } from 'node:path';
import Database from 'better-sqlite3';
type Sqlite = InstanceType<typeof Database>;

export interface ImportedChapter {
  no: number;
  title: string;
  body: string;
  anchor: string;
  confidence: number; // 1.0 锚点分章；<1.0 按空白/长度启发式
}

/** 追踪候选条目（置信度 + 证据行号，importing-existing §2.1） */
export interface ExtractedCandidate {
  name: string; // 角色名 / 伏笔/时间线标题
  summary: string;
  confidence: number; // <0.5 归「待校对」；无证据高置信只建空壳
  evidence: string[]; // ["第3章: 句子片段…"]
}

export interface ImportReview {
  chapters: ImportedChapter[];
  characters: ExtractedCandidate[];
  foreshadow: ExtractedCandidate[];
  timeline: ExtractedCandidate[];
  lowConfidence: number; // 低置信章数（提示分章复核）
  message: string;
}

export function cnToInt(raw: string): number {
  const t = raw.trim().replace(/^第|章$|回$|节$|[\s　]+/g, '');
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const d: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let section = 0;
  const addUnit = (v: number) => { total += (section || 1) * v; section = 0; };
  for (const ch of t) {
    if (d[ch] !== undefined) { section = section * 10 + d[ch]!; continue; }
    if (ch === '万') addUnit(10000);
    else if (ch === '千') addUnit(1000);
    else if (ch === '百') addUnit(100);
    else if (ch === '十') addUnit(10);
  }
  return total + section;
}

const ANCHOR_RE = /^(第[0-9零〇一二两三四五六七八九十百千万]+[章回节篇]|Chapter\s+\d+|CHAPTER\s+\d+(?:[:：.、\s]|$))/;
const VOLUME_RE = /^(第[一二三四五六七八九十百千万]+卷|卷[一二三四五六七八九十百千万]+|[一二三四五六七八九十]+、)/;

/** 分章启发式（importing-existing §2）：优先章回锚；无锚时按均匀 chunk（低置信提示） */
export function splitChapters(text: string): ImportedChapter[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const chapters: ImportedChapter[] = [];
  let cur: { title: string; body: string[]; anchor: string; confidence: number; no?: number } | null = null;
  let anchored = false;
  for (const raw of lines) {
    const ln = raw.trimEnd();
    const m = ln.trim().match(ANCHOR_RE);
    if (m) {
      anchored = true;
      if (cur) chapters.push(done(cur, chapters.length + 1));
      const no = cnToInt(m[1]!);
      cur = { title: ln.trim().slice(0, 40), body: [], anchor: m[1]!, confidence: 1, no: no || chapters.length + 1 };
      continue;
    }
    if (cur) { cur.body.push(ln); continue; }
    // 序言/前言行（首个锚之前）：并入第一章前注释（不单列）
    if (cur === null && !anchored && ln.trim()) (cur = { title: '', body: [], anchor: '', confidence: 1, no: 1 });
  }
  if (cur) chapters.push(done(cur, chapters.length + 1));
  if (anchored) return chapters;

  // 无锚 → 按均匀 ~3000 字 chunk（低置信）
  const CHUNK = 3000;
  const whole = text.replace(/\r?\n/g, '');
  const out: ImportedChapter[] = [];
  if (whole.trim()) {
    for (let i = 0; i < whole.length; i += CHUNK) {
      out.push({ no: out.length + 1, title: '', body: whole.slice(i, i + CHUNK), anchor: '', confidence: 0.5 });
    }
  }
  return out;
}

function done(c: { title: string; body: string[]; anchor: string; confidence: number; no?: number }, index: number): ImportedChapter {
  return { no: c.no ?? index, title: c.title, body: c.body.join('\n').replace(/^\s+|\s+$/g, ''), anchor: c.anchor, confidence: c.confidence };
}

// ---------------- 离线启发式候选提取（确定性，可单测） ----------------

const CHAR_STOP = new Set([
  '一个', '一位', '一点', '一些', '我们', '你们', '他们', '她们', '它们', '自己', '大家',
  '这时', '那时', '那里', '这里', '什么', '这么', '那么', '这个', '那个', '这些', '那些',
  '时候', '知道', '觉得', '现在', '然后', '突然', '仿佛', '似乎', '好像', '不要', '不是',
  '就是', '还是', '还有', '已经', '正在', '开始', '直到', '终于', '如果', '因为', '所以',
  '但是', '可是', '只是', '只有', '没有', '起来', '下来', '过去', '进来', '出去', '回来',
  '看着', '听到', '想到', '走到', '来到', '离开', '回到', '进入', '发现', '看到', '看见',
  '声音', '世界', '东西', '事情', '问题', '地方', '方式', '方法', '结果', '原因', '表现',
  '属于', '能够', '需要', '必须', '可以', '应该', '以后', '之前', '之后', '其中', '因此',
  '于是', '接着', '然后', '最后', '最终', '瞬间', '片刻', '此刻', '脸色', '眼中', '心里',
  '目光', '眼神', '脸上', '嘴角', '声音', '语气', '神情', '系统', '任务', '能力', '属性',
  '技能', '等级', '能量', '力量', '功法', '境界', '修为', '少年', '青年', '男子', '女子',
  '老妇', '老者', '敌人', '对手', '伙伴', '同伴', '兄弟', '父亲', '母亲', '哥哥', '妹妹',
  '姐姐', '弟弟', '师傅', '师父', '徒弟', '掌门', '长老',
]);

/** 从整篇文本提取主要角色候选（2-4 字 CJK 高频连续片段，过滤常见词） */
export function extractCharacters(text: string): ExtractedCandidate[] {
  const freq = new Map<string, number>();
  const firstSeen = new Map<string, { chapter: number; snippet: string }>();
  const chapters = splitChapters(text);
  let curChapter = 1;
  for (let ci = 0; ci < chapters.length; ci++) {
    const ch = chapters[ci]!;
    curChapter = ch.no || ci + 1;
    const cjkRuns = ch.body.split(/[^\u3400-\u9fff\uf900-\ufaff]+/).filter(Boolean);
    for (const run of cjkRuns) {
      if (run.length < 2 || run.length > 5) continue;
      for (let i = 0; i + 2 <= run.length; i++) {
        // 枚举 2-4 字滑动窗口（每 run 内）
        const maxLen = Math.min(2 + (i === 0 ? 2 : 0), 4);
        for (let len = 2; len <= maxLen; len++) {
          if (run.length < i + len) break;
          const tok = run.slice(i, i + len);
          if (CHAR_STOP.has(tok)) continue;
          const n = (freq.get(tok) ?? 0) + 1;
          freq.set(tok, n);
          if (!firstSeen.has(tok)) {
            firstSeen.set(tok, { chapter: curChapter, snippet: snippetAround(run, i, len) });
          }
        }
      }
    }
  }
  // 过滤：至少出现 3 次；剔除被更长同频片段包含的
  const cands: Array<{ name: string; hits: number; chapter: number; snippet: string }> = [];
  const sorted = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  for (const [tok, n] of sorted) {
    const dominated = cands.some((c) => c.name.length > tok.length && c.name.includes(tok) && n <= c.hits);
    if (dominated) continue;
    const fs = firstSeen.get(tok)!;
    cands.push({ name: tok, hits: n, chapter: fs.chapter, snippet: fs.snippet });
  }
  return cands
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 14)
    .map((c) => ({
      name: c.name,
      summary: '',
      confidence: Math.min(0.85, Math.round((0.35 + 0.05 * Math.min(c.hits, 10)) * 100) / 100),
      evidence: ['第' + c.chapter + '章: ' + c.snippet],
    }));
}

function snippetAround(run: string, i: number, len: number): string {
  const start = Math.max(0, i - 8);
  const end = Math.min(run.length, i + len + 8);
  return '…' + run.slice(start, end) + '…';
}

const FORESHADOW_RE = /(埋下|伏笔|暗示|预兆|不详|不对劲|线索|暗流|隐患|遗留|种子|预示|征兆|蹊跷|端倪)/;
const TIMELINE_RE = /(第[0-9零〇一二三四五六七八九十百千万]+[天周年月]|翌日|次日|第二天|[一二三四五六七八九十百][天周年月](后|前)|半?年(后|前)|之后|随后|紧接着)/;

function sentenceSplit(body: string): string[] {
  return body
    .replace(/\r?\n/g, '')
    .split(/(?<=[。！？!?」』])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
}

/** 伏笔种子（高置信句式）与时间线候选（明确时间标记） */
export function extractSignals(text: string): { foreshadow: ExtractedCandidate[]; timeline: ExtractedCandidate[] } {
  const chapters = splitChapters(text);
  const foreshadow: ExtractedCandidate[] = [];
  const timeline: ExtractedCandidate[] = [];
  let fid = 1;
  let eid = 1;
  for (const ch of chapters) {
    for (const s of sentenceSplit(ch.body)) {
      const clip = s.slice(0, 60);
      if (FORESHADOW_RE.test(s)) {
        foreshadow.push({ name: 'F' + String(fid++).padStart(3, '0'), summary: clip, confidence: 0.5, evidence: ['第' + ch.no + '章'] });
      }
      if (TIMELINE_RE.test(s)) {
        const m = s.match(TIMELINE_RE);
        timeline.push({
          name: 'E' + String(eid++).padStart(3, '0'),
          summary: clip,
          confidence: m && /之后|随后|紧接着/.test(m[0] ?? '') ? 0.4 : 0.6,
          evidence: ['第' + ch.no + '章: ' + (m?.[0] ?? '')],
        });
      }
    }
  }
  // 截断上限，避免大书候选爆炸（保留前 24 条）
  return {
    foreshadow: foreshadow.slice(0, 24),
    timeline: timeline.slice(0, 24),
  };
}

export function firstSentence(body: string): string {
  const s = (body ?? '').replace(/[#>*]\s*/g, '').trim().split(/[。！？.!?\n]/)[0] ?? '';
  return (s || '（无摘要）').slice(0, 80);
}

/** 确定性追踪状态（schema_version 4 对齐；候选条目全部带 置信度+证据） */
export function buildTrackingState(bookTitle: string, chapters: ImportedChapter[]): Record<string, unknown> {
  const last = chapters.reduce((mx, c) => Math.max(mx, c.no), 0);
  const recent = chapters.slice(-3).map((c) => ({ chapter: c.no, summary: firstSentence(c.body), confidence: 0.7 }));
  const text = chapters.map((c) => '第' + c.no + '章\n' + c.body).join('\n\n');
  const { foreshadow, timeline } = extractSignals(text);
  const chars = extractCharacters(text);
  const characters: Record<string, { state: string; confidence: number; evidence: string[] }> = {};
  for (const c of chars) {
    characters[c.name] = { state: '导入初稿（待校对）', confidence: c.confidence, evidence: c.evidence };
  }
  const foreshadowMap: Record<string, { summary: string; confidence: number; evidence: string[] }> = {};
  for (const f of foreshadow) foreshadowMap[f.name] = { summary: f.summary, confidence: f.confidence, evidence: f.evidence };
  const timelineMap: Record<string, { objective_fact: string; confidence: number; reveal_status: string; evidence: string[] }> = {};
  for (const t of timeline) timelineMap[t.name] = { objective_fact: t.summary, confidence: t.confidence, reveal_status: '候选事件', evidence: t.evidence };

  return {
    schema_version: 4,
    book_title: bookTitle,
    last_committed_chapter: last,
    imported_through_chapter: last,
    state_revision: 0,
    context: {
      position: { volume: '卷一', volume_start_chapter: 1, story_time: '', scene: '' },
      long_term_constraints: [],
      active_character_names: Object.keys(characters),
      continuity_risks: [],
      recent_chapters: recent,
      next_chapter_commitments: [],
    },
    characters,
    foreshadow: foreshadowMap,
    timeline: timelineMap,
    arcs: {},
  };
}

export interface ImportRequest {
  name: string;
  mode: 'text-file' | 'clipboard' | 'dir';
  path?: string;
  text?: string;
  dir?: string; // 相对工作区的保存目录（新建向导/导入时选择）
}

export interface ImportResult {
  book: { id: string; name: string; dir: string; kind: string; pipeline: string } | null;
  review: ImportReview | null;
  duplicate: boolean;
}

/** 执行导入；边界：重复名不覆盖、>2MB 拒绝、事务化（临时目录→rename）。 */
export async function importNovel(
  db: Sqlite,
  workspace: string,
  req: ImportRequest,
): Promise<ImportResult> {
  const name = (req.name ?? '').trim();
  if (!name) throw Object.assign(new Error('缺少 name（书名）'), { code: 'INVALID_INPUT' });

  const relDir = (req.dir ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const dupDir = !relDir || req.mode === 'dir' ? join(workspace, name) : resolveUnder(workspace, relDir);
  const dup = db.prepare('SELECT * FROM books WHERE dir = ?').get(dupDir);
  if (dup) return { book: { id: (dup as any).id, name, dir: dupDir, kind: (dup as any).kind, pipeline: 'long' }, review: null, duplicate: true };

  if (req.mode === 'dir') {
    if (!req.path || !existsSync(req.path)) throw Object.assign(new Error('目录不存在：' + req.path), { code: 'NOT_FOUND' });
    const id = bookId();
    db.prepare("INSERT INTO books (id, name, dir, kind, pipeline_id, pipeline_version, theme_color, active_stage, meta_json, created_at, updated_at) VALUES (?,?,?,'novel','long',1,NULL,'chapter',?,?,?)")
      .run(id, name, req.path, JSON.stringify({ imported: true, import_reviewed: true }), new Date().toISOString(), new Date().toISOString());
    return { book: { id, name, dir: req.path, kind: 'novel', pipeline: 'long' }, review: null, duplicate: false };
  }

  const rawText = req.mode === 'text-file' && req.path ? readFileSafe(req.path) : (req.text ?? '');
  if (!rawText.trim()) throw Object.assign(new Error('空文本无法导入'), { code: 'INVALID_INPUT' });
  if (rawText.length > 2 * 1024 * 1024) throw Object.assign(new Error('文件超过 2MB，请拆分后再导入'), { code: 'INVALID_INPUT' });

  const chapters = splitChapters(rawText);
  if (chapters.length === 0) throw Object.assign(new Error('未识别到任何章节'), { code: 'INVALID_INPUT' });
  const tracking = buildTrackingState(name, chapters);
  const lowConf = chapters.filter((c) => c.confidence < 1).length;
  const chars = Object.keys((tracking.characters as Record<string, unknown>) ?? {});
  const fore = Object.keys((tracking.foreshadow as Record<string, unknown>) ?? {});
  const tl = Object.keys((tracking.timeline as Record<string, unknown>) ?? {});

  const tmp = join(workspace, '.story-import-' + Date.now().toString(36));
  writeBookTree(tmp, chapters, tracking);
  try {
    mkdirSync(dirname(dupDir), { recursive: true });
    renameSync(tmp, dupDir);
  } catch (e: any) {
    rmSync(tmp, { recursive: true, force: true });
    throw Object.assign(new Error('建目录失败：' + String(e?.message ?? e)), { code: 'INTERNAL' });
  }

  const id = bookId();
  db.prepare("INSERT INTO books (id, name, dir, kind, pipeline_id, pipeline_version, theme_color, active_stage, meta_json, created_at, updated_at) VALUES (?,?,?,'novel','long',1,NULL,'chapter',?,?,?)")
    .run(id, name, dupDir, JSON.stringify({ imported: true, import_reviewed: false, chapters: chapters.length }), new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)")
    .run(new Date().toISOString(), 'system', 'import', 'book:' + id, JSON.stringify({ name, chapters: chapters.length, lowConfidence: lowConf, characters: chars.length, foreshadow: fore.length, timeline: tl.length }));

  return {
    book: { id, name, dir: dupDir, kind: 'novel', pipeline: 'long' },
    review: {
      chapters,
      characters: chars.map((n) => ({ name: n, summary: '', confidence: (tracking.characters as any)[n].confidence, evidence: (tracking.characters as any)[n].evidence })),
      foreshadow: fore.map((n) => ({ name: n, summary: (tracking.foreshadow as any)[n].summary, confidence: (tracking.foreshadow as any)[n].confidence, evidence: (tracking.foreshadow as any)[n].evidence })),
      timeline: tl.map((n) => ({ name: n, summary: (tracking.timeline as any)[n].objective_fact, confidence: (tracking.timeline as any)[n].confidence, evidence: (tracking.timeline as any)[n].evidence })),
      lowConfidence: lowConf,
      message:
        '已识别 ' + chapters.length + ' 章' +
        (lowConf ? '；' + lowConf + ' 章低置信（核对分章）' : '') +
        '；角色候选 ' + chars.length + ' / 伏笔 ' + fore.length + ' / 时间线 ' + tl.length +
        '（置信度 <0.5 归待校对）。校对后即可续写。',
    },
    duplicate: false,
  };
}

/** 落标准书结构到目标目录（正文/、追踪/、设定/） */
function writeBookTree(dir: string, chapters: ImportedChapter[], tracking: Record<string, unknown>): void {
  mkdirSync(join(dir, '正文'), { recursive: true });
  mkdirSync(join(dir, '追踪'), { recursive: true });
  mkdirSync(join(dir, '设定'), { recursive: true });
  for (const ch of chapters) {
    const fn = '第' + String(ch.no).padStart(3, '0') + '章' + (ch.title ? '_' + safeTitle(ch.title) : '') + '.md';
    writeFileSync(join(dir, '正文', fn), '# 第' + ch.no + '章\n\n' + ch.body + '\n', 'utf8');
  }
  writeFileSync(join(dir, '追踪', '_tracking-state.json'), JSON.stringify(tracking, null, 2) + '\n', 'utf8');
  writeFileSync(join(dir, '设定', '题材定位.md'), '# 题材定位\n> 由导入生成（确定性），AI 精修为可选增强\n', 'utf8');
}

// ---------------- 导入校对（importing-existing §3 / §4） ----------------

export interface ChapterEdit {
  no: number;        // 以当前章号引用
  title?: string;    // 改名
  drop?: boolean;    // 误切章 → 删除
  mergeInto?: number; // 合并到目标章（按当前章号，目标保留）
  splitAt?: number;  // 正文字符偏移处切分 → 后半段另开新章
}

export interface ReviewApply {
  chapters?: ChapterEdit[];
  characters?: { name: string; action: 'keep' | 'drop'; note?: string }[];
  foreshadow?: { id: string; action: 'keep' | 'drop' }[];
  timeline?: { id: string; action: 'keep' | 'drop' }[];
  last_committed_chapter?: number; // 认定后推进到 chapter 阶段（fail-closed：未认定不解锁）
}

export interface ApplyResult {
  chapters: Array<{ no: number; title: string }>;
  last_committed_chapter?: number;
  reviewed: boolean;
  dropped_characters: string[];
  dropped_foreshadow: string[];
  dropped_timeline: string[];
}

/** 导入书是否待校对（锁定 chapter 阶段，fail-closed） */
export function importReviewPending(bookDir: string, meta: Record<string, unknown> | null): boolean {
  if (!meta || meta.imported !== true) return false;
  if (meta.import_reviewed === true) return false;
  // 追踪文件不存在视为可续写（常见于纯目录挂载），不拦截
  if (!existsSync(join(bookDir, '追踪', '_tracking-state.json'))) return false;
  return true;
}

/**
 * 应用导入校对决策：
 *  - 分章调整（改名/删除/合并/切分）→ 重写 正文/ 并按序重编号（第001章_标题.md）
 *  - 条目取舍（角色/伏笔/时间线）→ 更新 _tracking-state.json
 *  - last_committed_chapter 认定 → meta.import_reviewed=true（解锁 chapter）
 * 全部落临时目录→rename 原子提交；失败清理。
 */
export function applyImportReview(
  db: Sqlite,
  book: { id: string; dir: string; name: string },
  apply: ReviewApply,
): ApplyResult {
  const bookDir = book.dir;
  const srcDir = join(bookDir, '正文');
  if (!existsSync(srcDir)) throw Object.assign(new Error('无 正文/ 目录'), { code: 'NOT_FOUND' });

  // 1) 读取现有章（文件真相）
  interface Rec { no: number; title: string; body: string; file: string }
  interface MutableRec extends Rec { drop?: boolean; mergeInto?: number; splitAt?: number }
  const recs = new Map<number, MutableRec>();
  let seq = 0;
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort();
  for (const f of files) {
    const m = f.match(/^第(\d+)章/);
    if (!m) continue;
    const raw = readFileSync(join(srcDir, f), 'utf8').replace(/^\uFEFF/, '');
    const lines = raw.split(/\r?\n/);
    let title = lines[0]?.replace(/^#\s*/, '') ?? '';
    const body = lines.slice(1).join('\n').replace(/^\s+|\s+$/g, '');
    const no = parseInt(m[1]!, 10) || ++seq;
    if (!title) title = '第' + no + '章';
    recs.set(no, { no, title, body, file: f });
  }
  if (recs.size === 0) throw Object.assign(new Error('正文目录为空，无法校对'), { code: 'INVALID_INPUT' });

  // 2) 应用编辑（按原始章号引用；对当前 Map 做原地修改）
  for (const e of apply.chapters ?? []) {
    const rec = recs.get(e.no);
    if (!rec) continue;
    if (e.drop) { rec.drop = true; continue; }
    if (e.title && e.title.trim()) rec.title = e.title.trim();
    if (e.mergeInto != null && recs.has(e.mergeInto) && e.mergeInto !== e.no) rec.mergeInto = e.mergeInto;
    if (e.splitAt != null && e.splitAt > 0 && e.splitAt < rec.body.length) rec.splitAt = e.splitAt;
  }
  // 合并：按 mergeInto 追加 body 后删除来源
  for (const rec of [...recs.values()]) {
    if (rec.mergeInto != null) {
      const target = recs.get(rec.mergeInto);
      if (target) target.body = target.body + '\n\n' + rec.body;
      rec.drop = true;
    }
  }
  // 切分：在 splitAt 处切出新章（追加到文档尾部，编号后续重排）
  const extra: MutableRec[] = [];
  for (const rec of [...recs.values()]) {
    if (rec.splitAt != null && !rec.drop) {
      const head = rec.body.slice(0, rec.splitAt).trim();
      const tail = rec.body.slice(rec.splitAt).trim();
      rec.body = head;
      if (tail) extra.push({ no: 0, title: (rec.title || '第' + rec.no + '章') + '（续）', body: tail, file: '', drop: false });
    }
  }

  // 3) 重编号 1..N 并写临时目录
  const ordered = [...recs.values()].filter((r) => !r.drop).concat(extra);
  const list = ordered.map((r, i) => ({ ...r, no: i + 1 }));
  const tmp = join(bookDir, '..', '.review-' + Date.now().toString(36));
  mkdirSync(join(tmp, '正文'), { recursive: true });
  const finalRecs: Array<{ no: number; title: string; body: string }> = [];
  const trackTmp = join(tmp, '追踪');
  const tmpTrackSrc = join(bookDir, '追踪');
  if (existsSync(tmpTrackSrc)) copyDirPreserving(tmpTrackSrc, trackTmp);

  for (const rec of list) {
    const title = rec.title.replace(/^第\s*\d+\s*章\s*/, '').replace(/_/g, ' ').trim() || ('第' + rec.no + '章');
    const fn = '第' + String(rec.no).padStart(3, '0') + '章_' + safeTitle(title) + '.md';
    writeFileSync(join(tmp, '正文', fn), '# 第' + rec.no + '章\n\n' + rec.body.replace(/^\s+|\s+$/g, '') + '\n', 'utf8');
    finalRecs.push({ no: rec.no, title, body: rec.body });
  }

  // 4) 更新追踪状态：条目取舍 + last_committed
  const trackPath = join(bookDir, '追踪', '_tracking-state.json');
  const state: Record<string, any> = existsSync(trackPath)
    ? JSON.parse(readFileSync(trackPath, 'utf8'))
    : { schema_version: 4, book_title: book.name, last_committed_chapter: 0, imported_through_chapter: 0, state_revision: 0, characters: {}, foreshadow: {}, timeline: {}, arcs: {}, context: { recent_chapters: [] } };
  const droppedCharacters: string[] = [];
  const droppedForeshadow: string[] = [];
  const droppedTimeline: string[] = [];
  const chars = (state.characters ?? {}) as Record<string, any>;
  for (const c of apply.characters ?? []) {
    if (c.action === 'drop') {
      if (chars[c.name]) { delete chars[c.name]; droppedCharacters.push(c.name); }
    } else if (chars[c.name] && c.note) {
      chars[c.name].state = c.note;
    }
  }
  const fore = (state.foreshadow ?? {}) as Record<string, any>;
  for (const f of apply.foreshadow ?? []) {
    if (f.action === 'drop' && fore[f.id]) { delete fore[f.id]; droppedForeshadow.push(f.id); }
  }
  const tl = (state.timeline ?? {}) as Record<string, any>;
  for (const t of apply.timeline ?? []) {
    if (t.action === 'drop' && tl[t.id]) { delete tl[t.id]; droppedTimeline.push(t.id); }
  }

  const last = apply.last_committed_chapter != null ? apply.last_committed_chapter : finalRecs.length;
  state.last_committed_chapter = Math.min(last, finalRecs.length);
  state.imported_through_chapter = finalRecs.length;
  state.state_revision = (state.state_revision ?? 0) + 1;
  if (state.context) (state.context as any).active_character_names = Object.keys(chars);
  writeFileSync(join(trackTmp, '_tracking-state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');

  // 非正文目录复制（设定/大纲/…）
  for (const sub of readdirSync(bookDir, { withFileTypes: true })) {
    if (sub.name === '正文' || sub.name === '追踪' || sub.name.startsWith('.') || sub.name === '交付') continue;
    copyDirPreserving(join(bookDir, sub.name), join(tmp, sub.name));
  }

  // 5) 原子提交
  const backup = join(bookDir, '..', '.review-bak-' + Date.now().toString(36));
  try {
    renameSync(bookDir, backup);
    try {
      renameSync(tmp, bookDir);
    } catch (e) {
      renameSync(backup, bookDir);
      throw e;
    }
    rmSync(backup, { recursive: true, force: true });
  } catch (e: any) {
    rmSync(tmp, { recursive: true, force: true });
    if (existsSync(backup) && !existsSync(bookDir)) renameSync(backup, bookDir);
    throw Object.assign(new Error('校对提交失败：' + String(e?.message ?? e)), { code: 'INTERNAL' });
  }

  // 6) 库状态：meta.import_reviewed 解锁 + audit
  const row = db.prepare('SELECT meta_json FROM books WHERE id=?').get(book.id) as { meta_json: string } | undefined;
  let meta: Record<string, any> = {};
  if (row?.meta_json) { try { meta = JSON.parse(row.meta_json); } catch { /* noop */ } }
  meta.import_reviewed = true;
  meta.chapters = finalRecs.length;
  db.prepare('UPDATE books SET meta_json=?, active_stage=\'chapter\', updated_at=? WHERE id=?')
    .run(JSON.stringify(meta), new Date().toISOString(), book.id);
  db.prepare('INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), 'user', 'import-review', 'book:' + book.id, JSON.stringify({
      chapters: finalRecs.length,
      renamed: finalRecs.map((r) => '第' + r.no + '章 ' + r.title).slice(0, 5),
      dropped: { characters: droppedCharacters, foreshadow: droppedForeshadow, timeline: droppedTimeline },
      last_committed_chapter: state.last_committed_chapter,
    }));

  return {
    chapters: finalRecs,
    last_committed_chapter: state.last_committed_chapter,
    reviewed: true,
    dropped_characters: droppedCharacters,
    dropped_foreshadow: droppedForeshadow,
    dropped_timeline: droppedTimeline,
  };
}

/** 递归复制目录（跳过 . 开头） */
function copyDirPreserving(src: string, dst: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const d of readdirSync(src, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const s = join(src, d.name);
    if (d.isDirectory()) copyDirPreserving(s, join(dst, d.name));
    else writeFileSync(join(dst, d.name), readFileSync(s));
  }
}

function safeTitle(t: string): string {
  return t.replace(ANCHOR_RE, '').replace(/[\\\/:*?"<>|\r\n]+/g, '').slice(0, 28) || '章';
}
function readFileSafe(p: string): string {
  try { return readFileSync(p, 'utf8'); } catch (e) { throw Object.assign(new Error('读文件失败：' + String((e as Error).message)), { code: 'NOT_FOUND' }); }
}

/** 校验并解析工作区内相对保存目录（拒绝绝对路径 / 越界） */
function resolveUnder(root: string, rel: string): string {
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) {
    throw Object.assign(new Error('目录需为工作区内相对路径'), { code: 'INVALID_INPUT' });
  }
  const parts = rel.split('/').filter((x) => x !== '' && x !== '.');
  if (parts.includes('..')) {
    throw Object.assign(new Error('目录不能包含 ..'), { code: 'INVALID_INPUT' });
  }
  const abs = join(root, ...parts);
  const ws = resolve(root);
  if (abs !== ws && !abs.startsWith(ws + sep)) {
    throw Object.assign(new Error('目录越界'), { code: 'INVALID_INPUT' });
  }
  return abs;
}
function bookId(): string {
  return 'nb_' + Date.now().toString(36).padStart(10, '0') + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}
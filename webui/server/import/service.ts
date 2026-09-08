// 已有小说导入服务（importing-existing.md）：两段式（确定性分章+追踪生成，AI 精修为 M4 可选增强）
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
type Sqlite = InstanceType<typeof Database>;

export interface ImportedChapter {
  no: number;
  title: string;
  body: string;
  anchor: string;
  confidence: number; // 1.0 锚点分章；<1.0 按空白/长度启发式
}

export interface ImportReview {
  chapters: ImportedChapter[];
  characters: number;
  foreshadow: number;
  timeline: number;
  lowConfidence: number;
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

/** 确定性追踪状态（schema_version 4 对齐；角色/伏笔/时间线留空壳，AI 精修 M4） */
export function buildTrackingState(bookTitle: string, chapters: ImportedChapter[]): Record<string, unknown> {
  const last = chapters.reduce((mx, c) => Math.max(mx, c.no), 0);
  const recent = chapters.slice(-3).map((c) => ({ chapter: c.no, summary: firstSentence(c.body) }));
  return {
    schema_version: 4,
    book_title: bookTitle,
    last_committed_chapter: last,
    imported_through_chapter: last,
    state_revision: 0,
    context: {
      position: { volume: '卷一', volume_start_chapter: 1, story_time: '', scene: '' },
      long_term_constraints: [],
      active_character_names: [],
      continuity_risks: [],
      recent_chapters: recent,
      next_chapter_commitments: [],
    },
    characters: {},
    foreshadow: {},
    timeline: {},
    arcs: {},
    imported: { confidence_hint: true },
  };
}

function firstSentence(body: string): string {
  const s = body.replace(/[#>*]\s*/g, '').trim().split(/[。！？.!?\n]/)[0] ?? '';
  return (s || '（无摘要）').slice(0, 80);
}

export interface ImportRequest {
  name: string;
  mode: 'text-file' | 'clipboard' | 'dir';
  path?: string;
  text?: string;
}

export interface ImportResult {
  book: { id: string; name: string; dir: string; kind: string; pipeline: string } | null;
  review: ImportReview | null;
  duplicate: boolean;
}

/** 执行导入；边界：重复名不覆盖、>2MB 拒绝、事务化（临时目录→rename） */
export async function importNovel(
  db: Sqlite,
  workspace: string,
  req: ImportRequest,
): Promise<ImportResult> {
  const name = (req.name ?? '').trim();
  if (!name) throw Object.assign(new Error('缺少 name（书名）'), { code: 'INVALID_INPUT' });

  const dupDir = join(workspace, name);
  const dup = db.prepare('SELECT * FROM books WHERE dir = ?').get(dupDir);
  if (dup) return { book: { id: (dup as any).id, name, dir: dupDir, kind: (dup as any).kind, pipeline: 'long' }, review: null, duplicate: true };

  if (req.mode === 'dir') {
    if (!req.path || !existsSync(req.path)) throw Object.assign(new Error('目录不存在：' + req.path), { code: 'NOT_FOUND' });
    const id = bookId();
    db.prepare("INSERT INTO books (id, name, dir, kind, pipeline_id, pipeline_version, theme_color, active_stage, meta_json, created_at, updated_at) VALUES (?,?,?,'novel','long',1,NULL,'chapter',?,?,?)")
      .run(id, name, req.path, JSON.stringify({ imported: true }), new Date().toISOString(), new Date().toISOString());
    return { book: { id, name, dir: req.path, kind: 'novel', pipeline: 'long' }, review: null, duplicate: false };
  }

  const rawText = req.mode === 'text-file' && req.path ? readFileSafe(req.path) : (req.text ?? '');
  if (!rawText.trim()) throw Object.assign(new Error('空文本无法导入'), { code: 'INVALID_INPUT' });
  if (rawText.length > 2 * 1024 * 1024) throw Object.assign(new Error('文件超过 2MB，请拆分后再导入'), { code: 'INVALID_INPUT' });

  const chapters = splitChapters(rawText);
  if (chapters.length === 0) throw Object.assign(new Error('未识别到任何章节'), { code: 'INVALID_INPUT' });
  const tracking = buildTrackingState(name, chapters);
  const lowConf = chapters.filter((c) => c.confidence < 1).length;

  const tmp = join(workspace, '.story-import-' + Date.now().toString(36));
  mkdirSync(join(tmp, '正文'), { recursive: true });
  mkdirSync(join(tmp, '追踪'), { recursive: true });
  mkdirSync(join(tmp, '设定'), { recursive: true });
  for (const ch of chapters) {
    const fn = '第' + String(ch.no).padStart(3, '0') + '章' + (ch.title ? '_' + safeTitle(ch.title) : '') + '.md';
    writeFileSync(join(tmp, '正文', fn), '# 第' + ch.no + '章\n\n' + ch.body + '\n', 'utf8');
  }
  writeFileSync(join(tmp, '追踪', '_tracking-state.json'), JSON.stringify(tracking, null, 2) + '\n', 'utf8');
  writeFileSync(join(tmp, '设定', '题材定位.md'), '# 题材定位\n> 由导入生成（确定性），AI 精修见 M4\n', 'utf8');
  try {
    renameSync(tmp, dupDir);
  } catch (e: any) {
    rmSync(tmp, { recursive: true, force: true });
    throw Object.assign(new Error('建目录失败：' + String(e?.message ?? e)), { code: 'INTERNAL' });
  }

  const id = bookId();
  db.prepare("INSERT INTO books (id, name, dir, kind, pipeline_id, pipeline_version, theme_color, active_stage, meta_json, created_at, updated_at) VALUES (?,?,?,'novel','long',1,NULL,'chapter',?,?,?)")
    .run(id, name, dupDir, JSON.stringify({ imported: true, chapters: chapters.length }), new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)")
    .run(new Date().toISOString(), 'system', 'import', 'book:' + id, JSON.stringify({ name, chapters: chapters.length, lowConfidence: lowConf }));

  return {
    book: { id, name, dir: dupDir, kind: 'novel', pipeline: 'long' },
    review: {
      chapters,
      characters: 0,
      foreshadow: 0,
      timeline: 0,
      lowConfidence: lowConf,
      message: '已识别 ' + chapters.length + ' 章' + (lowConf ? '；' + lowConf + ' 章为低置信（建议在导入校对页复核分章）' : '') + '；追踪状态已生成（纯确定性，AI 精修为 M4）。',
    },
    duplicate: false,
  };
}

function safeTitle(t: string): string {
  return t.replace(ANCHOR_RE, '').replace(/[\\/:*?"<>|\r\n]+/g, '').slice(0, 28) || '章';
}
function readFileSafe(p: string): string {
  try { return readFileSync(p, 'utf8'); } catch (e) { throw Object.assign(new Error('读文件失败：' + String((e as Error).message)), { code: 'NOT_FOUND' }); }
}
function bookId(): string {
  return 'nb_' + Date.now().toString(36).padStart(10, '0') + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

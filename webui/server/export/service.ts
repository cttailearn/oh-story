// 交付导出服务（export-publish.md / api-contract §3.9）
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
type Sqlite = InstanceType<typeof Database>;

export interface ChapterDoc { no: number; title: string; body: string; chars: number }

const PUNCT = new Set(['，', '。', '！', '？', '；', '：', '“', '”', '‘', '’', '（', '）', '、', '…', '—', ',', '.', '!', '?', ';', ':', '"', "'", '(', ')']);

export function rawChars(text: string): number {
  return Array.from(text.replace(/\s+/g, '')).length;
}
export function cleanChars(text: string): number {
  return Array.from(text.replace(/\s+/g, '')).filter((c) => !PUNCT.has(c)).length;
}

/** 读取 正文/ 章节（按 第N章 数字排序） */
export function collectChapters(bookDir: string): ChapterDoc[] {
  const dir = join(bookDir, '正文');
  if (!existsSync(dir)) return [];
  const out: ChapterDoc[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const m = f.match(/^第(\d+)章/);
    if (!m) continue;
    const text = readFileSync(join(dir, f), 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    const body = lines.slice(1).join('\n').replace(/^\s+|\s+$/g, '');
    out.push({ no: parseInt(m[1] ?? '0', 10), title: f.replace(/\.md$/, ''), body, chars: cleanChars(body) });
  }
  out.sort((a, b) => a.no - b.no);
  return out;
}

/** 发布前检查（export-publish §5）：编号连续(blocking) + 章节非空(blocking) */
export function verifyDelivery(chapters: ChapterDoc[]): { ok: boolean; blocking: string[]; warnings: string[] } {
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (chapters.length === 0) return { ok: false, blocking: ['无已写章节'], warnings };
  const nos = chapters.map((c) => c.no);
  const lo = nos[0]!;
  const hi = nos[nos.length - 1]!;
  const missing: number[] = [];
  for (let i = lo; i <= hi; i++) if (!nos.includes(i)) missing.push(i);
  if (missing.length) blocking.push('章节编号不连续：缺 ' + missing.join(',') + ' 章（拒导，先补章）');
  const empty = chapters.filter((c) => c.chars === 0);
  if (empty.length) blocking.push('空白正文 ' + empty.length + ' 章：' + empty.map((c) => '第' + c.no + '章').join(',') + '（delivery-contract fail-closed）');
  return { ok: blocking.length === 0, blocking, warnings };
}

function titleOf(c: ChapterDoc): string {
  const t = c.title.replace(/^第\d+章\s*_?\s*/, '').replace(/_/g, ' ').trim();
  return t || ('第' + c.no + '章');
}

/** 清洗 markdown 语法（export-publish §2 平台清洗管线） */
function stripMarkdown(body: string): string {
  return body
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/[\*_`~]/g, '')
    .replace(/[\[\]]/g, '')
    .replace(/>+\s?/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n\r?\n+/).map((p) => p.trim()).filter(Boolean).join('\n\n');
}

export function formatMarkdown(chapters: ChapterDoc[], includeOutline: boolean, outlineText: string): string {
  const out: string[] = [];
  if (includeOutline && outlineText.trim()) {
    out.push('# 大纲（附）');
    out.push('');
    out.push(outlineText.trim());
    out.push('');
  }
  for (const c of chapters) {
    out.push('# ' + titleOf(c));
    out.push('');
    out.push(c.body);
    out.push('');
  }
  return out.join('\n') + '\n';
}

const PLATFORMS: Record<string, { heading: (c: ChapterDoc) => string; indent: boolean }> = {
  qidian: { heading: (c) => '第' + c.no + '章', indent: false },
  fanqie: { heading: (c) => '第' + c.no + '章 ' + titleOf(c), indent: false },
  jj: { heading: (c) => '第' + c.no + '章', indent: true },
  yanyan: { heading: (c) => titleOf(c), indent: false },
};

export function formatTxt(chapters: ChapterDoc[], platform: string): string {
  const p = PLATFORMS[platform] ?? PLATFORMS.fanqie!;
  const out: string[] = [];
  for (const c of chapters) {
    out.push(p.heading(c));
    out.push('');
    for (const para of stripMarkdown(c.body).split('\n\n')) out.push((p.indent ? '　　' : '') + para);
    out.push('');
  }
  return out.join('\n') + '\n';
}

export interface ExportRequest {
  format?: 'markdown' | 'txt';
  platform?: string;
  include?: string[];
  images?: boolean;
}

export interface ExportStats {
  chapters: number; chars_raw: number; chars_clean: number; avg_chars: number; blocked?: string[]; warnings?: string[];
}

export function exportBook(
  db: Sqlite,
  book: { id: string; name: string; dir: string },
  req: ExportRequest,
): { ok: boolean; name: string; relPath: string; format: string; stats: ExportStats } {
  const format = req.format === 'txt' ? 'txt' : 'markdown';
  const chapters = collectChapters(book.dir);
  const check = verifyDelivery(chapters);
  if (!check.ok) {
    return { ok: false, name: '', relPath: '', format, stats: { chapters: chapters.length, chars_raw: 0, chars_clean: 0, avg_chars: 0, blocked: check.blocking, warnings: check.warnings } };
  }

  const outlinePath = join(book.dir, '大纲', '大纲.md');
  const outlineText = existsSync(outlinePath) ? readFileSync(outlinePath, 'utf8') : '';
  const includeOutline = Array.isArray(req.include) ? req.include.includes('outline') : true;

  let fileName: string;
  let content: string;
  if (format === 'txt') {
    const platform = req.platform ?? 'fanqie';
    fileName = book.name + '_' + platform + '.txt';
    content = formatTxt(chapters, platform);
  } else {
    fileName = book.name + '.md';
    content = formatMarkdown(chapters, includeOutline, outlineText);
  }

  const rel = '交付/' + fileName;
  const abs = join(book.dir, rel);
  mkdirSync(join(book.dir, '交付'), { recursive: true });
  writeFileSync(abs, content, 'utf8');

  const charsRaw = rawChars(content);
  const charsClean = cleanChars(content);
  db.prepare("INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)")
    .run(new Date().toISOString(), 'user', 'export', 'book:' + book.id, JSON.stringify({ format, name: fileName, chapters: chapters.length, chars_clean: charsClean }));

  return {
    ok: true,
    name: fileName,
    relPath: rel,
    format,
    stats: { chapters: chapters.length, chars_raw: charsRaw, chars_clean: charsClean, avg_chars: chapters.length ? Math.round(charsClean / chapters.length) : 0, warnings: check.warnings },
  };
}

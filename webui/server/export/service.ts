// 交付导出服务（export-publish.md / api-contract §3.9）—— M4 打磨：+zip 分卷 / excel 清单 / epub
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import Database from 'better-sqlite3';
import { writeZip, type ZipEntry } from '../util/zip.ts';
import { writeXlsx } from '../util/xlsx.ts';
import { writeEpub, type EpubChapter } from '../util/epub.ts';
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
  format?: 'markdown' | 'txt' | 'zip' | 'excel' | 'epub';
  platform?: string;
  include?: string[];
  images?: boolean;
}

/** 章节清单（Excel 用）：首句/末句钩子 + 三查状态 */
export interface ExcelRow {
  no: number;
  title: string;
  charsRaw: number;
  charsClean: number;
  hookFirst: string;
  hookLast: string;
  reviewStatus: string;
}

/** 读取 首句/末句 与「三查」记录状态（大纲/审查记录/正文审查_第NNN章.md） */
export function rowFor(chapters: ChapterDoc[], bookDir: string): ExcelRow[] {
  const rows: ExcelRow[] = [];
  for (const c of chapters) {
    const paras = c.body.split(/\r?\n\r?\n+/).map((s) => s.trim().replace(/^#+\s*/, '')).filter(Boolean);
    const first = paras[0] ?? '';
    const last = paras[paras.length - 1] ?? '';
    const reviewFile = join(bookDir, '大纲', '审查记录', '正文审查_第' + c.no + '章.md');
    const reviewStatus = existsSync(reviewFile) ? '已生成' : '未生成';
    rows.push({
      no: c.no,
      title: titleOf(c),
      charsRaw: rawChars(c.body),
      charsClean: c.chars,
      hookFirst: first.slice(0, 28),
      hookLast: last.slice(0, 28),
      reviewStatus,
    });
  }
  return rows;
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split(String.fromCharCode(13)).join('');
}

/** epub 章节 html：标题 + 段落（正文按空行分段） */
function chapterHtml(body: string, chapterNo: number, cleanTitle: string): string {
  const paras = body
    .split(/\r?\n\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => '<p>' + htmlEscape(p).replace(/\n/g, '<br/>') + '</p>')
    .join('');
  return '<h1>第' + chapterNo + '章 ' + htmlEscape(cleanTitle) + '</h1>\n' + paras;
}

function buildEpub(bookName: string, chapters: ChapterDoc[], bookDir: string): Buffer {
  const eps: EpubChapter[] = chapters.map((c) => ({
    id: 'ch' + String(c.no).padStart(3, '0'),
    title: titleOf(c),
    html: chapterHtml(c.body, c.no, titleOf(c)),
  }));
  let cover: Buffer | null = null;
  const coverDir = join(bookDir, '封面');
  if (existsSync(coverDir)) {
    for (const f of readdirSync(coverDir)) {
      const low = f.toLowerCase();
      if (low.endsWith('.jpg') || low.endsWith('.jpeg') || low.endsWith('.png')) {
        cover = readFileSync(join(coverDir, f));
        break;
      }
    }
  }
  return writeEpub({
    title: bookName,
    chapters: eps,
    cover,
    language: 'zh-CN',
  });
}

function buildExcel(bookName: string, chapters: ChapterDoc[], bookDir: string): Buffer {
  const rows = rowFor(chapters, bookDir);
  const header = ['章节号', '标题', '纯字符数', '扣标点字数', '首句钩子', '末句钩子', '三查状态'];
  const body = rows.map((r) => [r.no, r.title, r.charsRaw, r.charsClean, r.hookFirst, r.hookLast, r.reviewStatus]);
  const totalRaw = rows.reduce((s, r) => s + r.charsRaw, 0);
  const totalClean = rows.reduce((s, r) => s + r.charsClean, 0);
  const statsSheet = {
    name: '统计',
    rows: [
      ['书名', bookName],
      ['章节数', chapters.length],
      ['总字符数（纯字符口径）', totalRaw],
      ['总字数（扣标点口径）', totalClean],
      ['均章字数（扣标点）', chapters.length ? Math.round(totalClean / chapters.length) : 0],
      ['已生成三查记录章数', rows.filter((r) => r.reviewStatus === '已生成').length],
      ['导出时间', new Date().toISOString()],
    ],
  };
  return writeXlsx([
    { name: '章节清单', rows: [header, ...body.map((b) => b.map((v) => v as string | number | boolean | null))] },
    statsSheet,
  ]);
}

function buildZip(book: { name: string; dir: string }, chapters: ChapterDoc[]): Buffer {
  const entries: ZipEntry[] = [];
  // 分卷：每 100 章一文件夹（卷一/卷二…，可被 README 说明调整）
  const VOL = 100;
  let volIdx = 0;
  let volCount = Math.ceil(chapters.length / VOL) || 1;
  for (let i = 0; i < chapters.length; i++) {
    if (i % VOL === 0) volIdx++;
    const c = chapters[i]!;
    const folder = '卷一' + (volCount > 1 && volIdx > 1 ? String(volIdx) : volIndexName(volIdx, volCount));
    const fn = '第' + String(c.no).padStart(3, '0') + '章_' + titleOf(c).replace(/[\\/:*?"<>|]/g, '') + '.md';
    entries.push({
      name: folder + '/' + fn,
      data: '# 第' + c.no + '章 ' + titleOf(c) + '\n\n' + c.body + '\n',
    });
  }
  // 附带 大纲/设定（若含正文引用文件则一起打包；跳过 交付/_archive/. 开头的）
  copyTreeIntoZip(book.dir, '大纲', entries);
  copyTreeIntoZip(book.dir, '设定', entries);
  copyTreeIntoZip(book.dir, '追踪', entries, /_tracking-state\.json/);
  copyTreeIntoZip(book.dir, '封面', entries);
  // README.txt
  const totalClean = chapters.reduce((s, c) => s + c.chars, 0);
  const readme = [
    book.name,
    '='.repeat(Math.max(8, book.name.length)),
    '',
    '· 章节数：' + chapters.length,
    '· 净字数（扣标点口径）：' + totalClean,
    '· 纯字符数：' + chapters.reduce((s, c) => s + rawChars(c.body), 0),
    '· 均章字数：' + (chapters.length ? Math.round(totalClean / chapters.length) : 0),
    '· 导出时间：' + new Date().toISOString(),
    '',
    '· 封面：' + (existsSync(join(book.dir, '封面')) ? '见 封面/（或按平台规范上传）' : '未提供（可后补 封面/）'),
    '',
    '· 免责：长度/换行口径为网文平台惯例换算，投稿前以各平台现行要求为准。',
    '',
  ].join('\n');
  entries.push({ name: 'README.txt', data: readme });
  return writeZip(entries);
}

function volIndexName(volIdx: number, volCount: number): string {
  if (volCount <= 1 || volIdx === 1) return '';
  return String(volIdx);
}

function copyTreeIntoZip(root: string, rel: string, entries: ZipEntry[], only?: RegExp): void {
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
  const walk = (dir: string, prefix: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      const f = join(dir, d.name);
      if (d.isDirectory()) walk(f, prefix + d.name + '/');
      else {
        if (only && !only.test(d.name)) continue;
        entries.push({ name: prefix + d.name, data: readFileSync(f) });
      }
    }
  };
  walk(abs, rel + '/');
}

export interface ExportStats {
  chapters: number; chars_raw: number; chars_clean: number; avg_chars: number; blocked?: string[]; warnings?: string[];
}

export function exportBook(
  db: Sqlite,
  book: { id: string; name: string; dir: string },
  req: ExportRequest,
): { ok: boolean; name: string; relPath: string; format: string; stats: ExportStats } {
  const format = ['txt', 'zip', 'excel', 'epub'].includes(req.format ?? '') ? (req.format as string) : 'markdown';
  const chapters = collectChapters(book.dir);
  const check = verifyDelivery(chapters);
  if (!check.ok) {
    return { ok: false, name: '', relPath: '', format, stats: { chapters: chapters.length, chars_raw: 0, chars_clean: 0, avg_chars: 0, blocked: check.blocking, warnings: check.warnings } };
  }

  const outlinePath = join(book.dir, '大纲', '大纲.md');
  const outlineText = existsSync(outlinePath) ? readFileSync(outlinePath, 'utf8') : '';
  const includeOutline = Array.isArray(req.include) ? req.include.includes('outline') : true;
  const safeName = trimSafe(book.name);

  let fileName: string;
  let out: Buffer | string;
  if (format === 'txt') {
    const platform = req.platform ?? 'fanqie';
    fileName = safeName + '_' + platform + '.txt';
    out = formatTxt(chapters, platform);
  } else if (format === 'zip') {
    fileName = safeName + '_分卷打包.zip';
    out = buildZip(book, chapters);
  } else if (format === 'excel') {
    fileName = safeName + '_章节清单.xlsx';
    out = buildExcel(book.name, chapters, book.dir);
  } else if (format === 'epub') {
    fileName = safeName + '.epub';
    out = buildEpub(book.name, chapters, book.dir);
  } else {
    fileName = safeName + '.md';
    out = formatMarkdown(chapters, includeOutline, outlineText);
  }

  const rel = '交付/' + fileName;
  const abs = join(book.dir, rel);
  mkdirSync(join(book.dir, '交付'), { recursive: true });
  if (Buffer.isBuffer(out)) writeFileSync(abs, out);
  else writeFileSync(abs, out, 'utf8');

  const charsRaw = chapters.reduce((s, c) => s + rawChars(c.body), 0);
  const charsClean = chapters.reduce((s, c) => s + c.chars, 0);
  db.prepare("INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)")
    .run(new Date().toISOString(), 'user', 'export', 'book:' + book.id, JSON.stringify({ format, name: fileName, chapters: chapters.length, chars_clean: charsClean, bytes: statSync(abs).size }));

  return {
    ok: true,
    name: fileName,
    relPath: rel,
    format,
    stats: { chapters: chapters.length, chars_raw: charsRaw, chars_clean: charsClean, avg_chars: chapters.length ? Math.round(charsClean / chapters.length) : 0, warnings: check.warnings },
  };
}

function trimSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || '未命名';
}

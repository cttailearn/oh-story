// 分析与检索服务（api-contract §3.12 / webui-frontend §9.4 / §10.1）：全局搜索 + 情绪曲线 + 节奏条带
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
type Sqlite = InstanceType<typeof Database>;

function walkMd(dir: string, out: string[] = [], prefix = ''): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walkMd(full, out, prefix + e + '/');
    else if (e.endsWith('.md')) out.push(prefix + e);
  }
  return out;
}

function readBookFile(bookDir: string, rel: string): string {
  try { return readFileSync(join(bookDir, rel), 'utf8').replace(/^\uFEFF/, ''); }
  catch { return ''; }
}

/** 命中片段：匹配位置前后各截 40 字并加 <mark> 高亮 */
function snippet(text: string, q: string): string | null {
  const body = text.replace(/\s+/g, ' ');
  const i = body.indexOf(q);
  if (i < 0) return null;
  const a = Math.max(0, i - 20);
  const b = Math.min(body.length, i + q.length + 30);
  return '…' + body.slice(a, i) + '<mark>' + q + '</mark>' + body.slice(i + q.length, b) + '…';
}

interface Hit { path: string; snippet: string }

/** 全局搜索（api-contract §3.12）：正文/角色/伏笔/设定/大纲 分组（可限定某书） */
export function searchBook(
  book: { id: string; name: string; dir: string },
  q: string,
): { book_id: string; book_name: string; chapters: Hit[]; characters: Hit[]; foreshadow: Hit[]; settings: Hit[]; outline: Hit[] } {
  const query = q.trim();
  const chapters: Hit[] = [];
  const characters: Hit[] = [];
  const settings: Hit[] = [];
  const outline: Hit[] = [];
  const foreshadow: Hit[] = [];

  // 正文
  for (const rel of walkMd(join(book.dir, '正文'))) {
    const text = readBookFile(book.dir, '正文/' + rel);
    if (text.includes(query)) chapters.push({ path: '正文/' + rel, snippet: snippet(text, query) ?? '' });
  }
  // 设定（含 角色卡）
  for (const rel of walkMd(join(book.dir, '设定'))) {
    const text = readBookFile(book.dir, '设定/' + rel);
    if (!text.includes(query)) continue;
    const hit = { path: '设定/' + rel, snippet: snippet(text, query) ?? '' };
    if (rel.startsWith('角色/')) characters.push(hit); else settings.push(hit);
  }
  // 大纲（含细纲/卷纲/审查记录）
  for (const rel of walkMd(join(book.dir, '大纲'))) {
    const text = readBookFile(book.dir, '大纲/' + rel);
    if (text.includes(query)) outline.push({ path: '大纲/' + rel, snippet: snippet(text, query) ?? '' });
  }
  // 伏笔（追踪状态 projections）
  const track = readBookFile(book.dir, '追踪/_tracking-state.json');
  if (track.includes(query)) {
    try {
      const t = JSON.parse(track);
      for (const id of Object.keys(t.foreshadow ?? {})) {
        const f = t.foreshadow[id];
        if (JSON.stringify(f).includes(query)) foreshadow.push({ path: '追踪/' + id, snippet: (f?.summary ?? id) + '（' + id + '）' });
      }
      for (const id of Object.keys(t.timeline ?? {})) {
        const e = t.timeline[id];
        if (JSON.stringify(e).includes(query)) foreshadow.push({ path: '追踪/' + id, snippet: (e?.objective_fact ?? id) + '（' + id + '）' });
      }
    } catch { /* ignore */ }
  }

  return { book_id: book.id, book_name: book.name, chapters, characters, foreshadow: foreshadow.slice(0, 20), settings, outline: outline.slice(0, 30) };
}

export function searchAll(db: Sqlite, q: string) {
  const rows = db.prepare("SELECT id, name, dir FROM books WHERE dir IS NOT NULL").all() as Array<{ id: string; name: string; dir: string }>;
  const results = rows.map((r) => searchBook(r, q)).filter((r) => r.chapters.length || r.characters.length || r.foreshadow.length || r.settings.length || r.outline.length);
  return { results, total: results.length };
}

function chapterNos(bookDir: string): Array<{ no: number; chars: number }> {
  const dir = join(bookDir, '正文');
  if (!existsSync(dir)) return [];
  const out: Array<{ no: number; chars: number }> = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const m = f.match(/^第(\d+)章/);
    if (!m) continue;
    const text = readFileSync(join(dir, f), 'utf8');
    const body = text.split(/\r?\n/).slice(1).join('\n').replace(/\s+/g, '');
    out.push({ no: m[1] ? parseInt(m[1], 10) : 0, chars: body.length });
  }
  return out.sort((a, b) => a.no - b.no);
}

/** 节奏条带（§10.1）：按章字数相对书均值量化 slow/steady/fast/climax */
export function rhythmCurve(bookDir: string): { x: number[]; value: string[] } {
  const chs = chapterNos(bookDir);
  if (chs.length === 0) return { x: [], value: [] };
  const avg = chs.reduce((s, c) => s + c.chars, 0) / chs.length;
  const value = chs.map((c) => {
    const r = c.chars / avg;
    if (r > 1.6) return 'climax';
    if (r > 1.15) return 'steady';
    if (r < 0.6) return 'fast';
    return 'slow';
  });
  return { x: chs.map((c) => c.no), value };
}

/** 情绪曲线（§10.1）：基准 0 + 伏笔 埋/揭示 标记 + 拆文 情绪数据优先（若存在） */
export function emotionCurve(bookDir: string, bookName: string): { x: number[]; series: Array<{ name: string; data: number[] }>; markers: Array<{ chap: number; label: string; flag: string }> } {
  const chs = chapterNos(bookDir);
  const x = chs.map((c) => c.no);
  const data = chs.map(() => 0);
  const markers: Array<{ chap: number; label: string; flag: string }> = [];

  // 拆文数据优先（情绪模块 / 节奏模块 from 拆文库）
  const tear = join(bookDir, '拆文库', bookName, '剧情', '情绪模块.md');
  if (existsSync(tear)) {
    const t = readFileSync(tear, 'utf8');
    const re = /第(\d+)章\s*[：:]?\s*([-+]?\d+(?:\.\d+)?)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const idx = m[1] ? x.indexOf(parseInt(m[1], 10)) : -1;
      if (idx >= 0) data[idx] = Number(m[2]);
    }
    for (const c of chs) if (c.no === 1) markers.push({ chap: 1, label: '爽点', flag: '🚩' });
  } else {
    // 兜底：伏笔揭示章打标记
    const track = readBookFile(bookDir, '追踪/_tracking-state.json');
    try {
      const t = JSON.parse(track);
      for (const id of Object.keys(t.foreshadow ?? {})) {
        const f = t.foreshadow[id];
        const due = f?.planned_resolution_chapter;
        if (Number.isFinite(due)) markers.push({ chap: Number(due), label: '🔻 ' + id, flag: '📌' });
      }
    } catch { /* ignore */ }
  }
  return { x, series: [{ name: '情绪', data }], markers };
}

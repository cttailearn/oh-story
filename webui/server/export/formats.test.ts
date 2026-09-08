// 导出补全单测（export-publish §1 M4）：zip / excel / epub 写入器 + exportBook 新格式
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import Database from 'better-sqlite3';
import { writeZip, type ZipEntry } from '../util/zip.ts';
import { writeXlsx } from '../util/xlsx.ts';
import { writeEpub } from '../util/epub.ts';
import { exportBook, collectChapters } from './service.ts';

// ---- 极简 zip 读取器（测试用）----
interface ZEntry { name: string; data: Buffer; method: number }
export function readZip(buf: Buffer): ZEntry[] {
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: ZEntry[] = [];
  for (let k = 0; k < count; k++) {
    const sig = buf.readUInt32LE(off);
    if (sig !== 0x02014b50) throw new Error('bad central sig at ' + off);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    // local header data start
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    out.push({ name, method, data: method === 0 ? comp : inflateRawSync(comp) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

let dir: string;
let ws: string;
let db: InstanceType<typeof Database>;
const DDL = `
  CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, name TEXT NOT NULL, dir TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT);
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-fmt-'));
  ws = join(dir, 'ws');
  mkdirSync(ws, { recursive: true });
  db = new Database(join(dir, 'm.db'));
  db.exec(DDL);
});
afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function makeBook(): { id: string; name: string; dir: string } {
  const bookDir = join(ws, '格式测试书');
  mkdirSync(join(bookDir, '正文'), { recursive: true });
  mkdirSync(join(bookDir, '追踪'), { recursive: true });
  writeFileSync(join(bookDir, '追踪/_tracking-state.json'), '{}', 'utf8');
  writeFileSync(join(bookDir, '正文/第001章_开局.md'), '# 第1章 开局\n\n林晚醒来，看见顾沉。她决定离开这里。\n\n这是第一句伏笔的暗示。', 'utf8');
  writeFileSync(join(bookDir, '正文/第002章_任务.md'), '# 第2章 任务\n\n第二天，系统发布任务。林晚接下任务转身离开。', 'utf8');
  mkdirSync(join(bookDir, '大纲', '审查记录'), { recursive: true });
  writeFileSync(join(bookDir, '大纲', '审查记录/正文审查_第1章.md'), '## 结论\n- 本章完成度：良好', 'utf8');
  const id = 'nb_fmt';
  db.prepare(`INSERT OR REPLACE INTO books (id, name, dir, kind, meta_json, created_at, updated_at) VALUES (?,?,?,'novel','{}',?,?)`).run(id, '格式测试书', bookDir, new Date().toISOString(), new Date().toISOString());
  return { id, name: '格式测试书', dir: bookDir };
}

describe('writeZip', () => {
  it('生成合法 zip（本地头+中央目录+EOCD），deflate 可解回原文', () => {
    const entries: ZipEntry[] = [
      { name: 'a.txt', data: 'hello 世界' },
      { name: 'dir/b.md', data: '# B' },
      { name: 'store.txt', data: 'stored-content', stored: true },
    ];
    const zip = writeZip(entries);
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
    const got = readZip(zip);
    expect(got.map((e) => e.name).sort()).toEqual(['a.txt', 'dir/b.md', 'store.txt'].sort());
    expect(got.find((e) => e.name === 'a.txt')!.data.toString('utf8')).toBe('hello 世界');
    expect(got.find((e) => e.name === 'dir/b.md')!.data.toString('utf8')).toBe('# B');
    expect(got.find((e) => e.name === 'store.txt')!.method).toBe(0);
  });
});

describe('writeXlsx', () => {
  it('产出含 innerStr 行与数字的 sheet XML，并带 content-types', () => {
    const buf = writeXlsx([
      { name: '章节清单', rows: [['章节号', '标题', '字数'], [1, '开局', 120], [2, '任务', 90]] },
    ]);
    const entries = readZip(buf);
    const names = entries.map((e) => e.name);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('xl/workbook.xml');
    expect(names).toContain('xl/worksheets/sheet1.xml');
    const sheet = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml')!.data.toString('utf8');
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('<v>120</v>');
    expect(sheet).toContain('开局');
    const wb = entries.find((e) => e.name === 'xl/workbook.xml')!.data.toString('utf8');
    expect(wb).toContain('name="章节清单"');
  });
});

describe('writeEpub', () => {
  it('mimetype 为首个 stored 条目，含 container/opf/nav/spine 章节', () => {
    const buf = writeEpub({
      title: '测试书',
      creator: '作者',
      chapters: [
        { id: 'ch001', title: '开局', html: '<h1>开局</h1><p>正文。</p>' },
        { id: 'ch002', title: '任务', html: '<h1>任务</h1><p>系统来了。</p>' },
      ],
    });
    const entries = readZip(buf);
    expect(entries[0]!.name).toBe('mimetype');
    expect(entries[0]!.method).toBe(0);
    expect(entries[0]!.data.toString('utf8')).toBe('application/epub+zip');
    const opf = entries.find((e) => e.name === 'OEBPS/content.opf')!.data.toString('utf8');
    expect(opf).toContain('dc:title');
    expect(opf).toContain('ch001.xhtml');
    expect(opf).toContain('<spine toc="ncx">');
    expect(entries.find((e) => e.name === 'META-INF/container.xml')).toBeDefined();
    expect(entries.find((e) => e.name === 'OEBPS/nav.xhtml')).toBeDefined();
    expect(entries.find((e) => e.name === 'OEBPS/ch001.xhtml')).toBeDefined();
  });
});

describe('exportBook（新格式）', () => {
  it('zip/excel/epub 各自落盘 交付/ 且内容可解析', () => {
    const book = makeBook();
    const chapters = collectChapters(book.dir);
    expect(chapters.length).toBe(2);

    // zip
    const zr = exportBook(db, book, { format: 'zip' });
    expect(zr.ok).toBe(true);
    expect(zr.name).toMatch(/\.zip$/);
    const zipPath = join(book.dir, zr.relPath.replace(/\//g, sep));
    expect(existsSync(zipPath)).toBe(true);
    const zz = readZip(readFileSync(zipPath));
    expect(zz.some((e) => e.name.endsWith('_开局.md'))).toBe(true);
    expect(zz.some((e) => e.name === 'README.txt')).toBe(true);
    expect(zz.some((e) => e.name.startsWith('卷一/'))).toBe(true);
    expect(zz.some((e) => e.name.startsWith('追踪/'))).toBe(true);

    // excel
    const xr = exportBook(db, book, { format: 'excel' });
    expect(xr.ok).toBe(true);
    const xlsPath = join(book.dir, xr.relPath.replace(/\//g, sep));
    const xlsEntries = readZip(readFileSync(xlsPath));
    const sheet1 = xlsEntries.find((e) => e.name.includes('sheet1'))!.data.toString('utf8');
    expect(sheet1).toContain('开局');
    expect(sheet1).toContain('三查状态');
    expect(sheet1).toContain('已生成');

    // epub
    const er = exportBook(db, book, { format: 'epub' });
    expect(er.ok).toBe(true);
    const epubPath = join(book.dir, er.relPath.replace(/\//g, sep));
    const epubEntries = readZip(readFileSync(epubPath));
    expect(epubEntries[0]!.data.toString('utf8')).toBe('application/epub+zip');
    expect(epubEntries.some((e) => e.name === 'OEBPS/ch001.xhtml')).toBe(true);

    // 交付 目录有 3 个文件
    expect(readdirSync(join(book.dir, '交付')).length).toBeGreaterThanOrEqual(3);
  });
  it('缺章/空章仍被 delivery-contract blocking 拦截（fail-closed）', () => {
    const bookDir = join(ws, '空书');
    mkdirSync(join(bookDir, '正文'), { recursive: true });
    // 编号缺 2
    writeFileSync(join(bookDir, '正文/第001章_x.md'), '# 第1章 x', 'utf8');
    writeFileSync(join(bookDir, '正文/第003章_y.md'), '# 第3章 y', 'utf8');
    const bad = exportBook(db, { id: 'nb_empty', name: '空书', dir: bookDir }, { format: 'zip' });
    expect(bad.ok).toBe(false);
    expect(bad.stats.blocked!.join('')).toContain('不连续');
  });
});

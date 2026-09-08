// 导出服务单测（export-publish §2-§5）：章节收集 / 发布前检查 / 平台格式 / 字数口径
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { collectChapters, verifyDelivery, formatMarkdown, formatTxt, cleanChars, rawChars, exportBook } from './service.ts';

let dir: string;
let bookDir: string;
let db: InstanceType<typeof Database>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-exp-'));
  bookDir = join(dir, 'book');
  mkdirSync(join(bookDir, '正文'), { recursive: true });
  mkdirSync(join(bookDir, '大纲'), { recursive: true });
  writeFileSync(join(bookDir, '正文', '第001章_开局.md'), '# 第1章 开局\n他穿过雨幕走上台阶。\n\n灯亮了起来。', 'utf8');
  writeFileSync(join(bookDir, '正文', '第002章_任务.md'), '# 第2章 任务\n系统发布了第一个任务，他按下确认。', 'utf8');
  writeFileSync(join(bookDir, '大纲', '大纲.md'), '# 大纲\n## 全书体量\n两章示例。', 'utf8');
  db = new Database(join(dir, 'm.db'));
  db.exec("CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT);");
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('collectChapters + 字数口径', () => {
  it('按章号排序读取，字数按扣标点口径', () => {
    const cs = collectChapters(bookDir);
    expect(cs.map((c) => c.no)).toEqual([1, 2]);
    expect(cs[0]!.title).toContain('开局');
    expect(realChars(cs)).toBeGreaterThan(0);
    const clean = cleanChars('你好，世界。');
    const raw = rawChars('你好，世界。');
    expect(raw).toBe(6);
    expect(clean).toBe(4);
  });
});

function realChars(cs: any[]): number {
  return cs.reduce((s, c) => s + c.chars, 0);
}

describe('verifyDelivery', () => {
  it('连续+非空 → ok；缺号 → blocking', () => {
    const cs = collectChapters(bookDir);
    expect(verifyDelivery(cs).ok).toBe(true);
    const gap = [cs[0]!, { ...cs[1]!, no: 4, body: 'x', chars: 1 }];
    const v = verifyDelivery(gap);
    expect(v.ok).toBe(false);
    expect(v.blocking.join('')).toContain('不连续');
  });
  it('空白章 → blocking', () => {
    const v = verifyDelivery([{ no: 1, title: 't', body: '   ', chars: 0 }]);
    expect(v.ok).toBe(false);
  });
});

describe('格式化', () => {
  it('markdown 含大纲附篇 + 章节标题', () => {
    const cs = collectChapters(bookDir);
    const md = formatMarkdown(cs, true, '# 大纲\n## 全书体量\n两章示例。');
    expect(md).toContain('# 大纲（附）');
    expect(md).toContain('# 开局');
  });
  it('txt(番茄) 带 第N章 标题、去 markdown 符号、段落空行', () => {
    const cs = collectChapters(bookDir);
    const txt = formatTxt(cs, 'fanqie');
    expect(txt).toContain('第1章 开局');
    expect(txt).not.toContain('# ');
    expect(txt).toContain('\n\n');
  });
  it('txt(晋江) 段首两字缩进', () => {
    const txt = formatTxt(collectChapters(bookDir), 'jj');
    expect(txt).toContain('　　');
  });
});

describe('exportBook（端到端）', () => {
  it('发布前 block 时拒导', () => {
    writeFileSync(join(bookDir, '正文', '第003章_缺.x.md'), '# 第3章 最\n ', 'utf8');
    const r = exportBook(db, { id: 'nb_x', name: '测试书', dir: bookDir }, { format: 'markdown' });
    expect(r.ok).toBe(false);
    expect(r.stats.blocked?.join('')).toContain('空白');
  });
  it('通过后导出 markdown 落 交付/ + 统计', () => {
    // 清掉空白章，补一个正常第3章
    writeFileSync(join(bookDir, '正文', '第003章_缝隙.md'), '# 第3章 缝隙\n他说完转身离开。', 'utf8');
    rmSync(join(bookDir, '正文', '第003章_缺.x.md'));
    const r = exportBook(db, { id: 'nb_x', name: '测试书', dir: bookDir }, { format: 'markdown', include: ['outline'] });
    expect(r.ok).toBe(true);
    expect(r.relPath).toBe('交付/测试书.md');
    expect(r.stats.chapters).toBeGreaterThanOrEqual(3);
    expect(r.stats.chars_clean).toBeGreaterThan(0);
  });
});

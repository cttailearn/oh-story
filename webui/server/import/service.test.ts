// 导入服务单测（importing-existing §2）：cnToInt / splitChapters / buildTrackingState / importNovel
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { cnToInt, splitChapters, buildTrackingState, importNovel } from './service.ts';

let dir: string;
let ws: string;
let db: InstanceType<typeof Database>;

const DDL = `
  CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, name TEXT NOT NULL, dir TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, pipeline_id TEXT, pipeline_version INTEGER, theme_color TEXT, active_stage TEXT, meta_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT);
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-import-'));
  ws = join(dir, 'ws');
  mkdirSync(ws, { recursive: true });
  db = new Database(join(dir, 'm.db'));
  db.exec(DDL);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('cnToInt', () => {
  it('阿拉伯/中文大小写', () => {
    expect(cnToInt('第1章')).toBe(1);
    expect(cnToInt('第12章')).toBe(12);
    expect(cnToInt('第一章')).toBe(1);
    expect(cnToInt('第十一章')).toBe(11);
    expect(cnToInt('第二十三章')).toBe(23);
    expect(cnToInt('第一百章')).toBe(100);
  });
});

describe('splitChapters', () => {
  it('按 第N章 锚点分章（阿拉伯+中文）', () => {
    const text = 
      '第一章 开局\n他醒来发现穿越了。\n\n第二章 任务\n系统发布第一个任务。\n\n第三章 反击\n他完成了反击。'
    ;
    const cs = splitChapters(text);
    expect(cs.length).toBe(3);
    expect(cs[0]!.no).toBe(1);
    expect(cs[0]!.title).toContain('开局');
    expect(cs[1]!.no).toBe(2);
    expect(cs[1]!.body).toContain('系统发布第一个任务');
  });
  it('无锚 → 均匀 chunk 且置信度 0.5', () => {
    const cs = splitChapters('一二三四五六七八九' .repeat(600) );
    expect(cs.length).toBeGreaterThan(1);
    expect(cs.every((c) => c.confidence === 0.5)).toBe(true);
  });
});

describe('buildTrackingState', () => {
  it('schema v4 + last_committed_chapter = 最大连续章号', () => {
    const cs = splitChapters('第一章 开局\nxx\n第二章 任务\nyy');
    const t = buildTrackingState('测试书', cs);
    expect(t.schema_version).toBe(4);
    expect(t.last_committed_chapter).toBe(2);
    expect(t.state_revision).toBe(0);
    expect((t.context as any).recent_chapters).toHaveLength(2);
  });
});

describe('importNovel', () => {
  it('clipboard 导入 → 建书 + 正文落盘 + 追踪 + 校对清单；重复名不覆盖', async () => {
    const text = '第一章 开局\n他醒了。\n\n第二章 任务\n系统来了。';
    const r = await importNovel(db, ws, { name: '穿越之开局', mode: 'clipboard', text });
    expect(r.duplicate).toBe(false);
    expect(r.book).not.toBeNull();
    expect(r.review!.chapters.length).toBe(2);
    const bookDir = join(ws, '穿越之开局');
    const files = readdirSync(join(bookDir, '正文')).sort();
    expect(files.length).toBe(2);
    expect(files[0]).toMatch(/^第001章/);
    const track = JSON.parse(readFileSync(join(bookDir, '追踪/_tracking-state.json'), 'utf8'));
    expect(track.schema_version).toBe(4);
    expect(track.last_committed_chapter).toBe(2);

    const dup = await importNovel(db, ws, { name: '穿越之开局', mode: 'clipboard', text });
    expect(dup.duplicate).toBe(true);
    expect(dup.book).not.toBeNull();
  });
  it('空文本/无章 → INVALID_INPUT', async () => {
    await expect(importNovel(db, ws, { name: '空书', mode: 'clipboard', text: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('dir 模式 → 直接挂载不解析', async () => {
    const bookDir = join(ws, '已有目录书');
    mkdirSync(join(bookDir, '正文'), { recursive: true });
    writeFileSync(join(bookDir, '正文/第001章_old.md'), 'x', 'utf8');
    const r = await importNovel(db, ws, { name: '已有目录书', mode: 'dir', path: bookDir });
    expect(r.book).not.toBeNull();
    expect(r.review).toBeNull();
  });
});

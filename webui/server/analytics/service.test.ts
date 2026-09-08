// 分析/检索服务单测（api-contract §3.12 / webui-frontend §9.4/§10.1）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { searchBook, searchAll, emotionCurve, rhythmCurve } from './service.ts';

let dir: string;
let bookDir: string;
let db: InstanceType<typeof Database>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-ana-'));
  bookDir = join(dir, 'book');
  mkdirSync(join(bookDir, '正文'), { recursive: true });
  mkdirSync(join(bookDir, '设定', '角色'), { recursive: true });
  mkdirSync(join(bookDir, '大纲', '细纲'), { recursive: true });
  mkdirSync(join(bookDir, '追踪'), { recursive: true });
  writeFileSync(join(bookDir, '正文', '第001章_开端.md'), '# 第1章 开端\n江晨走上台阶，雨幕如织。\n'.repeat(0) + '江晨走进演播室，雨慢慢停了下来。', 'utf8');
  writeFileSync(join(bookDir, '正文', '第002章_任务.md'), '# 第2章 任务\n系统发布了第一个任务。', 'utf8');
  writeFileSync(join(bookDir, '设定', '角色', '江晨.md'), '# 角色卡：江晨\n## 身份\n军宣文工团新人', 'utf8');
  writeFileSync(join(bookDir, '大纲', '细纲', '第001章.md'), '# 第1章\n**核心事件**：开篇定调', 'utf8');
  writeFileSync(join(bookDir, '追踪', '_tracking-state.json'), JSON.stringify({ schema_version: 4, last_committed_chapter: 2, state_revision: 1, foreshadow: { F001: { summary: '江晨的身世之谜', planned_resolution_chapter: 5 } }, timeline: { E001: { objective_fact: '军方培养安排' } }, context: { position: {} } }, null, 2), 'utf8');
  db = new Database(join(dir, 'm.db'));
  db.exec("CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, name TEXT NOT NULL, dir TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);");
  db.prepare("INSERT INTO books (id, name, dir, created_at, updated_at) VALUES ('nb_1','测试书',?,'x','x')").run(bookDir);
});

afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('searchBook（分组命中）', () => {
  it('正文/角色/伏笔/大纲 各自命中', () => {
    const r = searchBook({ id: 'nb_1', name: '测试书', dir: bookDir }, '江晨');
    expect(r.characters.length).toBeGreaterThan(0);
    expect(r.foreshadow.length).toBeGreaterThan(0); // 追踪 F001 摘要含江晨
    expect(r.chapters.length).toBeGreaterThan(0);  // 正文 第001 含江晨
    expect(r.characters[0]!.snippet).toContain('<mark>江晨</mark>');
    const o = searchBook({ id: 'nb_1', name: '测试书', dir: bookDir }, '开篇定调');
    expect(o.outline.length).toBe(1);
  });
  it('searchAll 跨书聚合', () => {
    const all = searchAll(db, '江晨');
    expect(all.total).toBeGreaterThanOrEqual(1);
    expect(all.results[0]!.book_name).toBe('测试书');
  });
});

describe('curves', () => {
  it('rhythm 按章字数量化并覆盖全部章号', () => {
    const r = rhythmCurve(bookDir);
    expect(r.x).toEqual([1, 2]);
    expect(r.value).toHaveLength(2);
    expect(r.value.every((v) => ['slow', 'steady', 'fast', 'climax'].includes(v))).toBe(true);
  });
  it('emotion 契约 {x, series, markers}，伏笔揭示章有标记', () => {
    const e = emotionCurve(bookDir, '测试书');
    expect(e.x).toEqual([1, 2]);
    expect(e.series[0]!.data).toHaveLength(2);
    expect(e.markers.some((m) => m.chap === 5)).toBe(true); // F001 planned_resolution
  });
});

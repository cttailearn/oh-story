// 导入服务单测（importing-existing §2/§3/§4 + M4 打磨）：
// cnToInt / splitChapters / 候选提取 / buildTrackingState / importNovel / applyImportReview / importReviewPending
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  cnToInt,
  splitChapters,
  buildTrackingState,
  importNovel,
  applyImportReview,
  importReviewPending,
  extractCharacters,
  extractSignals,
} from './service.ts';

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
    const text = '第一章 开局\n他醒来发现穿越了。\n\n第二章 任务\n系统发布第一个任务。\n\n第三章 反击\n他完成了反击。';
    const cs = splitChapters(text);
    expect(cs.length).toBe(3);
    expect(cs[0]!.no).toBe(1);
    expect(cs[0]!.title).toContain('开局');
    expect(cs[1]!.no).toBe(2);
    expect(cs[1]!.body).toContain('系统发布第一个任务');
    expect(cs.every((c) => c.confidence === 1)).toBe(true);
  });
  it('无锚 → 均匀 chunk 且置信度 0.5', () => {
    const cs = splitChapters('一二三四五六七八九'.repeat(600));
    expect(cs.length).toBeGreaterThan(1);
    expect(cs.every((c) => c.confidence === 0.5)).toBe(true);
  });
});

describe('extractCharacters（置信度+证据）', () => {
  it('高频 2-4 字角色名进入候选，常见词被过滤', () => {
    const body = '林晚推开门，林晚看见顾沉，林晚叫住顾沉，林晚皱眉，顾沉回头，林晚与顾沉对视。';
    const cands = extractCharacters('第一章 开局\n' + body.repeat(9));
    const names = cands.map((c) => c.name);
    expect(names).toContain('林晚');
    expect(names).toContain('顾沉');
    expect(names.some((n) => n === '我们' || n === '什么' || n === '现在')).toBe(false);
    for (const c of cands) {
      expect(c.confidence).toBeGreaterThanOrEqual(0.35);
      expect(c.confidence).toBeLessThanOrEqual(0.85);
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(c.evidence[0]).toContain('第1章');
    }
  });
});

describe('extractSignals（伏笔/时间线）', () => {
  it('伏笔句式与时间标记被识别，且置信度分档', () => {
    const text =
      '第一章 开局\n他在墙角埋下了一个锦囊，留作后手。\n第二天，掌柜说了一件蹊跷事。\n三年前，这里曾发生大火。\n门口写着「此地无银」，隐约暗示着什么。';
    const { foreshadow, timeline } = extractSignals(text);
    expect(foreshadow.length).toBeGreaterThanOrEqual(2);
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    expect(foreshadow[0]!.summary).toContain('埋下');
    expect(foreshadow[0]!.confidence).toBe(0.5);
    expect(foreshadow[0]!.evidence[0]).toContain('第1章');
    for (const t of timeline) expect([0.4, 0.6]).toContain(t.confidence);
  });
});

describe('buildTrackingState', () => {
  it('schema v4 + last_committed + recent 带置信度；候选条目字段完整', () => {
    const cs = splitChapters('第一章 开局\n林晚看见顾沉，林晚埋下线索。\n\n第二章 任务\n林晚发现第二天有蹊跷。');
    const t = buildTrackingState('测试书', cs) as any;
    expect(t.schema_version).toBe(4);
    expect(t.last_committed_chapter).toBeGreaterThanOrEqual(2);
    expect(t.state_revision).toBe(0);
    expect(t.context.recent_chapters).toHaveLength(2);
    expect(t.context.recent_chapters.every((r: any) => r.confidence === 0.7)).toBe(true);
    for (const c of Object.values(t.characters ?? {})) {
      expect(typeof (c as any).confidence).toBe('number');
      expect(Array.isArray((c as any).evidence)).toBe(true);
    }
  });
});

describe('importNovel', () => {
  it('clipboard 导入 → 建书 + 正文落盘 + 追踪候选 + 校对清单；重复名不覆盖；待校对', async () => {
    const text =
      '第一章 开局\n林晚醒来，林晚看见顾沉，林晚决定离开。\n\n第二章 任务\n第二天，林晚发现墙角埋下了一个锦囊。';
    const r = await importNovel(db, ws, { name: '穿越之开局', mode: 'clipboard', text });
    expect(r.duplicate).toBe(false);
    expect(r.book).not.toBeNull();
    expect(r.review!.chapters.length).toBe(2);
    expect(Array.isArray(r.review!.characters)).toBe(true);
    expect(Array.isArray(r.review!.foreshadow)).toBe(true);
    expect(Array.isArray(r.review!.timeline)).toBe(true);
    expect(r.review!.message).toContain('已识别 2 章');
    const bookDir = join(ws, '穿越之开局');
    const files = readdirSync(join(bookDir, '正文')).sort();
    expect(files.length).toBe(2);
    expect(files[0]).toMatch(/^第001章/);
    const track = JSON.parse(readFileSync(join(bookDir, '追踪/_tracking-state.json'), 'utf8'));
    expect(track.schema_version).toBe(4);
    expect(track.last_committed_chapter).toBe(2);
    const row = db.prepare('SELECT meta_json FROM books WHERE id=?').get(r.book!.id) as any;
    const meta = JSON.parse(row.meta_json);
    expect(meta.imported).toBe(true);
    expect(meta.import_reviewed).toBe(false);
    expect(importReviewPending(bookDir, meta)).toBe(true);

    const dup = await importNovel(db, ws, { name: '穿越之开局', mode: 'clipboard', text });
    expect(dup.duplicate).toBe(true);
  });
  it('空文本/无章 → INVALID_INPUT', async () => {
    await expect(importNovel(db, ws, { name: '空书', mode: 'clipboard', text: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('dir 模式 → 直接挂载不解析，且不进入待校对', async () => {
    const bookDir = join(ws, '已有目录书');
    mkdirSync(join(bookDir, '正文'), { recursive: true });
    writeFileSync(join(bookDir, '正文/第001章_old.md'), 'x', 'utf8');
    const r = await importNovel(db, ws, { name: '已有目录书', mode: 'dir', path: bookDir });
    expect(r.book).not.toBeNull();
    expect(r.review).toBeNull();
    const row = db.prepare('SELECT meta_json FROM books WHERE id=?').get(r.book!.id) as any;
    expect(importReviewPending(bookDir, JSON.parse(row.meta_json))).toBe(false);
  });
});
  it('clipboard + dir 相对保存目录 → 建书落在所选目录', async () => {
    const text = '第一章 开端\n林晚醒来。';
    const r = await importNovel(db, ws, { name: '目录书', mode: 'clipboard', text, dir: '文件夹/子文件夹' });
    expect(r.book).not.toBeNull();
    const expected = join(ws, '文件夹', '子文件夹');
    expect((r.book as any).dir).toBe(expected);
    expect(readdirSync(join(expected, '正文')).length).toBeGreaterThan(0);
  });
  it('dir 越界/绝对路径 → 拒绝', async () => {
    await expect(importNovel(db, ws, { name: '越界书', mode: 'clipboard', text: '第一章\n内容', dir: '../escape' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(importNovel(db, ws, { name: '绝对书', mode: 'clipboard', text: '第一章\n内容', dir: 'C:/tmp/x' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });


describe('applyImportReview（导入校对应用）', () => {
  let counter = 0;
  async function makeBook(text: string): Promise<{ book: any; dir: string }> {
    counter++;
    const r = await importNovel(db, ws, { name: '校对本' + counter, mode: 'clipboard', text });
    expect(r.book).not.toBeNull();
    return { book: r.book!, dir: (r.book! as any).dir };
  }
  it('改名+合并+角色丢弃 + last_committed 认定 → 重编号、追踪更新、解锁、审计', async () => {
    const { book, dir: bookDir } = await makeBook(
      '第一章 开局\n林晚醒来。\n\n第二章 任务\n第二天，林晚发现埋在墙角的锦囊。\n\n第三章 反击\n林晚转身离开。'
    );
    const track0 = JSON.parse(readFileSync(join(bookDir, '追踪/_tracking-state.json'), 'utf8'));
    const charNames = Object.keys(track0.characters ?? {});
    const charDrop = charNames[0] ? [{ name: charNames[0]!, action: 'drop' as const }] : [];

    const res = await applyImportReview(db, book, {
      chapters: [
        { no: 1, title: '开局强改' },
        { no: 3, mergeInto: 2 },
      ],
      characters: charDrop,
      last_committed_chapter: 2,
    });
    expect(res.reviewed).toBe(true);
    // 2 -> 3 合并掉 1 章 → 最终 2 章
    expect(res.chapters).toHaveLength(2);
    expect(res.chapters[0]!.title).toContain('开局强改');
    expect(res.last_committed_chapter).toBe(2);
    const files = readdirSync(join(bookDir, '正文')).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^第001章/);
    expect(files[1]).toMatch(/^第002章/);
    const merged = readFileSync(join(bookDir, '正文', files[1]!), 'utf8');
    expect(merged).toContain('锦囊');
    expect(merged).toContain('离开');
    const t2 = JSON.parse(readFileSync(join(bookDir, '追踪/_tracking-state.json'), 'utf8'));
    expect(t2.last_committed_chapter).toBe(2);
    expect(t2.state_revision).toBe(1);
    if (charDrop.length) expect(t2.characters[charNames[0]!]).toBeUndefined();
    const row = db.prepare('SELECT meta_json FROM books WHERE id=?').get(book.id) as any;
    const meta = JSON.parse(row.meta_json);
    expect(meta.import_reviewed).toBe(true);
    expect(importReviewPending(bookDir, meta)).toBe(false);
    const audit = db.prepare("SELECT * FROM audit WHERE action='import-review' ORDER BY id DESC LIMIT 1").get() as any;
    expect(audit).not.toBeUndefined();
    expect(JSON.parse(audit.detail_json).chapters).toBe(2);
  });
  it('无 last_committed 时默认取全部章并解锁（保持可续写）', async () => {
    const { book, dir: bookDir } = await makeBook('第一章 开局\n林晚醒来。\n\n第二章 任务\n林晚离开。');
    const res = await applyImportReview(db, book, { chapters: [{ no: 2, drop: true }] });
    expect(res.chapters).toHaveLength(1);
    expect(res.reviewed).toBe(true);
    const row = db.prepare('SELECT meta_json FROM books WHERE id=?').get(book.id) as any;
    const meta = JSON.parse(row.meta_json);
    expect(importReviewPending(bookDir, meta)).toBe(false);
    const track = JSON.parse(readFileSync(join(bookDir, '追踪/_tracking-state.json'), 'utf8'));
    expect(track.last_committed_chapter).toBe(1);
  });
});

describe('importReviewPending（fail-closed）', () => {
  it('非导入/已复核 → false；导入未复核且追踪存在 → true；无追踪 → false', () => {
    const dirA = join(ws, 'pend_cases');
    mkdirSync(join(dirA, '追踪'), { recursive: true });
    writeFileSync(join(dirA, '追踪/_tracking-state.json'), '{}', 'utf8');
    expect(importReviewPending(dirA, null)).toBe(false);
    expect(importReviewPending(dirA, { imported: false })).toBe(false);
    expect(importReviewPending(dirA, { imported: true, import_reviewed: true })).toBe(false);
    expect(importReviewPending(dirA, { imported: true })).toBe(true);
    const dirB = join(ws, 'pend_none');
    mkdirSync(dirB, { recursive: true });
    expect(importReviewPending(dirB, { imported: true })).toBe(false);
  });
});
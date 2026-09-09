// 章节全链路回归（修复 P0-B/P0-D）：
//   1) 假渠道能真正跑完一章 → review（含 degeneration 门禁：假产物不得自我复读）
//   2) 追踪状态按 skills 契约初始化 + 提交，last_committed_chapter 推进
//   3) 三查记录由真实门禁结果驱动，且只在门禁全过后落盘
//   4) 手稿里不得残留控制块（json）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { getProcessDefinition } from './definitions.ts';
import { runStageJob } from './stageRunner.ts';
import { getStageRow } from './state.ts';
import { AiRuntime } from '../ai/runtime.ts';
import { initConfig } from '../config/index.ts';
import { splitAgentOutput } from './agentOutput.ts';
import { trackingSummary, PENDING_TX_REL } from './tracking.ts';

let dir: string;
let db: InstanceType<typeof Database>;
let bookDir: string;

const DDL = `
  CREATE TABLE IF NOT EXISTS stages (book_id TEXT NOT NULL, stage_id TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, started_at TEXT, reviewed_at TEXT, note TEXT, PRIMARY KEY (book_id, stage_id));
  CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, stage_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, cost_cents REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, error TEXT, detail_json TEXT, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, finished_at TEXT);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_busy ON jobs(book_id, stage_id) WHERE status IN ('queued','running');
  CREATE TABLE IF NOT EXISTS gate_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL, stage_id TEXT NOT NULL, revision INTEGER NOT NULL, job_id TEXT, gate TEXT NOT NULL, ok INTEGER NOT NULL, blocking_json TEXT NOT NULL DEFAULT '[]', warnings_json TEXT NOT NULL DEFAULT '[]', detail_json TEXT, ran_ms INTEGER NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT);
`;

function seed(rel: string, content: string): void {
  const abs = join(bookDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-chapter-'));
  initConfig(join(dir, 'cfg'));
  db = new Database(join(dir, 'chapter.db'));
  db.exec(DDL);
  bookDir = join(dir, 'book');
  seed('设定/题材定位.md', '# 题材定位\n- 题材：都市\n- 平台风格：番茄\n');
  seed('设定/文风.md', '# 文风\n- 口语化\n');
  seed('大纲/细纲/第001章.md', '# 第001章\n\n## 核心事件\n演播室录制开场。\n');
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('splitAgentOutput', () => {
  it('剥离控制块并提取事务/三查，正文保持干净', () => {
    const text = [
      '# 第001章 测试',
      '',
      '正文第一段。',
      '',
      '```json',
      JSON.stringify({ tracking_tx: { schema_version: 1, mode: 'append', chapter: 1, delta: { result: 'r' } } }),
      '```',
      '',
      '```json',
      JSON.stringify({ review: { chapter: 1, check2: { items: [{ item: '核心事件兑现', ok: true }] }, conclusion: '完成' } }),
      '```',
      '',
    ].join('\n');
    const out = splitAgentOutput(text);
    expect(out.stripped).toBe(2);
    expect(out.tx).toMatchObject({ chapter: 1, mode: 'append' });
    expect(out.review?.check2.items).toHaveLength(1);
    expect(out.body).not.toContain('tracking_tx');
    expect(out.body).not.toContain('```');
    expect(out.body).toContain('正文第一段。');
  });

  it('不认识的 json 块原样保留（不误删正文）', () => {
    const text = '正文\n\n```json\n{"foo":1}\n```\n';
    const out = splitAgentOutput(text);
    expect(out.stripped).toBe(0);
    expect(out.body).toContain('{"foo":1}');
  });
});

describe('章节全链路（fake）', () => {
  it('跑完一章：进 review + 追踪提交 + 三查按真实门禁结果落盘', async () => {
    const def = getProcessDefinition('long');
    const bookId = 'nb_chapter_full';
    const res = await runStageJob({
      db: { db, path: join(dir, 'chapter.db'), user_version: 1 },
      ai: new AiRuntime(),
      def,
      bookId,
      bookDir,
      bookName: '章节链路测试书',
      stageId: 'chapter',
      fake: true,
    });
    expect(res.status, JSON.stringify(db.prepare('SELECT gate, blocking_json FROM gate_runs WHERE book_id=?').all(bookId))).toBe('review');
    expect(getStageRow(db, bookId, 'chapter')!.status).toBe('review');

    // 追踪状态：按 skills 契约 init + commit
    const ts = trackingSummary(bookDir);
    expect(ts.exists).toBe(true);
    expect(ts.last_committed_chapter).toBe(1);
    expect(ts.state_revision).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(bookDir, '追踪', '上下文.md'))).toBe(true);
    expect(existsSync(join(bookDir, '追踪', '逐章记录', '第001章.md'))).toBe(true);
    // 提交成功后 pending 事务被清理
    expect(existsSync(join(bookDir, PENDING_TX_REL))).toBe(false);

    // 三查记录：查3 取真实门禁结果（全过 → 0），查2 来自 Agent 载荷
    const record = readFileSync(join(bookDir, '大纲', '审查记录', '正文审查_第001章.md'), 'utf8');
    expect(record).toContain('check-ai-patterns blocking=0');
    expect(record).toContain('check-degeneration blocking=0');
    expect(record).toContain('核心事件与细纲一致');
    expect(record).toContain('结论');

    // 手稿不得残留控制块
    const manuscript = readFileSync(join(bookDir, '正文', '第001章_开篇（fake 示例产物）.md'), 'utf8');
    expect(manuscript).not.toContain('tracking_tx');
    expect(manuscript).not.toContain('```');
  });
});

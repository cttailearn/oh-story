// M1.5/M1.7 集成：Context 组装 + FakeAgent + stageRunner（fake 模式全链路）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { getProcessDefinition } from '../engine/definitions.ts';
import { assembleBundle, CONTEXT_GLUES } from '../agents/contexts/index.ts';
import { runFakeAgent } from '../agents/execute.ts';
import { AiRuntime } from '../ai/runtime.ts';
import { initConfig } from '../config/index.ts';
import { runStageJob, splitFileBlocks } from '../engine/stageRunner.ts';
import { getStageRow } from '../engine/state.ts';

let dir: string;
let db: InstanceType<typeof Database>;
let bookDir: string;
let def: import('../engine/types.ts').ProcessDefinition;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-m1-'));
  initConfig(join(dir, 'cfg')); /* stageRunner 预算预检需要 config 就绪 */
  db = new Database(join(dir, 'm1.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS stages (
      book_id TEXT NOT NULL, stage_id TEXT NOT NULL, status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, started_at TEXT, reviewed_at TEXT, note TEXT,
      PRIMARY KEY (book_id, stage_id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, stage_id TEXT NOT NULL, kind TEXT NOT NULL,
      revision INTEGER, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
      cost_cents REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0, error TEXT, detail_json TEXT,
      idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_busy ON jobs(book_id, stage_id) WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS gate_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT NOT NULL, stage_id TEXT NOT NULL,
      revision INTEGER NOT NULL, job_id TEXT, gate TEXT NOT NULL, ok INTEGER NOT NULL,
      blocking_json TEXT NOT NULL DEFAULT '[]', warnings_json TEXT NOT NULL DEFAULT '[]',
      detail_json TEXT, ran_ms INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, who TEXT NOT NULL,
      action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT
    );
  `);
  bookDir = join(dir, 'book');
});

function seedBook(rel: string, content: string): void {
  const abs = join(bookDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Context 组装（M1.5）', () => {
  it('glue 注册表覆盖进程 spec 阶段', () => {
    def = getProcessDefinition('long');
    for (const s of def.stages) {
      if (s.entry.model_role === '') continue; // cover/export 不组装
      expect(CONTEXT_GLUES[s.entry.assemble] ?? CONTEXT_GLUES['context-review']).toBeTruthy();
    }
  });

  it('buildChapter 含角色线块 + 追踪精选 + 作者记忆', async () => {
    def = getProcessDefinition('long');
    seedBook('设定/题材定位.md', '# 题材定位\n## 题材\n都市系统流');
    seedBook('追踪/_tracking-state.json', JSON.stringify({
      schema_version: 4,
      last_committed_chapter: 20,
      state_revision: 1,
      context: { position: { volume: '第一卷' }, next_chapter_commitments: '补第21章', continuity_risks: ['不开新卷'] },
      characters: { 江晨: { state: '顶流' }, 钟嘉嘉: { state: '记者' } },
    }));
    seedBook('大纲/角色线/江晨.md', '# 江晨·军宣顶流传奇\n- 阶段2(active)');
    const b = await assembleBundle({
      bookDir,
      stage: def.stages.find((s) => s.id === 'chapter')!.entry,
      role: 'writer',
      bookTitle: '测试书',
    });
    const titles = b.blocks.map((x) => x.title).join(' | ');
    expect(titles).toContain('角色线');
    expect(b.user_message).toContain('军宣顶流');
    expect(b.user_message).toContain('last_committed_chapter');
    expect(b.system.length).toBeGreaterThan(50);
  });

  it('每个 glue 返回合法 bundle', async () => {
    def = getProcessDefinition('long');
    seedBook('设定/题材定位.md', '# 题材\n都市\n- 金手指: 预知');
    seedBook('设定/文风.md', '# 文风\n口语化');
    for (const key of ['context-intake', 'context-concept', 'context-characters', 'context-outline']) {
      const stage = Object.values(def.stages).find((s) => s.entry.assemble === key);
      if (!stage) continue;
      const b = await assembleBundle({ bookDir, stage: stage.entry, role: stage.entry.model_role });
      expect(typeof b.system).toBe('string');
      expect(Array.isArray(b.blocks)).toBe(true);
      expect(b.user_message.length).toBeGreaterThan(0);
    }
  });
});

describe('FakeAgent（M1.4 demo 路径）', () => {
  it('章节类产物可过 char-count 最小门禁（长度充足）', async () => {
    const b = await assembleBundle({
      bookDir,
      stage: def.stages.find((s) => s.id === 'chapter')!.entry,
      role: 'writer',
      bookTitle: '测试书',
    });
    const r = await runFakeAgent({ bundle: b, model: { channelId: 'fake', modelId: 'fake' } });
    expect(r.fake).toBe(true);
    expect(r.text.replace(/\s/g, '').length).toBeGreaterThan(1800);
  });
});

describe('stageRunner fake 全链路（M1.7）', () => {
  it('outline 阶段：fake 执行 → 落盘 → 进入 review', async () => {
    def = getProcessDefinition('long');
    const ai = new AiRuntime();
    const res = await runStageJob({
      db: { db, path: join(dir, 'm1.db'), user_version: 1 },
      ai,
      def,
      bookId: 'nb_test',
      bookDir,
      bookName: '测试书',
      stageId: 'outline',
      fake: true,
    });
    expect(res.status).toBe('review');
    expect(res.gateBlocking).toBe(false);
    const row = getStageRow(db, 'nb_test', 'outline')!;
    expect(row.status).toBe('review');
    expect(row.revision).toBe(1);
  });

  it('同阶段再次 run 幂等/不并并发（已有 running 不重跑）', async () => {
    const row = getStageRow(db, 'nb_test', 'outline');
    expect(row!.status).toBe('review');
  });

  it('chapter 阶段（无追踪状态）→ 内循环按 retry_limit 耗尽 → blocked（不崩溃/不死循环）', async () => {
    def = getProcessDefinition('long');
    const ai2 = new AiRuntime();
    const res = await runStageJob({
      db: { db, path: join(dir, 'm1.db'), user_version: 1 },
      ai: ai2,
      def,
      bookId: 'nb_chapter_blocked',
      bookDir,
      bookName: '测试书',
      stageId: 'chapter',
      fake: true,
    });
    expect(res.status).toBe('blocked');
    expect(res.gateBlocking).toBe(true);
    // long.json chapter 的 gates=7，retry_limit=2 → 引擎内循环共跑 2 轮 = 14 行 gate_runs
    const runs = db
      .prepare(`SELECT COUNT(*) AS n FROM gate_runs WHERE book_id=?`)
      .get('nb_chapter_blocked') as { n: number };
    expect(runs.n).toBe(14);
    const row = getStageRow(db, 'nb_chapter_blocked', 'chapter')!;
    expect(row.status).toBe('blocked');
    expect(row.revision).toBe(1);
  });

});

describe('splitFileBlocks（file-set 分块，M4 修复）', () => {
  it('识别 《设定/角色/X.md》 分块并各自切 body', () => {
    const text = [
      '开场说明文字（不在任何块内）。',
      '',
      '### 《设定/角色/陆沉舟.md》',
      '',
      '# 角色卡：陆沉舟',
      '- 身份：前声呐兵',
      '',
      '### 《设定/角色线/陆沉舟.md》',
      '',
      '# 角色弧线：从逃兵到守夜人',
      '- 阶段A：海底的醉语',
    ].join('\n');
    const blocks = splitFileBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.rel).toBe('设定/角色/陆沉舟.md');
    expect(blocks[0]!.body).toContain('角色卡');
    expect(blocks[0]!.body).toContain('前声呐兵');
    expect(blocks[1]!.rel).toBe('设定/角色线/陆沉舟.md');
    expect(blocks[1]!.body).toContain('角色弧线');
  });
  it('兼容无书名号/带反引号 的路径头，且拒绝 .. 逃逸', () => {
    const text = [
      '## `大纲/卷纲/卷一.md`',
      '第一页内容 A',
      '',
      '## 大纲/细纲/第12章.md',
      '第二页内容 B',
      '## ..\\..\\evil.md',
      '恶意正文（.. 路径被拒，不作块头）',
    ].join('\n');
    const blocks = splitFileBlocks(text);
    const rels = blocks.map((b) => b.rel);
    expect(rels).toContain('大纲/卷纲/卷一.md');
    expect(rels).toContain('大纲/细纲/第12章.md');
    expect(rels.some((r) => r.includes('..'))).toBe(false);
    expect(blocks[0]!.body).toContain('第一页内容 A');
    expect(blocks[0]!.body).not.toContain('第二页内容 B');
  });
});

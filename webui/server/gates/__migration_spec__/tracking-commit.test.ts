/**
 * Migration regression tests for `impl/tracking-commit.ts` (Node port of
 * skills/story-long-write/scripts/tracking_commit.py).  Self-contained: builds a
 * temp book dir with node:fs and exercises init/commit/check/arc-audit through both
 * the library exports and the `runTrackingCommit` CLI replica.  Node-only, no python.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runTrackingCommit,
  initializeTracking,
  applyTransaction,
  checkTracking,
  auditArcs,
  loadTrackingState,
  TrackingError,
  type TrackingIo,
  type TrackingState,
} from '../impl/tracking-commit.ts';

/* ---------------------------------------------------------------------------
 * Fixtures (mirror scripts/test-tracking-commit.py exactly)
 * ------------------------------------------------------------------------- */

const BOOK_TITLE = '让你管账号，你高燃混剪炸全网';

interface FixturePosition {
  volume: string;
  volume_start_chapter: number;
  story_time: string;
  scene: string;
}

function position(value: { volume?: string; start?: number } = {}): FixturePosition {
  return {
    volume: value.volume ?? '第一卷·军宣整顿',
    volume_start_chapter: value.start ?? 1,
    story_time: '实弹训练两天后',
    scene: '火箭军文工团高层看片会',
  };
}

function snapshot(value: { state?: string; items?: number; repeat?: number } = {}): Record<string, unknown> {
  const state = value.state ?? '军内认可继续抬升';
  const items = value.items ?? 1;
  const repeat = value.repeat ?? 1;
  const phrases: Record<string, string> = {
    abilities_resources: '老兵采访授权与军宣制作资源仍需继续使用',
    relationships: '与钟嘉嘉及文工团的协作关系影响下一阶段决策',
    knowledge: '已经确认军宣流程和作品传播结果',
    open_threads: '尚未回收的培养安排与作品计划仍需推进',
  };
  const fields: Record<string, string[]> = {};
  for (const [field, phrase] of Object.entries(phrases)) {
    fields[field] = Array.from({ length: items }, (_, index) => `第${index + 1}项：${phrase.repeat(repeat)}`);
  }
  return {
    identity: '火箭军文工团宣传兵',
    location: '火箭军文工团高层看片会',
    goal: '完成五天百万粉任务',
    state,
    ...fields,
  };
}

function initialDocument(value: { lastChapter?: number } = {}): Record<string, unknown> {
  const lastChapter = value.lastChapter ?? 0;
  const recent: { chapter: number; summary: string }[] = [];
  for (let chapter = Math.max(1, lastChapter - 2); chapter <= lastChapter; chapter++) {
    recent.push({ chapter, summary: `第${chapter}章军宣账号继续扩大影响。` });
  }
  return {
    schema_version: 1,
    book_title: BOOK_TITLE,
    last_chapter: lastChapter,
    context: {
      position: position(),
      long_term_constraints: ['军方培养江晨的后续安排尚未向读者揭示。'],
      active_character_names: [],
      continuity_risks: [],
      recent_chapters: recent,
      next_chapter_commitments: lastChapter ? ['推进五天百万粉任务。'] : [],
    },
    character_snapshots: {},
    foreshadow: [],
    timeline_events: [],
  };
}

function transaction(
  chapter: number,
  value: {
    mode?: 'append' | 'revision';
    character?: boolean;
    foreshadow?: boolean;
    timeline?: boolean;
    next_commitment?: string;
  } = {},
): Record<string, unknown> {
  const mode = value.mode ?? 'append';
  const character = value.character ?? false;
  const foreshadow = value.foreshadow ?? false;
  const timeline = value.timeline ?? false;
  const nextCommitment = value.next_commitment ?? '结算百万粉任务并承接老兵主题。';
  const characterChanges = character ? [{ name: '江晨', change: '作品价值获军内高层确认' }] : [];
  const foreshadowChanges = foreshadow
    ? [
        {
          action: 'upsert',
          id: 'F027',
          summary: '专业团队仍拍不出江晨原版的灵魂。',
          planted_chapter: chapter,
          planned_resolution_chapter: chapter + 8,
          status: '已埋',
          importance: '高',
        },
      ]
    : [];
  const timelineEvents = timeline
    ? [
        {
          action: 'upsert',
          id: 'E010',
          story_time: '实弹训练两天后',
          objective_fact: '军方培养江晨另有尚未公开的后续安排。',
          reader_knowledge: '读者只知道专业重拍版被否决，不知道后续培养安排。',
          reveal_status: '未揭示',
          reveal_chapter: null,
          characters: ['江晨', '钟嘉嘉'],
        },
      ]
    : [];
  return {
    schema_version: 1,
    mode,
    chapter,
    chapter_title: `军宣爆款·${chapter}`,
    delta: {
      result: `江晨在第${chapter}章继续扩大军宣作品影响力。`,
      character_changes: characterChanges,
      foreshadow_changes: foreshadowChanges,
      timeline_events: timelineEvents,
      constraints: [],
      next_chapter_commitments: [nextCommitment],
    },
    context: {
      position: position(),
      long_term_constraints: ['军方培养江晨的后续安排尚未向读者揭示。'],
      active_character_names: character ? ['江晨'] : [],
      continuity_risks: [],
    },
    character_snapshots: character ? { 江晨: snapshot() } : {},
  };
}

function arcLineSpec(value: { name?: string; summary?: string } = {}): Record<string, unknown> {
  return {
    line_kind: '角色',
    summary: value.summary ?? '自我价值觉醒，LIE=我不配 → TRUTH=允许被需要',
    stages: [
      { name: '戒备①微暖', planned_chapters: '第1-8章' },
      { name: '微暖①依赖', planned_chapters: '第9-30章' },
      { name: '依赖①信任', planned_chapters: '第31-60章' },
    ],
  };
}

function transactionWithArc(
  chapter: number,
  value: {
    mode?: 'append' | 'revision';
    advances?: unknown[];
    registrations?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const document = transaction(chapter, { mode: value.mode });
  (document.delta as Record<string, unknown>).arc_advances = value.advances ?? [];
  if (value.registrations) {
    (document as Record<string, unknown>).arcs = value.registrations;
  }
  return document;
}

function initialWithArc(value: { lastChapter?: number } = {}): Record<string, unknown> {
  const document = initialDocument(value);
  (document as Record<string, unknown>).arcs = { 沈栀: arcLineSpec() };
  return document;
}

/* ---------------------------------------------------------------------------
 * Host helpers
 * ------------------------------------------------------------------------- */

interface Host {
  dir: string;
  book: string;
  stateFile: string;
  inputs: string;
  txCounter: number;
}

function makeBook(seed: string): Host {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-${seed}-`));
  const book = path.join(dir, BOOK_TITLE);
  fs.mkdirSync(book, { recursive: true });
  return { dir, book, stateFile: path.join(book, '追踪/_tracking-state.json'), inputs: path.join(dir, 'inputs'), txCounter: 0 };
}

function writeInput(h: Host, document: unknown): string {
  h.txCounter += 1;
  fs.mkdirSync(h.inputs, { recursive: true });
  const inputPath = path.join(h.inputs, `tx-${h.txCounter}.json`);
  fs.writeFileSync(inputPath, JSON.stringify(document), 'utf8');
  return inputPath;
}

function stateFrom(h: Host): TrackingState {
  return JSON.parse(fs.readFileSync(h.stateFile, 'utf8')) as TrackingState;
}

function revisionOf(h: Host): number {
  return stateFrom(h).state_revision;
}

/** Run a document through the CLI replica (init/commit), printing to stdout; returns result. */
async function cliInit(h: Host, io?: TrackingIo): Promise<{ code: number; stdout: string; stderr: string }> {
  const input = writeInput(h, initialDocument());
  const result = await runTrackingCommit(['init', '--project', h.book, '--input', input], h.dir);
  if (io) {
    for (const line of result.stderr.split('\n').filter((l) => l.length > 0)) io.stderr(line);
  }
  return result;
}

const quietIo: TrackingIo = { stderr: () => {} };

let hosts: Host[] = [];

afterAll(() => {
  for (const h of hosts) {
    try {
      fs.rmSync(h.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/* ---------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------- */

describe('tracking-commit (Node port)', () => {
  it('init creates one structured authority and only derived views; check passes', async () => {
    const h = makeBook('init');
    hosts.push(h);
    const result = await cliInit(h);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ last_committed_chapter: 0, state_revision: 0 });

    const state = stateFrom(h);
    expect(state.schema_version).toBe(4);
    expect(state.state_revision).toBe(0);
    expect(state.characters).toEqual({});
    expect(state.foreshadow).toEqual({});
    expect(state.timeline).toEqual({});
    expect(fs.existsSync(path.join(h.book, '追踪/_tracking-meta.json'))).toBe(false);
    expect(fs.existsSync(path.join(h.book, '追踪/时间线/事件库.json'))).toBe(false);
    const context = fs.readFileSync(path.join(h.book, '追踪/上下文.md'), 'utf8');
    expect(context).toContain('状态修订：0');
    // 7-section fixed schema
    expect(context).toContain('## 当前位置');
    expect(context).toContain('## 长期约束');
    expect(context).toContain('## 核心角色状态');
    expect(context).toContain('## 活跃伏笔');
    expect(context).toContain('## 近三章速记');
    expect(context).toContain('## 下一章承诺');
    expect(context).toContain('## 连贯性风险');
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('commit updates state and all derived views (character/foreshadow/timeline)', async () => {
    const h = makeBook('commit');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    const doc = transaction(1, { character: true, foreshadow: true, timeline: true });
    doc.expected_state_revision = 0;
    const next = applyTransaction(h.book, doc, quietIo);
    expect(next.last_committed_chapter).toBe(1);
    expect(next.state_revision).toBe(1);

    const state = stateFrom(h);
    expect(state.last_committed_chapter).toBe(1);
    expect(state.state_revision).toBe(1);
    expect(state.characters['江晨']).toBeDefined();
    expect(state.foreshadow['F027']).toBeDefined();
    expect(state.timeline['E010']).toBeDefined();

    const context = fs.readFileSync(path.join(h.book, '追踪/上下文.md'), 'utf8');
    expect(context).toContain('状态修订：1');
    expect(context).toContain('F027｜专业团队仍拍不出江晨原版的灵魂');
    const author = fs.readFileSync(path.join(h.book, '追踪/时间线/作者真相.md'), 'utf8');
    expect(author).toContain('军方培养江晨另有尚未公开的后续安排');
    const reader = fs.readFileSync(path.join(h.book, '追踪/时间线/读者已知.md'), 'utf8');
    expect(reader).not.toContain('军方培养江晨另有尚未公开的后续安排');
    expect(fs.existsSync(path.join(h.book, '追踪/逐章记录/第001章.md'))).toBe(true);
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('append sequencing and revision range are enforced before any write', async () => {
    const h = makeBook('seq');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    // append chapter 2 when last is 0
    const bad = transaction(2);
    bad.expected_state_revision = 0;
    expect(() => applyTransaction(h.book, bad, quietIo)).toThrow(/append chapter must be 1, got 2/);
    expect(revisionOf(h)).toBe(0);
    expect(fs.existsSync(path.join(h.book, '追踪/逐章记录/第002章.md'))).toBe(false);

    // revision of an unwritten chapter
    const rev = transaction(1, { mode: 'revision' });
    rev.expected_state_revision = 0;
    expect(() => applyTransaction(h.book, rev, quietIo)).toThrow(/cannot revise unwritten chapter 1; last committed chapter is 0/);

    // stale expected revision
    applyTransaction(h.book, Object.assign(transaction(1), { expected_state_revision: 0 }), quietIo);
    const stale = transaction(1, { mode: 'revision' });
    stale.expected_state_revision = 0 ; // already advanced to 1
    expect(() => applyTransaction(h.book, stale, quietIo)).toThrow(/tracking state changed since this transaction was prepared/);
    expect(revisionOf(h)).toBe(1);
  });
  it('snapshot lists are not limited to eight items; target warns; hard cap rejects before any write', () => {
    const h = makeBook('snap');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);

    const wide = transaction(1, { character: true });
    (wide.character_snapshots as Record<string, unknown>)['江晨'] = snapshot({ items: 12 });
    applyTransaction(h.book, Object.assign(wide, { expected_state_revision: 0 }), quietIo);
    expect(revisionOf(h)).toBe(1);
    expect((stateFrom(h).characters['江晨'] as unknown as { relationships: unknown[] }).relationships.length).toBe(12);

    const warned: string[] = [];
    const warnIo: TrackingIo = { stderr: (l) => warned.push(l) };
    const warning = transaction(2, { character: true });
    (warning.character_snapshots as Record<string, unknown>)['江晨'] = snapshot({ items: 12, repeat: 2 });
    applyTransaction(h.book, Object.assign(warning, { expected_state_revision: 1 }), warnIo);
    expect(warned.some((l) => l.includes('WARNING: character snapshot 江晨'))).toBe(true);
    expect(revisionOf(h)).toBe(2);

    const rejected = transaction(3, { character: true });
    (rejected.character_snapshots as Record<string, unknown>)['江晨'] = snapshot({ items: 24, repeat: 4 });
    const before = JSON.stringify(stateFrom(h));
    let message = '';
    try {
      applyTransaction(h.book, Object.assign(rejected, { expected_state_revision: 2 }), quietIo);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('exceeds hard cap of 8192 bytes');
    expect(JSON.stringify(stateFrom(h))).toBe(before);
    expect(fs.existsSync(path.join(h.book, '追踪/逐章记录/第003章.md'))).toBe(false);
  });

  it('missing active snapshot is rejected before any write', () => {
    const h = makeBook('active');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    const doc = transaction(1);
    (doc.context as Record<string, unknown>).active_character_names = ['不存在的核心角色'];
    doc.expected_state_revision = 0;
    try {
      applyTransaction(h.book, doc, quietIo);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TrackingError);
      expect((err as Error).message).toContain('has no current snapshot');
    }
    expect(revisionOf(h)).toBe(0);
    expect(fs.existsSync(path.join(h.book, '追踪/逐章记录/第001章.md'))).toBe(false);
  });

  it('retiring a core character removes its derived view and records it in the delta', () => {
    const h = makeBook('retire');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    applyTransaction(h.book, Object.assign(transaction(1, { character: true }), { expected_state_revision: 0 }), quietIo);
    expect(fs.existsSync(path.join(h.book, '追踪/角色状态/江晨.md'))).toBe(true);

    const retire = transaction(2);
    (retire.delta as Record<string, unknown>).retired_characters = ['江晨'];
    applyTransaction(h.book, Object.assign(retire, { expected_state_revision: 1 }), quietIo);

    const state = stateFrom(h);
    expect(state.characters['江晨']).toBeUndefined();
    expect(fs.existsSync(path.join(h.book, '追踪/角色状态/江晨.md'))).toBe(false);
    expect(fs.readFileSync(path.join(h.book, '追踪/逐章记录/第002章.md'), 'utf8')).toContain('角色状态：江晨');
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('a character can die and retire in one transaction (still marked core in the delta)', () => {
    const h = makeBook('die');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    applyTransaction(h.book, Object.assign(transaction(1, { character: true }), { expected_state_revision: 0 }), quietIo);
    const farewell = transaction(2);
    (farewell.delta as Record<string, unknown>).character_changes = [
      { name: '江晨', change: '在最终一战中阵亡，彻底退场' },
    ];
    (farewell.delta as Record<string, unknown>).retired_characters = ['江晨'];
    applyTransaction(h.book, Object.assign(farewell, { expected_state_revision: 1 }), quietIo);

    const record = fs.readFileSync(path.join(h.book, '追踪/逐章记录/第002章.md'), 'utf8');
    expect(record).toContain('江晨｜核心｜在最终一战中阵亡，彻底退场');
    expect(record).toContain('角色状态：江晨');
    expect(stateFrom(h).characters['江晨']).toBeUndefined();
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('retirement and context drops are rejected in a revision', () => {
    const h = makeBook('reveretire');
    hosts.push(h);
    initializeTracking(h.book, initialDocument({ lastChapter: 20 }), quietIo);

    const retire = transaction(10, { mode: 'revision' });
    (retire.delta as Record<string, unknown>).retired_characters = ['江晨'];
    retire.expected_state_revision = 0;
    let msg = '';
    try {
      applyTransaction(h.book, retire, quietIo);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('append transaction');

    const drop = transaction(10, { mode: 'revision' });
    (drop.context as Record<string, unknown>).long_term_constraints = [];
    (drop.delta as Record<string, unknown>).retired_context_items = ['军方培养江晨的后续安排尚未向读者揭示。'];
    drop.expected_state_revision = 0;
    msg = '';
    try {
      applyTransaction(h.book, drop, quietIo);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/a revision must resubmit every current context item/);
    expect(revisionOf(h)).toBe(0);
  });

  it('retiring a still-active character is rejected', () => {
    const h = makeBook('stillactive');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    applyTransaction(h.book, Object.assign(transaction(1, { character: true }), { expected_state_revision: 0 }), quietIo);
    const conflict = transaction(2, { character: true });
    (conflict.delta as Record<string, unknown>).retired_characters = ['江晨'];
    conflict.expected_state_revision = 1;
    let msg = '';
    try {
      applyTransaction(h.book, conflict, quietIo);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('江晨');
    expect(revisionOf(h)).toBe(1);
  });

  it('dropping a context item without declaring it is rejected; declared retirement is recorded', () => {
    const h = makeBook('context');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);

    const silent = transaction(1);
    (silent.context as Record<string, unknown>).long_term_constraints = [];
    silent.expected_state_revision = 0;
    let msg = '';
    try {
      applyTransaction(h.book, silent, quietIo);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('retired_context_items');
    expect(revisionOf(h)).toBe(0);
    expect(fs.existsSync(path.join(h.book, '追踪/逐章记录/第001章.md'))).toBe(false);

    const declared = transaction(1);
    (declared.context as Record<string, unknown>).long_term_constraints = [];
    (declared.delta as Record<string, unknown>).retired_context_items = ['军方培养江晨的后续安排尚未向读者揭示。'];
    applyTransaction(h.book, Object.assign(declared, { expected_state_revision: 0 }), quietIo);
    expect(stateFrom(h).context.long_term_constraints).toEqual([]);
    const deltaText = fs.readFileSync(path.join(h.book, '追踪/逐章记录/第001章.md'), 'utf8');
    expect(deltaText).toContain('## 本章退役登记');
    expect(deltaText).toContain('军方培养江晨的后续安排尚未向读者揭示。');
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('revision preserves the current next-chapter commitment and does not move updated_chapter back', () => {
    const h = makeBook('oldrev');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    applyTransaction(h.book, Object.assign(transaction(1, { next_commitment: '让专业团队进场重拍。', foreshadow: true, timeline: true }), { expected_state_revision: 0 }), quietIo);
    const chapterTwo = transaction(2, { foreshadow: true, timeline: true });
    (chapterTwo.delta as Record<string, unknown>).foreshadow_changes = [
      { action: 'upsert', id: 'F027', summary: '专业版缺少灵魂的判断已经由高层拍板兑现。', planted_chapter: 1, planned_resolution_chapter: 2, status: '已回收', importance: '高' },
    ];
    (chapterTwo.delta as Record<string, unknown>).timeline_events = [
      { action: 'upsert', id: 'E010', story_time: '实弹训练两天后', objective_fact: '军方培养江晨另有尚未公开的后续安排。', reader_knowledge: '读者已经看到张耀祖采用江晨原版。', reveal_status: '已揭示', reveal_chapter: 2, characters: ['江晨'] },
    ];
    applyTransaction(h.book, Object.assign(chapterTwo, { expected_state_revision: 1 }), quietIo);
    applyTransaction(h.book, Object.assign(transaction(3, { next_commitment: '结算五天百万粉任务。' }), { expected_state_revision: 2 }), quietIo);

    const revision = transaction(1, { mode: 'revision', foreshadow: true, timeline: true });
    revision.delta = {
      result: '江晨在第1章继续扩大军宣作品影响力。',
      character_changes: [],
      foreshadow_changes: [
        { action: 'upsert', id: 'F027', summary: '专业版缺少灵魂的判断已经由高层拍板兑现。', planted_chapter: 1, planned_resolution_chapter: 2, status: '已回收', importance: '高' },
      ],
      timeline_events: [
        { action: 'upsert', id: 'E010', story_time: '实弹训练两天后', objective_fact: '军方培养江晨另有尚未公开的后续安排。', reader_knowledge: '读者已经看到张耀祖采用江晨原版。', reveal_status: '已揭示', reveal_chapter: 2, characters: ['江晨'] },
      ],
      constraints: [],
      next_chapter_commitments: ['修订章当时的旧承诺。'],
    };
    applyTransaction(h.book, Object.assign(revision, { expected_state_revision: 3 }), quietIo);

    const context = fs.readFileSync(path.join(h.book, '追踪/上下文.md'), 'utf8');
    expect(context).toContain('结算五天百万粉任务');
    expect(context).not.toContain('修订章当时的旧承诺');
    const state = stateFrom(h);
    expect(state.foreshadow.F027!.updated_chapter).toBe(2);
    expect(state.timeline.E010!.updated_chapter).toBe(2);
    expect(checkTracking(h.book)).toBeDefined();
  });
});
describe('tracking-commit (Node port) — part 2', () => {
  it('check compares derived views without parsing markdown and catches orphan files', async () => {
    const h = makeBook('checkview');
    hosts.push(h);
    await cliInit(h);
    applyTransaction(h.book, Object.assign(transaction(1, { character: true, foreshadow: true, timeline: true }), { expected_state_revision: 0 }), quietIo);

    const viewPath = path.join(h.book, '追踪/角色状态/江晨.md');
    fs.writeFileSync(viewPath, '# 任意手改格式\n', 'utf8');
    let msg = '';
    try {
      checkTracking(h.book);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('derived view differs from _tracking-state.json');

    applyTransaction(h.book, Object.assign(transaction(2), { expected_state_revision: 1 }), quietIo);
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('check rejects an orphan character file', async () => {
    const h = makeBook('orphan');
    hosts.push(h);
    await cliInit(h);
    fs.writeFileSync(path.join(h.book, '追踪/角色状态/CONFLICT.md'), '# orphan\n', 'utf8');
    let msg = '';
    try {
      checkTracking(h.book);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('character snapshot files differ');
  });

  it('commit and check refuse a retired layout', async () => {
    const h = makeBook('retiredlayout');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    fs.writeFileSync(path.join(h.book, '追踪/时间线.md'), '# 旧时间线\n', 'utf8');
    let msg = '';
    try {
      checkTracking(h.book);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('retired tracking files');
    const doc = transaction(1);
    doc.expected_state_revision = 0;
    msg = '';
    try {
      applyTransaction(h.book, doc, quietIo);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('retired tracking files');
    expect(revisionOf(h)).toBe(0);
  });

  it('init archives a pre-transaction tracking directory and never clobbers an archived file', () => {
    const h = makeBook('archive');
    hosts.push(h);
    const tracking = path.join(h.book, '追踪');
    fs.mkdirSync(tracking, { recursive: true });
    fs.writeFileSync(path.join(tracking, '角色状态.md'), '# 旧角色状态\n', 'utf8');
    fs.writeFileSync(path.join(tracking, '时间线.md'), '# 旧时间线\n', 'utf8');
    fs.writeFileSync(path.join(tracking, '_tracking-meta.json'), '{}\n', 'utf8');

    const warnings: string[] = [];
    const warnIo: TrackingIo = { stderr: (l) => warnings.push(l) };
    initializeTracking(h.book, initialDocument(), warnIo);
    expect(warnings.join('\n')).toContain('_旧追踪存档');
    const archive = path.join(tracking, '_旧追踪存档');
    expect(fs.readFileSync(path.join(archive, '角色状态.md'), 'utf8')).toBe('# 旧角色状态\n');
    expect(fs.readFileSync(path.join(archive, '时间线.md'), 'utf8')).toBe('# 旧时间线\n');
    expect(fs.existsSync(path.join(tracking, '角色状态.md'))).toBe(false);
    expect(fs.statSync(path.join(tracking, '角色状态')).isDirectory()).toBe(true);
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('archive never clobbers an already archived file', () => {
    const h = makeBook('noclobber');
    hosts.push(h);
    const tracking = path.join(h.book, '追踪');
    fs.mkdirSync(path.join(tracking, '_旧追踪存档'), { recursive: true });
    fs.writeFileSync(path.join(tracking, '角色状态.md'), '现役\n', 'utf8');
    fs.writeFileSync(path.join(tracking, '_旧追踪存档/角色状态.md'), '存档\n', 'utf8');
    let msg = '';
    try {
      initializeTracking(h.book, initialDocument(), quietIo);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('already exists');
    expect(fs.readFileSync(path.join(tracking, '角色状态.md'), 'utf8')).toBe('现役\n');
    expect(fs.readFileSync(path.join(tracking, '_旧追踪存档/角色状态.md'), 'utf8')).toBe('存档\n');
  });

  it('failed init leaves the old tracking directory untouched; interrupted archive can resume', async () => {
    const h = makeBook('failedinit');
    hosts.push(h);
    const tracking = path.join(h.book, '追踪');
    fs.mkdirSync(tracking, { recursive: true });
    fs.writeFileSync(path.join(tracking, '角色状态.md'), '# 旧角色状态\n', 'utf8');
    const invalid = initialDocument();
    (invalid as Record<string, unknown>).baseline = {};
    const result = await runTrackingCommit(['init', '--project', h.book, '--input', writeInput(h, invalid)], h.dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unsupported fields');
    expect(fs.existsSync(path.join(tracking, '角色状态.md'))).toBe(true);
    expect(fs.existsSync(path.join(tracking, '_旧追踪存档'))).toBe(false);

    // interrupted archive resume
    const h2 = makeBook('resume');
    hosts.push(h2);
    const t2 = path.join(h2.book, '追踪');
    fs.mkdirSync(path.join(t2, '_旧追踪存档'), { recursive: true });
    fs.writeFileSync(path.join(t2, '角色状态.md'), '# 未搬完\n', 'utf8');
    fs.writeFileSync(path.join(t2, '_旧追踪存档/时间线.md'), '# 上次已搬\n', 'utf8');
    const r2 = await runTrackingCommit(['init', '--project', h2.book, '--input', writeInput(h2, initialDocument())], h2.dir);
    expect(r2.code).toBe(0);
    expect(fs.readFileSync(path.join(t2, '_旧追踪存档/角色状态.md'), 'utf8')).toBe('# 未搬完\n');
    expect(fs.readFileSync(path.join(t2, '_旧追踪存档/时间线.md'), 'utf8')).toBe('# 上次已搬\n');
  });

  it('windows-reserved character name is rejected; unknown fields are rejected', () => {
    const h = makeBook('reserved');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    const invalid = transaction(1, { character: true });
    (invalid.delta as Record<string, unknown>).character_changes = [{ name: 'CON', change: 'x' }];
    (invalid.character_snapshots as Record<string, unknown>) = { CON: { ...(snapshot() as object) } };
    invalid.expected_state_revision = 0;
    let msg = '';
    try {
      applyTransaction(h.book, invalid, quietIo);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('reserved on Windows');
    expect(revisionOf(h)).toBe(0);
  });

  it('unknown init/state fields are rejected', async () => {
    const h = makeBook('unknown');
    hosts.push(h);
    const invalid = initialDocument();
    (invalid as Record<string, unknown>).baseline = {};
    const result = await runTrackingCommit(['init', '--project', h.book, '--input', writeInput(h, invalid)], h.dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unsupported fields');

    await cliInit(h);
    const state = stateFrom(h) as unknown as Record<string, unknown>;
    state.status = 'clean';
    fs.writeFileSync(h.stateFile, JSON.stringify(state), 'utf8');
    const checkResult = await runTrackingCommit(['check', '--project', h.book], h.dir);
    expect(checkResult.code).toBe(2);
    expect(checkResult.stderr).toContain('unsupported fields');
  });

  it('init never overwrites existing project state', async () => {
    const h = makeBook('twice');
    hosts.push(h);
    await cliInit(h);
    const result = await runTrackingCommit(['init', '--project', h.book, '--input', writeInput(h, initialDocument())], h.dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('already exists');
    expect(revisionOf(h)).toBe(0);
  });

  it('imported cutoff requires only new daily records; imported revisions create overlay records', () => {
    const h = makeBook('imported');
    hosts.push(h);
    initializeTracking(h.book, initialDocument({ lastChapter: 27 }), quietIo);
    applyTransaction(h.book, Object.assign(transaction(28, { character: true }), { expected_state_revision: 0 }), quietIo);
    expect(fs.existsSync(path.join(h.book, '追踪/逐章记录/第027章.md'))).toBe(false);
    expect(fs.existsSync(path.join(h.book, '追踪/逐章记录/第028章.md'))).toBe(true);
    expect(stateFrom(h).imported_through_chapter).toBe(27);

    const h2 = makeBook('importedrev');
    hosts.push(h2);
    initializeTracking(h2.book, initialDocument({ lastChapter: 20 }), quietIo);
    applyTransaction(h2.book, Object.assign(transaction(10, { mode: 'revision' }), { expected_state_revision: 0 }), quietIo);
    expect(fs.existsSync(path.join(h2.book, '追踪/逐章记录/第010章.md'))).toBe(true);
    expect(stateFrom(h2).imported_through_chapter).toBe(20);
    expect(checkTracking(h2.book)).toBeDefined();
  });

  it('second identical commit leaves unchanged files untouched (write_if_changed)', () => {
    const h = makeBook('stable');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    applyTransaction(h.book, Object.assign(transaction(1), { expected_state_revision: 0 }), quietIo);
    applyTransaction(h.book, Object.assign(transaction(2, { character: true, foreshadow: true }), { expected_state_revision: 1 }), quietIo);

    const deltaPathStr = path.join(h.book, '追踪/逐章记录/第002章.md');
    const beforeContent = fs.readFileSync(deltaPathStr, 'utf8');
    const beforeMtime = fs.statSync(deltaPathStr).mtimeMs;

    const revision = transaction(2, { mode: 'revision', character: true, foreshadow: true });
    revision.expected_state_revision = 2;
    applyTransaction(h.book, revision, quietIo);

    expect(revisionOf(h)).toBe(3);
    const afterContent = fs.readFileSync(deltaPathStr, 'utf8');
    expect(afterContent).toBe(beforeContent);
    expect(fs.statSync(deltaPathStr).mtimeMs).toBe(beforeMtime);
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('a failure during view/delta write leaves the state authority untouched and the same transaction can retry', async () => {
    const h = makeBook('atomic');
    hosts.push(h);
    await cliInit(h);
    await runTrackingCommit(['commit', '--project', h.book, '--input', writeInput(h, Object.assign(transaction(1), { expected_state_revision: 0 }))], h.dir);

    // Block the delta path with a directory so the atomic rename fails mid-transaction.
    const blocker = path.join(h.book, '追踪/逐章记录/第002章.md');
    fs.mkdirSync(blocker, { recursive: true });
    fs.writeFileSync(path.join(blocker, 'marker.txt'), 'x', 'utf8');

    const failed = await runTrackingCommit(['commit', '--project', h.book, '--input', writeInput(h, Object.assign(transaction(2), { expected_state_revision: 1 }))], h.dir);
    expect(failed.code).toBe(2);
    expect(failed.stderr.startsWith('ERROR: ')).toBe(true);
    expect(revisionOf(h)).toBe(1); // state authority untouched
    expect(fs.existsSync(path.join(h.book, '追踪/逐章记录/第002章.md/marker.txt'))).toBe(true);

    // Remove the blocker; the same transaction now succeeds.
    fs.rmSync(blocker, { recursive: true, force: true });
    const retry = await runTrackingCommit(['commit', '--project', h.book, '--input', writeInput(h, Object.assign(transaction(2), { expected_state_revision: 1 }))], h.dir);
    expect(retry.code).toBe(0);
    expect(revisionOf(h)).toBe(2);
    expect(fs.existsSync(path.join(h.book, '追踪/逐章记录/第002章.md'))).toBe(true);
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('CLI contract: compact JSON on init/commit/check, full JSON for arc-audit, ERROR + code 2 on failure', async () => {
    const h = makeBook('cli');
    hosts.push(h);
    const init = await cliInit(h);
    expect(init.stdout).toBe('{"last_committed_chapter":0,"state_revision":0}\n');

    const commit = await runTrackingCommit(['commit', '--project', h.book, '--input', writeInput(h, Object.assign(transaction(1), { expected_state_revision: 0 }))], h.dir);
    expect(commit.code).toBe(0);
    expect(commit.stdout).toBe('{"last_committed_chapter":1,"state_revision":1}\n');

    const check = await runTrackingCommit(['check', '--project', h.book], h.dir);
    expect(check.code).toBe(0);
    expect(check.stdout).toBe('{"last_committed_chapter":1,"state_revision":1}\n');

    // validation failure -> ERROR on stderr, nothing on stdout, code 2
    const bad = transaction(2);
    bad.expected_state_revision = 0;
    const failed = await runTrackingCommit(['commit', '--project', h.book, '--input', writeInput(h, bad)], h.dir);
    expect(failed.code).toBe(2);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toMatch(/^ERROR: /);

    // arc-audit prints the full report JSON (parseable)
    const audit = await runTrackingCommit(['arc-audit', '--project', h.book], h.dir);
    expect(audit.code).toBe(0);
    const report = JSON.parse(audit.stdout);
    expect(report.book_title).toBe(BOOK_TITLE);
    expect(report.last_committed_chapter).toBe(1);
    expect(report.state_revision).toBe(1);
    expect(report.arc_lines).toEqual({});
  });

  it('arc registration, advancement, rejection matrix, completion, and audit report', () => {
    const h = makeBook('arcs');
    hosts.push(h);
    initializeTracking(h.book, initialWithArc(), quietIo);
    let state = stateFrom(h);
    expect(state.arcs['沈栀']!.current_stage).toBe(1);
    expect(state.arcs['沈栀']!.evidence).toEqual({});
    expect(state.arcs['沈栀']!.stages!).toEqual((arcLineSpec().stages as unknown[]).map((s) => s));
    const view1 = fs.readFileSync(path.join(h.book, '追踪/角色线/沈栀.md'), 'utf8');
    expect(view1).toContain('阶段 1/3');
    expect(view1).toContain('进行中');
    expect(view1).not.toContain('已完结');

    applyTransaction(h.book, Object.assign(transactionWithArc(1), { expected_state_revision: 0 }), quietIo);
    applyTransaction(
      h.book,
      Object.assign(transactionWithArc(2, { advances: [{ line: '沈栀', stage: 1, evidence_anchor: '第2章『……也行吧』' }] }), {
        expected_state_revision: 1,
      }),
      quietIo,
    );
    state = stateFrom(h);
    expect(state.arcs['沈栀']!.current_stage).toBe(2);
    expect(state.arcs['沈栀']!.evidence['1']).toEqual({ chapter: 2, anchor: '第2章『……也行吧』' });

    applyTransaction(h.book, Object.assign(transactionWithArc(3), { expected_state_revision: 2 }), quietIo);
    applyTransaction(
      h.book,
      Object.assign(transactionWithArc(4, { advances: [{ line: '沈栀', stage: 2, evidence_anchor: '第4章第一次主动求助' }] }), {
        expected_state_revision: 3,
      }),
      quietIo,
    );
    applyTransaction(h.book, Object.assign(transactionWithArc(5), { expected_state_revision: 4 }), quietIo);
    applyTransaction(
      h.book,
      Object.assign(transactionWithArc(6, { advances: [{ line: '沈栀', stage: 3, evidence_anchor: '第6章主动说出秘密' }] }), {
        expected_state_revision: 5,
      }),
      quietIo,
    );
    state = stateFrom(h);
    expect(state.arcs['沈栀']!.current_stage).toBeNull();
    const view = fs.readFileSync(path.join(h.book, '追踪/角色线/沈栀.md'), 'utf8');
    expect(view).toContain('已完结');
    expect(view).toContain('第6章｜第6章主动说出秘密');

    const audit = auditArcs(h.book, quietIo);
    expect(audit.arc_lines['沈栀']!.status).toBe('completed');
    expect(audit.arc_lines['沈栀']!.total_stages).toBe(3);
    expect(audit.arc_lines['沈栀']!.achieved_stages).toBe(3);
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('arc advance rejection matrix (skip / unregistered / empty anchor / after completion / revision)', () => {
    const h = makeBook('arcmatrix');
    hosts.push(h);
    initializeTracking(h.book, initialWithArc(), quietIo);
    applyTransaction(h.book, Object.assign(transactionWithArc(1), { expected_state_revision: 0 }), quietIo);
    applyTransaction(
      h.book,
      Object.assign(transactionWithArc(2, { advances: [{ line: '沈栀', stage: 1, evidence_anchor: '第2章『……也行吧』' }] }), {
        expected_state_revision: 1,
      }),
      quietIo,
    );
    expect(revisionOf(h)).toBe(2);

    const expectError = (doc: Record<string, unknown>, pattern: RegExp) => {
      let msg = '';
      try {
        applyTransaction(h.book, Object.assign(doc, { expected_state_revision: revisionOf(h) }), quietIo);
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toMatch(pattern);
    };

    expectError(transactionWithArc(3, { advances: [{ line: '沈栀', stage: 3, evidence_anchor: '想跳过' }] }), /can only advance its active stage/);
    expectError(transactionWithArc(3, { advances: [{ line: '不存在', stage: 1, evidence_anchor: 'x' }] }), /is not registered/);
    expectError(transactionWithArc(3, { advances: [{ line: '沈栀', stage: 2, evidence_anchor: '' }] }), /must not be empty/);

    // advance to completion, then a further advance is rejected
    applyTransaction(h.book, Object.assign(transactionWithArc(3), { expected_state_revision: 2 }), quietIo);
    applyTransaction(
      h.book,
      Object.assign(transactionWithArc(4, { advances: [{ line: '沈栀', stage: 2, evidence_anchor: '依赖' }] }), {
        expected_state_revision: 3,
      }),
      quietIo,
    );
    applyTransaction(h.book, Object.assign(transactionWithArc(5), { expected_state_revision: 4 }), quietIo);
    applyTransaction(
      h.book,
      Object.assign(transactionWithArc(6, { advances: [{ line: '沈栀', stage: 3, evidence_anchor: '信任' }] }), {
        expected_state_revision: 5,
      }),
      quietIo,
    );
    expectError(transactionWithArc(7, { advances: [{ line: '沈栀', stage: 3, evidence_anchor: '又推' }] }), /already complete/);

    // revision may not advance arcs
    const h2 = makeBook('arcrev');
    hosts.push(h2);
    initializeTracking(h2.book, initialWithArc({ lastChapter: 20 }), quietIo);
    const arcRev = transaction(10, { mode: 'revision' });
    (arcRev.delta as Record<string, unknown>).arc_advances = [{ line: '沈栀', stage: 1, evidence_anchor: 'x' }];
    let msg = '';
    try {
      applyTransaction(h2.book, Object.assign(arcRev, { expected_state_revision: 0 }), quietIo);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/must be committed in an append transaction/);
    expect(revisionOf(h2)).toBe(0);
  });

  it('a line can be registered mid-book only once; audit reports act-vs-plan values', () => {
    const h = makeBook('midbook');
    hosts.push(h);
    initializeTracking(h.book, initialWithArc(), quietIo);
    applyTransaction(
      h.book,
      Object.assign(
        transactionWithArc(1, {
          registrations: {
            感情线: {
              line_kind: '感情线',
              summary: '戒备到深恋',
              stages: [
                { name: '认识', planned_chapters: '第1-10章' },
                { name: '暧昧', planned_chapters: '第11-40章' },
              ],
            },
          },
        }),
        { expected_state_revision: 0 },
      ),
      quietIo,
    );
    expect(stateFrom(h).arcs['感情线']!.current_stage).toBe(1);
    expect(fs.existsSync(path.join(h.book, '追踪/角色线/感情线.md'))).toBe(true);

    const dup = transactionWithArc(2, {
      registrations: { 感情线: { line_kind: '感情线', stages: [{ name: 'a', planned_chapters: '第1章' }] } },
    });
    let msg = '';
    try {
      applyTransaction(h.book, Object.assign(dup, { expected_state_revision: 1 }), quietIo);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('already registered');
    expect(revisionOf(h)).toBe(1);
    expect(checkTracking(h.book)).toBeDefined();
  });

  it('arc-audit reports active progress and overdue flags (matches python fixture)', () => {
    const h = makeBook('arcaudit');
    hosts.push(h);
    initializeTracking(h.book, initialWithArc(), quietIo);
    applyTransaction(h.book, Object.assign(transactionWithArc(1), { expected_state_revision: 0 }), quietIo);
    applyTransaction(
      h.book,
      Object.assign(transactionWithArc(2, { advances: [{ line: '沈栀', stage: 1, evidence_anchor: '第2章『……也行吧』' }] }), {
        expected_state_revision: 1,
      }),
      quietIo,
    );
    const audit = auditArcs(h.book, quietIo);
    const report = audit.arc_lines['沈栀']!;
    expect(report.status).toBe('active:2');
    expect(report.total_stages).toBe(3);
    expect(report.achieved_stages).toBe(1);
    expect(report.last_advance_chapter).toBe(2);
    expect(report.overdue).toBe(false);
  });

  it('library exports expose the normalized state and audit report objects', async () => {
    const h = makeBook('libapi');
    hosts.push(h);
    initializeTracking(h.book, initialDocument(), quietIo);
    const state = loadTrackingState(h.book);
    expect((state as TrackingState).schema_version).toBe(4);
    const audit = auditArcs(h.book, quietIo);
    expect(audit.book_title).toBe(BOOK_TITLE);
    // audit arcs reports a note-less empty line map
    expect(Object.keys(audit.arc_lines)).toEqual([]);
  });
});

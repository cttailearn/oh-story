// Behavioral regression for the Node port of author_memory_commit.py.
//
// Self-contained (node:fs / node:path / node:os only — no Python, no
// subprocess). Mirrors the main behaviors of scripts/test-author-memory-commit.py:
// init → remember (strengthen/allocate) → decide → conflict → replace → forget →
// reinforce (best_level / evidence dedup) plus atomic-rollback protocol errors
// (exit 2 / ERROR on stderr), record auto-init, query budget/filtering, view
// repair on idempotent replay, and the library API (loadMemoryState /
// applyMemoryTransaction / memoryStatePath).
//
// Module-level temp dir is cleaned up in afterAll.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runAuthorMemoryCommit,
  loadMemoryState,
  memoryStatePath,
  applyMemoryTransaction,
} from '../impl/author-memory-commit.ts';

let temp: string;
let seq = 0;

beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'ohstory-amc-'));
});

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

/** Fresh isolated workspace (and a per-workspace transaction input path). */
function freshWorkspace(name: string): { ws: string; mem: string; tx: string } {
  const ws = join(temp, `${seq++}-${name}`);
  mkdirSync(ws, { recursive: true });
  return { ws, mem: join(ws, '.story', '作者记忆'), tx: join(temp, `${seq++}-${name}-tx.json`) };
}

function run(args: string[], cwd: string = process.cwd()) {
  return runAuthorMemoryCommit(args, cwd);
}

function parse(json: string): any {
  const value = JSON.parse(json);
  return value;
}

function writeJson(path: string, document: unknown): void {
  writeFileSync(path, JSON.stringify(document, null, 2) + '\n', 'utf8');
}

function preference(
  assertion: string,
  quote: string,
  opts: {
    status?: string;
    source?: string;
    scopeLevel?: string;
    scopeValue?: string | null;
    conflictsWith?: string[];
    kind?: string;
  } = {},
): Record<string, unknown> {
  const {
    status = 'active',
    source = 'explicit_user',
    scopeLevel = 'global',
    scopeValue = null,
    conflictsWith = [],
    kind = 'prose_style',
  } = opts;
  return {
    kind,
    scope: { level: scopeLevel, value: scopeValue },
    assertion,
    quote,
    source_ref: 'test:conversation',
    source,
    confidence: source === 'explicit_user' ? 'high' : 'medium',
    importance: 'high',
    status,
    reason: 'behavior regression evidence',
    conflicts_with: conflictsWith,
  };
}

function replacement(assertion: string, quote: string): Record<string, unknown> {
  const doc = preference(assertion, quote, { scopeLevel: 'book', scopeValue: '雾港来信' });
  delete doc.status;
  delete doc.conflicts_with;
  return doc;
}

function transaction(transactionId: string, revision: number, operations: unknown[]): Record<string, unknown> {
  return {
    schema_version: 1,
    transaction_id: transactionId,
    expected_state_revision: revision,
    operations,
  };
}

function readState(workspace: string): any {
  return parse(readFileSync(memoryStatePath(workspace), 'utf8'));
}

/** Recursive file-content snapshot (relative path → utf8 content). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (cur: string, rel: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const child = join(cur, entry.name);
      if (entry.isDirectory()) walk(child, childRel);
      else out[childRel] = readFileSync(child, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

describe('author-memory-commit (Node port)', () => {
  it('query on an uninitialized workspace is empty and must not create memory', async () => {
    const { ws, mem } = freshWorkspace('empty-query');
    const result = await run(['query', '--workspace', ws, '--kind', 'prose_style']);
    expect(result.code).toBe(0);
    expect(parse(result.stdout).items).toEqual([]);
    expect(existsSync(mem)).toBe(false);
  });

  it('full transaction lifecycle preserves the Python behavioral regression', async () => {
    const { ws, mem, tx } = freshWorkspace('flow');

    // -- init -----------------------------------------------------------------
    const initResult = await run(['init', '--workspace', ws]);
    expect(initResult.code).toBe(0);
    expect(parse(initResult.stdout).revision).toBe(0);
    expect(readdirSync(mem).sort()).toEqual([
      '_author-memory-state.json',
      '作者画像.md',
      '变更记录.md',
      '待确认.md',
    ]);
    expect((await run(['check', '--workspace', ws])).code).toBe(0);

    // -- remember (active) ----------------------------------------------------
    const first = transaction('tx-active', 0, [
      {
        action: 'remember',
        preference: preference(
          '对话尽量短，用动作承接情绪，不用大段解释',
          '以后对话都短一点，情绪放动作里，别让角色长篇解释。',
        ),
      },
    ]);
    writeJson(tx, first);
    await run(['commit', '--workspace', ws, '--input', tx]);
    let current = readState(ws);
    expect(current.state_revision).toBe(1);
    expect(current.items.AP001.status).toBe('active');
    expect(readFileSync(join(mem, '作者画像.md'), 'utf8')).toContain('AP001');

    // idempotent replay
    const replay = await run(['commit', '--workspace', ws, '--input', tx]);
    expect(replay.code).toBe(0);
    expect(parse(replay.stdout).replayed).toBe(true);
    expect(readState(ws).state_revision).toBe(1);

    // same transaction_id with different content -> exit 2 + rollback
    const reused = JSON.parse(JSON.stringify(first));
    reused.operations[0].preference.quote = '同一 ID 的不同内容';
    writeJson(tx, reused);
    const beforeFailure = snapshot(mem);
    const error = await run(['commit', '--workspace', ws, '--input', tx]);
    expect(error.code).toBe(2);
    expect(error.stderr).toContain('different content');
    expect(snapshot(mem)).toEqual(beforeFailure);

    // -- remember (pending) ---------------------------------------------------
    const pending = transaction('tx-pending', 1, [
      {
        action: 'remember',
        preference: preference(
          '倾向用物件细节替代直接心理说明',
          '三次修改都把心理说明换成了桌上的旧物。',
          { status: 'pending', source: 'repeated_correction' },
        ),
      },
    ]);
    writeJson(tx, pending);
    await run(['commit', '--workspace', ws, '--input', tx]);
    expect(readState(ws).items.AP002.status).toBe('pending');
    expect(readFileSync(join(mem, '待确认.md'), 'utf8')).toContain('AP002');

    // inferred_pattern must stay pending -> exit 2 + rollback
    const invalidInference = transaction('tx-invalid-inference', 2, [
      { action: 'remember', preference: preference('推断出的习惯不能直接生效', '从成稿里看起来如此。', { source: 'inferred_pattern' }) },
    ]);
    writeJson(tx, invalidInference);
    const beforeInf = snapshot(mem);
    const infError = await run(['commit', '--workspace', ws, '--input', tx]);
    expect(infError.code).toBe(2);
    expect(infError.stderr).toContain('must remain pending');
    expect(snapshot(mem)).toEqual(beforeInf);

    // -- decide (activate pending) -------------------------------------------
    const decide = transaction('tx-decide', 2, [
      {
        action: 'decide',
        item_id: 'AP002',
        decision: 'activate',
        quote: '对，这也是我的长期习惯。',
        reason: 'author confirmed the candidate',
      },
    ]);
    writeJson(tx, decide);
    await run(['commit', '--workspace', ws, '--input', tx]);
    expect(readState(ws).items.AP002.status).toBe('active');

    // -- remember (conflict, book scope) -------------------------------------
    const conflict = transaction('tx-conflict', 3, [
      {
        action: 'remember',
        preference: preference(
          '本书允许更长的试探性对话',
          '这本书对话慢一点，多试探几轮。',
          { status: 'conflict', scopeLevel: 'book', scopeValue: '雾港来信', conflictsWith: ['AP001'] },
        ),
      },
    ]);
    writeJson(tx, conflict);
    await run(['commit', '--workspace', ws, '--input', tx]);
    expect(readState(ws).items.AP003.status).toBe('conflict');

    // deciding to activate a conflict candidate is illegal -> exit 2
    const illegalActivation = transaction('tx-illegal-conflict-activation', 4, [
      { action: 'decide', item_id: 'AP003', decision: 'activate', quote: '启用它。', reason: 'must still use replace' },
    ]);
    writeJson(tx, illegalActivation);
    const beforeIllegal = snapshot(mem);
    const illegalError = await run(['commit', '--workspace', ws, '--input', tx]);
    expect(illegalError.code).toBe(2);
    expect(illegalError.stderr).toContain('must be activated with replace');
    expect(snapshot(mem)).toEqual(beforeIllegal);

    // -- replace (old_ids AP001 + AP003) -------------------------------------
    const replace = transaction('tx-replace', 4, [
      {
        action: 'replace',
        old_ids: ['AP001', 'AP003'],
        preference: replacement(
          '本书对话允许更长的试探，但避免解释设定',
          '这本书可以让对话慢一点，多试探，但还是别拿台词讲设定。',
        ),
      },
    ]);
    writeJson(tx, replace);
    await run(['commit', '--workspace', ws, '--input', tx]);
    current = readState(ws);
    expect(current.items.AP001.status).toBe('superseded');
    expect(current.items.AP003.status).toBe('superseded');
    expect(current.items.AP004.status).toBe('active');
    expect(current.items.AP001.superseded_by).toBe('AP004');

    // -- forget ---------------------------------------------------------------
    const forget = transaction('tx-forget', 5, [
      { action: 'forget', item_id: 'AP002', quote: '忘掉这个偏好。', reason: 'author withdrew it' },
    ]);
    writeJson(tx, forget);
    await run(['commit', '--workspace', ws, '--input', tx]);
    expect(readState(ws).items.AP002.status).toBe('superseded');

    // -- reinforce (same fingerprint): best-level + evidence dedup, no new item
    const reinforceP = replacement('本书对话允许更长的试探，但避免解释设定', '这本书就按慢对话和少解释继续。') as any;
    reinforceP.status = 'active';
    reinforceP.conflicts_with = [];
    const reinforce = transaction('tx-reinforce', 6, [{ action: 'remember', preference: reinforceP }]);
    writeJson(tx, reinforce);
    await run(['commit', '--workspace', ws, '--input', tx]);
    current = readState(ws);
    expect(current.next_item_number).toBe(5);
    expect(current.items.AP004.confirmation_count).toBe(2);
    expect(current.items.AP004.evidence).toHaveLength(2);

    // -- stale revision: atomic rollback --------------------------------------
    const stale = transaction('tx-stale', 5, [
      { action: 'forget', item_id: 'AP004', quote: '旧事务', reason: 'stale' },
    ]);
    writeJson(tx, stale);
    const beforeStale = snapshot(mem);
    const staleError = await run(['commit', '--workspace', ws, '--input', tx]);
    expect(staleError.code).toBe(2);
    expect(staleError.stderr).toContain('stale state revision');
    expect(snapshot(mem)).toEqual(beforeStale);

    // -- partial failure rolls back the whole transaction ---------------------
    const partialFailure = transaction('tx-partial-failure', 7, [
      { action: 'remember', preference: preference('不应落盘', '这条事务后面会失败。') },
      { action: 'forget', item_id: 'AP999', quote: '不存在', reason: 'force rollback' },
    ]);
    writeJson(tx, partialFailure);
    const beforePartial = snapshot(mem);
    const partialError = await run(['commit', '--workspace', ws, '--input', tx]);
    expect(partialError.code).toBe(2);
    expect(partialError.stderr).toContain('unknown item AP999');
    expect(snapshot(mem)).toEqual(beforePartial);

    // -- unknown operation field -> exit 2 + rollback -------------------------
    const unknownField = transaction('tx-unknown-field', 7, [
      { action: 'forget', item_id: 'AP004', quote: 'x', reason: 'x', extra: true },
    ]);
    writeJson(tx, unknownField);
    const beforeUnknown = snapshot(mem);
    const unknownError = await run(['commit', '--workspace', ws, '--input', tx]);
    expect(unknownError.code).toBe(2);
    expect(unknownError.stderr).toContain('unsupported fields');
    expect(snapshot(mem)).toEqual(beforeUnknown);

    // -- check detects a polluted view; idempotent replay repairs it ----------
    const profilePath = join(mem, '作者画像.md');
    writeFileSync(profilePath, readFileSync(profilePath, 'utf8') + '手工污染\n', 'utf8');
    const checkError = await run(['check', '--workspace', ws]);
    expect(checkError.code).toBe(2);
    expect(checkError.stderr).toContain('stale or edited');
    writeJson(tx, reinforce); // probe is a replay of the already-applied tx-reinforce
    const replay2 = await run(['commit', '--workspace', ws, '--input', tx]);
    expect(parse(replay2.stdout).replayed).toBe(true);
    expect((await run(['check', '--workspace', ws])).code).toBe(0);
    expect(readFileSync(profilePath, 'utf8')).not.toContain('手工污染');

    // -- record: event-based single-operation auto-init -----------------------
    const recordedPreference = preference('全局偏好用具体物件承载情绪', '记住：以后尽量让情绪落到具体物件上。');
    const recordEvent = {
      schema_version: 1,
      event_id: 'conversation-message-42',
      operation: { action: 'remember', preference: recordedPreference },
    };
    writeJson(tx, recordEvent);
    const recorded = await run(['record', '--workspace', ws, '--input', tx]);
    expect(recorded.code).toBe(0);
    const recordedDoc = parse(recorded.stdout);
    expect(recordedDoc.receipt).toBe('Author Memory Receipt: r8 · AP005');
    expect(recordedDoc.replayed).toBe(false);

    // -- query: kind/scope filtering inside the byte budget --------------------
    const queried = await run(['query', '--workspace', ws, '--kind', 'prose_style', '--book', '雾港来信']);
    expect(queried.code).toBe(0);
    expect(Buffer.byteLength(queried.stdout, 'utf8')).toBeLessThanOrEqual(2048);
    const queryDoc = parse(queried.stdout);
    expect(queryDoc.items.map((i: any) => i.id)).toEqual(['AP004', 'AP005']);
    for (const item of queryDoc.items) {
      expect(['AP001', 'AP002', 'AP003']).not.toContain(item.id);
    }

    // -- record forget + replay of a prior record event ------------------------
    const forgetEvent = {
      schema_version: 1,
      event_id: 'conversation-message-43',
      operation: {
        action: 'forget',
        item_id: 'AP005',
        quote: '这个全局偏好先忘掉。',
        reason: 'author withdrew the newly recorded preference',
      },
    };
    writeJson(tx, forgetEvent);
    const forgotten = await run(['record', '--workspace', ws, '--input', tx]);
    expect(parse(forgotten.stdout).receipt).toBe('Author Memory Receipt: r9 · AP005');
    writeJson(tx, recordEvent); // replay probe re-writes the original record event
    const replayedRecord = await run(['record', '--workspace', ws, '--input', tx]);
    const replayedDoc = parse(replayedRecord.stdout);
    expect(replayedDoc.replayed).toBe(true);
    expect(replayedDoc.applied_revision).toBe(8);
    expect(readState(ws).items.AP005.status).toBe('superseded');

    // -- final state bookkeeping -----------------------------------------------
    const final = readState(ws);
    expect(final.state_revision).toBe(9);
    expect(Object.keys(final.applied_transactions).sort()).toEqual(
      [
        'tx-active',
        'tx-pending',
        'tx-decide',
        'tx-conflict',
        'tx-replace',
        'tx-forget',
        'tx-reinforce',
        'record:conversation-message-42',
        'record:conversation-message-43',
      ].sort(),
    );
    for (const record of Object.values(final.applied_transactions)) {
      expect(Array.isArray((record as any).item_ids)).toBe(true);
      expect((record as any).item_ids.length).toBeGreaterThan(0);
    }
  });

  it('query filters by kind/scope and respects the fixed byte budget', async () => {
    const { ws, tx } = freshWorkspace('auto-init');
    // record auto-initializes a fresh workspace
    const autoEvent = {
      schema_version: 1,
      event_id: 'first-explicit-memory',
      operation: { action: 'remember', preference: preference('偏好短标题', '记住：标题短一点。') },
    };
    writeJson(tx, autoEvent);
    const autoResult = await run(['record', '--workspace', ws, '--input', tx]);
    expect(autoResult.code).toBe(0);
    expect(parse(autoResult.stdout).receipt).toBe('Author Memory Receipt: r1 · AP001');
    expect(readState(ws).state_revision).toBe(1);

    const manyPrefs = transaction(
      'tx-query-budget',
      1,
      [
        ...Array.from({ length: 8 }).map((_, index) => ({
          action: 'remember',
          preference: preference(`长偏好 ${index}：` + '用具体动作和物件承载信息'.repeat(18), `第 ${index} 条用于验证查询预算的明确偏好。`),
        })),
        {
          action: 'remember',
          preference: preference('悬疑故事优先让线索改变人物关系', '悬疑里我更看重线索对关系的改变。', {
            scopeLevel: 'genre',
            scopeValue: '悬疑',
            kind: 'story_design',
          }),
        },
      ],
    );
    writeJson(tx, manyPrefs);
    await run(['commit', '--workspace', ws, '--input', tx]);

    const bounded = await run(['query', '--workspace', ws, '--kind', 'prose_style']);
    expect(bounded.code).toBe(0);
    expect(Buffer.byteLength(bounded.stdout, 'utf8')).toBeLessThanOrEqual(2048);
    expect(parse(bounded.stdout).omitted).toBeGreaterThan(0);

    const matching = await run(['query', '--workspace', ws, '--kind', 'story_design', '--genre', '悬疑']);
    expect(parse(matching.stdout).items.map((i: any) => i.id)).toEqual(['AP010']);

    const noMatch = await run(['query', '--workspace', ws, '--kind', 'story_design', '--genre', '甜宠']);
    expect(parse(noMatch.stdout).items).toEqual([]);
    expect((await run(['check', '--workspace', ws])).code).toBe(0);
  });

  it('library API: memoryStatePath / loadMemoryState / applyMemoryTransaction', async () => {
    const { ws, tx } = freshWorkspace('lib');
    expect(memoryStatePath(ws)).toBe(join(ws, '.story', '作者记忆', '_author-memory-state.json'));

    // uninitialized -> canonical empty state (no file created)
    const pre = loadMemoryState(ws);
    expect(pre.state_revision).toBe(0);
    expect(pre.next_item_number).toBe(1);
    expect(Object.keys(pre.items)).toHaveLength(0);
    expect(existsSync(memoryStatePath(ws))).toBe(false);

    // init via CLI
    expect((await run(['init', '--workspace', ws])).code).toBe(0);

    const txDoc = transaction('lib-tx', 0, [
      { action: 'remember', preference: preference('偏好短标题', '记住：标题短一点。') },
    ]);
    const applied = applyMemoryTransaction(ws, txDoc);
    expect(applied.ok).toBe(true);
    expect(applied.replayed).toBe(false);
    expect(applied.revision).toBe(1);
    expect(applied.item_ids).toEqual(['AP001']);
    expect(applied.state.state_revision).toBe(1);
    expect(applied.state.items['AP001']?.status).toBe('active');
    // on-disk state persisted
    expect(readState(ws).state_revision).toBe(1);

    // idempotent replay through the library
    const replayed = applyMemoryTransaction(ws, txDoc);
    expect(replayed.replayed).toBe(true);
    expect(replayed.revision).toBe(1);
    expect(replayed.item_ids).toEqual(['AP001']);

    // loadMemoryState reflects what was applied
    expect(loadMemoryState(ws).state_revision).toBe(1);
    expect(loadMemoryState(ws).items['AP001']?.confirmation_count).toBe(1);

    // protocol error through the library surfaces as throw with exit-2 semantics
    const staleTx = transaction('lib-stale', 0, [
      { action: 'forget', item_id: 'AP001', quote: 'x', reason: 'stale' },
    ]);
    expect(() => applyMemoryTransaction(ws, staleTx)).toThrow(/stale state revision/);
    // uninitialized workspace -> library refuses
    const notInit = freshWorkspace('lib-not-init');
    expect(() => applyMemoryTransaction(notInit.ws, txDoc)).toThrow(/not initialized/);
  });
});

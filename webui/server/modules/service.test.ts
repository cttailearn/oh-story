// 模块库服务单测（teardown-module §4）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  archiveModules,
  listModules,
  getModule,
  updateModule,
  softDeleteModule,
  recommendModules,
  attachModules,
} from './service.ts';

let dir: string;
let db: InstanceType<typeof Database>;

const DDL = `
  CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, name TEXT NOT NULL, dir TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('novel-project','novel','teardown')), pipeline_id TEXT, pipeline_version INTEGER, theme_color TEXT, active_stage TEXT, meta_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS modules (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', usable_for TEXT NOT NULL DEFAULT '[]',
    body TEXT NOT NULL, usage_count INTEGER NOT NULL DEFAULT 0, used_in_json TEXT NOT NULL DEFAULT '[]',
    deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, who TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail_json TEXT);
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-mod-'));
  db = new Database(join(dir, 'm.db'));
  db.exec(DDL);
  db.prepare("INSERT INTO books (id,name,dir,kind,created_at,updated_at) VALUES ('nb_1','测试书',?,'novel',?,?)").run(join(dir, 'book'), new Date().toISOString(), new Date().toISOString());
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('模块库服务', () => {
  it('archive 批量入库（去重/附加标签/USE）', () => {
    const r1 = archiveModules(db, [
      { kind: 'plot', title: '越级打脸三连', body: '弱者挑衅→碾压→围观反转→结算', tags: ['爽文'], usable_for: ['都市系统流'], source_path: '剧情/情节点.md' },
      { kind: 'hook', title: '开局三章钩子', body: '第一章埋悬念', tags: ['钩子'] },
      { kind: 'plot', title: '越级打脸三连', body: '重复', tags: ['爽文'], source_path: '剧情/情节点.md' },
    ], { sourceBook: '盘龙', batchTags: ['收藏'], defaultUsableFor: ['都市系统流'] });
    expect(r1.created).toBe(2);
    expect(r1.skipped).toBe(1);
    expect(r1.module_ids).toHaveLength(2);
    const m1 = getModule(db, r1.module_ids[0]!);
    expect(m1.source).toContain('盘龙');
    expect(m1.tags).toContain('收藏');
    expect(m1.usable_for).toContain('都市系统流');
  });

  it('list 过滤（kind/tag/usable_for/source）与排序', () => {
    const all = listModules(db, {}).items;
    expect(all.length).toBe(2);
    expect(listModules(db, { kind: 'hook' }).total).toBe(1);
    expect(listModules(db, { usable_for: '都市系统流' }).total).toBe(2); // 两条都带默认 usable_for
    expect(listModules(db, { source: '盘龙' }).total).toBe(2);
  });

  it('update 改 tags/title；softDelete 不可见', () => {
    const first = listModules(db, {}).items[0]!;
    const up = updateModule(db, first.id, { title: '越级打脸·升级版', tags: [...first.tags, '升级'] });
    expect(up.title).toBe('越级打脸·升级版');
    expect(up.tags).toContain('升级');
    expect(softDeleteModule(db, first.id)).toBe(true);
    expect(listModules(db, {}).total).toBe(1);
    expect(getModule(db, first.id)!.deleted_at).toBeTruthy();
  });

  it('recommend 按题材/kind 评分排序', () => {
    archiveModules(db, [{ kind: 'emotion', title: '憋屈→释放', body: '…', usable_for: ['都市系统流'] }], {});
    const rec = recommendModules(db, { genre: '都市系统流', kinds: ['plot', 'hook'] }, 10);
    expect(rec.items.length).toBeGreaterThan(0);
    for (const it of rec.items) {
      expect(it.score).toBeGreaterThan(0);
    }
    // 题材命中分高于纯 kind 命中
    expect(rec.items[0]!.score).toBeGreaterThanOrEqual(rec.items[rec.items.length - 1]!.score);
  });

  it('attach 增 usage + used_in 历史 + 影响预估', () => {
    const target = listModules(db, { sort: 'usage' }).items  .find((m) => m.title.includes('钩子')) ?? listModules(db, {}).items[0]!;
    const before = getModule(db, target.id)!.usage_count;
    const r = attachModules(db, 'nb_1', [target.id], 'outline');
    expect(r.attached).toBe(1);
    expect(r.impact.glue).toBe('context-outline');
    expect(r.impact.knowledge_blocks).toBe(1);
    expect(r.impact.tokens_est).toBeGreaterThan(0);
    const after = getModule(db, target.id)!;
    expect(after.usage_count).toBe(before + 1);
    expect(after.used_in.length).toBe(1);
    expect(after.used_in[0].book_id).toBe('nb_1');
  });
});

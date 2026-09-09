import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { decomposeForNovel, listNovelMaterial, sanitizeSourceTitle } from './service.ts';

let dir: string;
let db: InstanceType<typeof Database>;
let novelDir: string;

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

const novelId = 'nb_mat_1';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-mat-'));
  novelDir = join(dir, 'target-book');
  mkdirSync(novelDir, { recursive: true });
  db = new Database(join(dir, 'm.db'));
  db.exec(DDL);
  db.prepare("INSERT INTO books (id,name,dir,kind,pipeline_id,pipeline_version,theme_color,active_stage,meta_json,created_at,updated_at) VALUES (?,?,?,'novel','long',1,NULL,'chapter','{}',?,?)")
    .run(novelId, 'target-book', novelDir, new Date().toISOString(), new Date().toISOString());
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const SRC_TEXT = `第一章 猎杀开始
夜晚的森林里，林晚握着刀，呼吸急促。猎物就在前方，鹿群在月光下饮水。
第二章 反杀
第二天，林晚用昨天布置的陷阱，把追兵反杀在溪谷里，收下第一枚战利品。
第三章 揭幕
三年前埋下的伏笔终于揭开，她擦干刀上的血，走向更远的地方。
`;

describe('writing-material decomposition', () => {
  it('decompose pasted text -> folder + module library + inject into book', () => {
    const r = decomposeForNovel(db, { id: novelId, dir: novelDir, name: 'target-book' }, { title: '猎夜', text: SRC_TEXT });
    expect(r.chapters).toBeGreaterThanOrEqual(2);
    expect(r.created).toBeGreaterThan(0);
    expect(r.attached).toBeGreaterThan(0);
    expect(r.files.length).toBeGreaterThan(0);
    expect(r.units.some((u) => u.kind === 'plot')).toBe(true);

    const report = join(novelDir, '拆文库', '猎夜', '拆文报告.md');
    expect(existsSync(report)).toBe(true);

    const listed = listNovelMaterial(db, novelId);
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items[0].source).toContain('猎夜');
  });

  it('re-decomposing the same source dedupes module library entries and does not duplicate titles', () => {
    const r2 = decomposeForNovel(db, { id: novelId, dir: novelDir, name: 'target-book' }, { title: '猎夜', text: SRC_TEXT });
    expect(r2.created).toBe(0);
    const listed = listNovelMaterial(db, novelId);
    const titles = listed.items.map((m) => m.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('empty text is rejected', () => {
    expect(() => decomposeForNovel(db, { id: novelId, dir: novelDir, name: 'target-book' }, { text: '   ' })).toThrow();
  });

  it('sanitizeSourceTitle strips invalid filename characters', () => {
    const s = sanitizeSourceTitle('盘龙/卷1: 测试<>|');
    expect(s).toContain('盘龙');
    expect(s).not.toContain('/');
  });
});
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, ulid } from './index.ts';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-db-'));
  dbPath = join(dir, 'webui.db');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('db layer', () => {
  it('创建 9 张表 + 索引，user_version=1', () => {
    const h = openDatabase(dbPath);
    const tables = h.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    for (const t of ['books', 'stages', 'artifacts', 'jobs', 'gate_runs', 'channels', 'audit', 'modules']) {
      expect(tables).toContain(t);
    }
    expect(h.user_version).toBe(1);
    h.db.close();
  });

  it('重复 open 幂等（migrations 跳过）', () => {
    const h = openDatabase(dbPath);
    expect(h.user_version).toBe(1);
    h.db.close();
  });

  it('books 插入 + 唯一约束（dir）', () => {
    const h = openDatabase(dbPath);
    const ts = new Date().toISOString();
    h.db
      .prepare(`INSERT INTO books (id, name, dir, kind, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('bk_a', 'A', join(dir, 'a'), 'novel-project', ts, ts);
    expect(() =>
      h.db
        .prepare(`INSERT INTO books (id, name, dir, kind, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
        .run('bk_b', 'B', join(dir, 'a'), 'novel-project', ts, ts),
    ).toThrow(/UNIQUE/);
    h.db.close();
  });

  it('idx_jobs_busy 部分唯一索引（同书同 stage 并发保护）', () => {
    const h = openDatabase(dbPath);
    const ts = new Date().toISOString();
    const ins = h.db.prepare(
      `INSERT INTO jobs (id, book_id, stage_id, kind, status, created_at) VALUES (?,?,?,?,?,?)`,
    );
    ins.run('job_x', 'bk_a', 'chapter', 'stage', 'running', ts);
    expect(() => ins.run('job_y', 'bk_a', 'chapter', 'stage', 'running', ts)).toThrow(
      /UNIQUE/,
    );
    // 不同 stage 允许
    ins.run('job_z', 'bk_a', 'outline', 'stage', 'running', ts);
    h.db.close();
  });

  it('ulid 生成前缀 + 唯一', () => {
    const a = ulid('bk');
    const b = ulid('bk');
    expect(a.startsWith('bk_')).toBe(true);
    expect(a).not.toBe(b);
  });
});

// SQLite 连接 + 迁移执行器（data-model.md §1/§4）
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

type SqliteDb = InstanceType<typeof Database>;

export interface DbHandle {
  db: SqliteDb;
  path: string;
  user_version: number;
}

/**
 * 打开（或创建）webui.db，并顺序执行尚未应用的 migrations/*.sql。
 * PRAGMA user_version 记录已应用到哪个迁移。
 */
export function openDatabase(dbPath: string): DbHandle {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return {
    db,
    path: dbPath,
    user_version: db.pragma('user_version', { simple: true }) as number,
  };
}

function migrate(db: SqliteDb): void {
  const applied = db.pragma('user_version', { simple: true }) as number;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  let version = applied;
  for (const file of files) {
    const n = parseInt(file.split('_')[0]!, 10);
    if (n <= applied) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec(sql);
    version = n;
    db.pragma(`user_version = ${version}`);
  }
}

/** 轻量 ULID 生成：bk_<ts><rand>（同步、无依赖） */
export function ulid(prefix: string): string {
  const ts = Date.now().toString(36).padStart(10, '0');
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${prefix}_${ts}${rand}`;
}

// M0.7 演示数据接入：demo/长篇 注册为书（data-model §2），供 UI 浏览正文/大纲/设定/追踪
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from './db/index.ts';
import { ulid } from './db/index.ts';

/** 若书库为空且 demo 目录存在，注册 demo 长篇为书（kind=novel-project + 栈入子书） */
export function registerDemoBook(db: DbHandle, workspace: string): void {
  const count = (db.db.prepare(`SELECT COUNT(*) AS c FROM books`).get() as { c: number }).c;
  if (count > 0) return;

  const demoLong = join(workspace, 'demo', '长篇');
  if (!existsSync(demoLong)) return;

  const books = readdirSync(demoLong)
    .filter((name) => existsSync(join(demoLong, name)))
    .map((name) => ({ name, dir: join(demoLong, name) }));

  if (books.length === 0) return;

  const ts = new Date().toISOString();
  const importStmt = db.db.prepare(
    `INSERT INTO books (id, name, dir, kind, pipeline_id, pipeline_version, theme_color, active_stage, meta_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const projectId = ulid('bk');
  const projectName = 'demo·长篇';
  importStmt.run(
    projectId, projectName, demoLong, 'novel-project', 'long', 1, '#8C4A2F',
    null, JSON.stringify({ demo: true, note: 'demo 长篇项目' }), ts, ts,
  );

  for (const b of books) {
    const id = ulid('nb');
    importStmt.run(
      id, b.name, b.dir, 'novel', 'long', 1, null,
      'review', JSON.stringify({ demo: true }), ts, ts,
    );
    // 预置 stage 行（便于流程看板展示 demo 进度）
    const stageSeeds: Array<[string, string]> = [
      ['intake', 'done'], ['concept', 'done'], ['characters', 'done'],
      ['outline', 'done'], ['chapter', 'review'], ['review', 'pending'],
      ['deslop', 'pending'], ['cover', 'pending'], ['export', 'pending'],
    ];
    const insertStage = db.db.prepare(
      `INSERT INTO stages (book_id, stage_id, status, revision) VALUES (?,?,?,1)`,
    );
    for (const [sid, status] of stageSeeds) {
      insertStage.run(id, sid, status);
    }
    // 关联到项目（meta）
    const projectStages = db.db.prepare(
      `INSERT INTO stages (book_id, stage_id, status, revision) VALUES (?,?,?,1)`,
    );
    projectStages.run(projectId, `novel:${id}`, 'done');
  }

  db.db
    .prepare(`INSERT INTO audit (ts, who, action, target, detail_json) VALUES (?,?,?,?,?)`)
    .run(ts, 'engine', 'import', `project:${projectId}`, JSON.stringify({ demo: true, books: books.length }));
  console.log(`📚 已注册 demo 长篇项目（${books.length} 书）`);
}

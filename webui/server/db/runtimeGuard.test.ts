// 运行时依赖守卫：better-sqlite3 必须 >= 13（N-API）
//
// 事故记录（2026-09 实测）：
//   Node.js v24.19.0 的 node::ObjectWrap 清理钩子回归（nodejs/node#65446）会让
//   better-sqlite3 < 13 的 Statement 在 GC 时调用 RemoveEnvironmentCleanupHook 并命中
//   `Assertion failed: (env) != nullptr`，**直接 abort 整个进程**。
//   本仓库实测：加载小说工作台页（/novels/:id）即可复现（见 WiseLibs/better-sqlite3#1515）。
//   better-sqlite3 13 起改用 node-addon-api（N-API），结构上不再走 node::ObjectWrap 清理路径，
//   且自带跨 Node 版本的预编译产物（无需 prebuild-install / node-gyp）。
// 这条测试用于防止依赖被降级回会崩溃的版本。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('运行时依赖守卫', () => {
  it('better-sqlite3 主版本 >= 13（<13 在 Node 24.19.0 上会 abort 进程）', () => {
    const pkg = require('better-sqlite3/package.json') as { version: string };
    const major = Number(pkg.version.split('.')[0]);
    expect(
      major,
      'better-sqlite3 ' +
        pkg.version +
        ' 使用旧 node::ObjectWrap 清理路径，在 Node 24.19.0 上会在 GC 时 abort（nodejs/node#65446）。请使用 ^13。',
    ).toBeGreaterThanOrEqual(13);
  });

  it('better-sqlite3 可用（预编译产物已随包分发，无需 node-gyp）', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(a)');
    db.prepare('INSERT INTO t VALUES (?)').run(1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c).toBe(1);
    db.close();
  });
});

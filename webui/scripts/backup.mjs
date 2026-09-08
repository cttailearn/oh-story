// 手动备份 / 升级前快照（ops-observability §4）
// 用法：npm run backup [-- --snapshot] [--root <workspace>]
import { join, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase } from '../server/db/index.ts';
import { initConfig } from '../server/config/index.ts';
import { runBackup, listBackups } from '../server/ops/service.ts';

const argv = process.argv.slice(2);
const cwd = process.cwd();
const ri = argv.indexOf('--root');
const root = ri >= 0 ? argv[ri + 1] : (basename(cwd) === 'webui' ? dirname(cwd) : cwd);
const mode = argv.includes('--snapshot') ? 'snapshot' : 'daily';
const webuiDir = join(root, '.webui');
if (!existsSync(join(webuiDir, 'webui.db'))) { console.log('未找到库'); process.exit(1); }
initConfig(root, webuiDir);
const db = openDatabase(join(webuiDir, 'webui.db'));
const r = runBackup(db.db, webuiDir, mode);
db.db.close();
console.log('备份完成:', r.path, '|', r.bytes + 'B', '| 保留', r.kept, '份');
console.log('.webui/backups/:');
for (const b of listBackups(webuiDir)) console.log('    -', b.name, '(' + b.bytes + 'B,', b.at + ')');

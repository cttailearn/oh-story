// 追踪单次任务（ops-observability §2）：job 事件序列 + 门禁 + 审计
// 用法：npm run trace -- --job <job_id> [--root <workspace>]
import { join, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase } from '../server/db/index.ts';
import { initConfig } from '../server/config/index.ts';

const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const cwd = process.cwd();
const root = argOf('--root') ?? (basename(cwd) === 'webui' ? dirname(cwd) : cwd);
const jobId = argOf('--job');
if (!jobId) { console.log('用法: npm run trace -- --job <job_id>'); process.exit(1); }
const webuiDir = join(root, '.webui');
if (!existsSync(join(webuiDir, 'webui.db'))) { console.log('库不存在'); process.exit(1); }
initConfig(root, webuiDir);
const db = openDatabase(join(webuiDir, 'webui.db'));
const job = db.db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
if (!job) { console.log('job 不存在：', jobId); process.exit(1); }
console.log('job:', job.id, '| book:', job.book_id, '| stage:', job.stage_id, '| kind:', job.kind, '| status:', job.status, '| rev:', job.revision);
console.log('   cost_cents:', job.cost_cents, '| tokens_in:', job.tokens_in, '| tokens_out:', job.tokens_out, '| error:', job.error ?? '-');
console.log('   created:', job.created_at, '| finished:', job.finished_at ?? '-');
const gates = db.db.prepare('SELECT gate, ok, ran_ms, created_at, blocking_json FROM gate_runs WHERE job_id=? ORDER BY id').all(jobId);
console.log('门禁序列（', gates.length, ' 次）:');
let bx = 0;
for (const g of gates) {
  if (g.ok === 0) bx++;
  console.log('   -', g.gate, '| ok:', g.ok === 1 ? 'PASS' : 'FAIL', '|', g.ran_ms + 'ms', '|', g.created_at, g.ok === 0 ? '| blocking: ' + (g.blocking_json ?? '[]').slice(0, 120) : '');
}
console.log('blocking 门禁次数:', bx);
const audits = db.db.prepare("SELECT ts, action, target, detail_json FROM audit WHERE target LIKE ? OR target LIKE ? ORDER BY id").all('%' + jobId + '%', '%' + (job.book_id ?? '') + '%');
console.log('相关审计留痕（', audits.length, ' 条，显示前 12）:');
for (const a of audits.slice(0, 12)) console.log('   [', a.ts, ']', a.action, '->', a.target, a.detail_json ?? '');
db.db.close();
console.log('trace 完成');

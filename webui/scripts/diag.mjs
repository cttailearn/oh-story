// oh-story WebUI 诊断脚本（ops-observability §2）：健康深检 + 可选 ai-patterns 冒烟
// 用法：npm run diag [-- --root <workspace>] [--book <id|name>]
import { join, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { openDatabase } from '../server/db/index.ts';
import { initConfig, getConfig } from '../server/config/index.ts';
import { collectHealthDeep } from '../server/ops/service.ts';
import { buildGateAdapters } from '../server/gates/registry.ts';
import { runGates, hasBlocking } from '../server/gates/runner.ts';

const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const cwd = process.cwd();
const root = argOf('--root') ?? (basename(cwd) === 'webui' ? dirname(cwd) : cwd);
console.log('workspace:', root);
const webuiDir = join(root, '.webui');
if (!existsSync(join(webuiDir, 'webui.db'))) {
  console.log('未找到 ' + join(webuiDir, 'webui.db') + ' —— 尚未初始化库，请先在 workspace 根运行一次 WebUI 服务。');
  process.exit(1);
}
initConfig(root, webuiDir);
const db = openDatabase(join(webuiDir, 'webui.db'));
console.log('db user_version:', db.user_version);
const cfg = getConfig();
const deep = collectHealthDeep(db.db, {
  dbPath: join(webuiDir, 'webui.db'),
  workspace: root,
  channels: cfg.channels,
  lastTested: (cfg.prefs?.last_tested ?? {}),
});
console.log('ok:', deep.ok, '| node:', deep.node, '| python_dep_free:', deep.python_dep_free);
console.log('db bytes:', deep.db.bytes, '| gates_total:', deep.db.gates_total, '| jobs_pending:', deep.db.jobs_pending);
console.log('channels:', deep.channels.map((c) => c.id + (c.configured ? '[已配置]' : '[未配置]') + (c.tested_at ? '(已测)' : '')).join(', ') || '（无）');
console.log('perf: gate_p95(ms)=', deep.perf.last_gate_ms_p95, '| ai_calls_24h=', deep.perf.ai_calls_24h, '| cost_24h_cents=', deep.perf.cost_24h_cents);

const adapters = buildGateAdapters();
console.log('门禁 registry 就绪:', adapters.length, '个 gate（', adapters.map((a) => a.name).join(', '), '）');

const bookArg = argOf('--book');
if (bookArg) {
  const book = db.db.prepare('SELECT * FROM books WHERE id=? OR name=?').get(bookArg, bookArg);
  if (!book) { console.log('书不存在：', bookArg); process.exit(1); }
  console.log('对书「' + book.name + '」跑 ai-patterns 门禁冒烟…');
  const t0 = Date.now();
  const reports = await runGates(db.db, adapters.filter((a) => a.name === 'ai-patterns'), { bookDir: book.dir, cwd: root }, { bookId: book.id, stageId: 'diag', revision: null, jobId: 'diag' });
  console.log('耗时:', Date.now() - t0, 'ms | blocking:', hasBlocking(reports) ? '有' : '无');
}
db.db.close();
console.log('diag 完成');

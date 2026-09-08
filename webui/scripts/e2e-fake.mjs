// 假渠道端到端冒烟（M1.7 / M4 回归门）：创建书 → 跑 4 阶段 → 断言产物/状态/job 生命周期 → 每步确认 → 成本
// 用法：node scripts/e2e-fake.mjs [--base http://127.0.0.1:3081/api]   （或设 WEBUI_BASE）
// 退出码：0 = 全部断言通过；1 = 有失败（可直接用于 CI / guards）
const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = (argOf('--base', process.env.WEBUI_BASE) || 'http://127.0.0.1:3081/api').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
let checks = 0;
function ok(cond, label, extra) {
  checks++;
  if (cond) {
    console.log('  ✓ ' + label);
  } else {
    failures.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
    console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  }
}

async function j(path, init = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, body };
}

console.log('base: ' + BASE);

// 0) 健康检查
const health = await j('/health');
ok(health.status === 200 && health.body?.ok === true, 'GET /health 200 ok', health.body);

// 1) 新建书（fake 也用真实目录）
const name = `e2e测试书_${Date.now().toString(36)}`;
const created = await j('/books', { method: 'POST', body: JSON.stringify({ name, type: 'novel', pipeline: 'long' }) });
ok(created.status === 201, 'POST /books 201', created);
if (created.status !== 201) {
  console.error('建书失败，终止。');
  process.exitCode = 1;
  throw new Error('create book failed');
}
const bookId = created.body.id;
console.log('book: ' + bookId + ' ' + name);

// 2) 跑 intake → concept → characters → outline（fake）
const ran = ['intake', 'concept', 'characters', 'outline'];
for (const stage of ran) {
  const r = await j(`/books/${bookId}/stages/${stage}/run`, { method: 'POST', body: JSON.stringify({ fake: true }) });
  ok(r.status === 200 && r.body?.status === 'review' && r.body?.gate_blocking === false, `run ${stage} → review`, r.body);
  await sleep(120);
}

// 3) 阶段状态：跑过的=review；没跑过的绝不能是 review（防止「空阶段被批阅放行」）
const stagesAfterRun = (await j(`/books/${bookId}/stages`)).body?.stages ?? [];
const statusOf = (id) => stagesAfterRun.find((s) => s.id === id)?.status;
for (const s of ran) ok(statusOf(s) === 'review', `stage ${s} = review`, statusOf(s));
for (const s of ['chapter', 'review', 'deslop', 'cover', 'export']) {
  ok(statusOf(s) !== 'review', `未运行的 stage ${s} 不得为 review`, statusOf(s));
}

// 4) 产物落位（file-set 契约路径）
const tree = (await j(`/books/${bookId}/tree`)).body?.tree ?? [];
const flat = [];
(function walk(ns) {
  for (const n of ns) {
    if (n.type === 'file') flat.push(n.path);
    if (n.children) walk(n.children);
  }
})(tree);
for (const want of [
  '设定/题材定位.md',
  '设定/文风.md',
  '设定/世界观/金手指.md',
  '设定/角色/江晨.md',
  '设定/角色线/江晨.md',
  '大纲/大纲.md',
  '大纲/细纲/第001章.md',
]) {
  ok(flat.includes(want), '产物存在 ' + want);
}

// 5) job 生命周期：跑完 = review + finished_at；同阶段重跑不得抹掉历史行
const jobsOf = async () => (await j(`/jobs?book_id=${bookId}`)).body?.items ?? [];
let jobs = await jobsOf();
for (const s of ran) {
  const job = jobs.find((x) => x.stage_id === s);
  ok(!!job, `job 记录存在 ${s}`, jobs.map((x) => x.stage_id));
  if (job) ok(job.status === 'review' && !!job.finished_at, `job ${s} 终态 review + finished_at`, { status: job.status, finished_at: job.finished_at });
}
const rerun = await j(`/books/${bookId}/stages/intake/run`, { method: 'POST', body: JSON.stringify({ fake: true }) });
ok(rerun.status === 200, '重跑 intake 200', rerun.body);
jobs = await jobsOf();
ok(jobs.filter((x) => x.stage_id === 'intake').length >= 2, '重跑后 intake job 历史保留 ≥2 行', jobs.filter((x) => x.stage_id === 'intake').length);

// 6) 每步确认 → done
for (const stage of ran) {
  const r = await j(`/books/${bookId}/stages/${stage}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve', note: 'e2e' }) });
  ok(r.status === 200 && r.body?.status === 'done', `approve ${stage} → done`, r.body);
  await sleep(80);
}
jobs = await jobsOf();
for (const s of ran) {
  const rows = jobs.filter((x) => x.stage_id === s);
  ok(rows.every((x) => x.status === 'done'), `确认后 job ${s} 全部 done`, rows.map((x) => x.status));
}

// 7) 成本面板口径（fake 无花费，但阶段/模型聚合必须可见）
const cost = (await j(`/books/${bookId}/cost`)).body ?? {};
ok(Object.keys(cost.by_stage ?? {}).length >= ran.length, 'cost.by_stage 覆盖已跑阶段', cost.by_stage);
ok(Object.keys(cost.by_model ?? {}).length >= 1, 'cost.by_model 有渠道/模型记录', cost.by_model);

// 8) 门禁留痕：允许「仅警示」的门禁（ok=0 但 blocking 为空），但不得有任何 blocking
const gateRuns = (await j(`/books/${bookId}/gate-runs`)).body?.items ?? [];
const blockingRuns = gateRuns.filter((g) => {
  try {
    return JSON.parse(g.blocking_json || '[]').length > 0;
  } catch {
    return true;
  }
});
ok(gateRuns.length > 0, 'gate_runs 有留痕', gateRuns.length);
ok(blockingRuns.length === 0, 'gate_runs 无 blocking', { total: gateRuns.length, blocking: blockingRuns.map((g) => g.gate) });

// 9) 健康深检：不得再有「挂起任务」残留
const deep = (await j('/health?depth=full')).body ?? {};
ok(deep.db?.jobs_pending === 0, 'health.depth=full jobs_pending = 0', deep.db?.jobs_pending);

console.log(`\n=== ${checks - failures.length}/${checks} 断言通过 ===`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('E2E FAKE OK');
}

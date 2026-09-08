// 全端点集成校验（api-contract 覆盖面）：真实 HTTP 打全量 REST，逐项断言，失败退出码 1。
// 用法：node scripts/verify-api.mjs [--base http://127.0.0.1:3081/api]（或 WEBUI_BASE）
// 前置：后端已启动（npm start / npm run dev:server）。零外部依赖，只用 node fetch。
const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = (argOf('--base', process.env.WEBUI_BASE) || 'http://127.0.0.1:3081/api').replace(/\/+$/, '');

const failures = [];
let checks = 0;
const ok = (cond, label, extra) => {
  checks++;
  if (cond) console.log('  ✓ ' + label);
  else {
    failures.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
    console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  }
};
const section = (t) => console.log('\n[' + t + ']');

async function j(path, init = {}) {
  // 只在带 body 时声明 JSON Content-Type：DELETE 无 body 时声明 JSON 会被 Fastify 判为非法空 body
  const headers = init.body !== undefined ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(BASE + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const ct = res.headers.get('content-type') ?? '';
  let body = null;
  try {
    body = ct.includes('json') ? await res.json() : await res.text();
  } catch {
    /* 空响应 */
  }
  return { status: res.status, body, ct };
}

const stamp = Date.now().toString(36);
console.log('base: ' + BASE);

section('health');
const health = await j('/health');
ok(health.status === 200 && health.body?.ok === true, 'GET /health', health.body);
const deep = await j('/health?depth=full');
ok(deep.status === 200 && typeof deep.body?.db?.gates_total === 'number', 'GET /health?depth=full', deep.body?.db);

section('books');
const name = 'verify书_' + stamp;
const created = await j('/books', {
  method: 'POST',
  body: JSON.stringify({ name, type: 'novel', pipeline: 'long', requirements: { 题材: '都市', 平台风格: '番茄' } }),
});
ok(created.status === 201, 'POST /books 201', created.body);
if (created.status !== 201) {
  console.error('建书失败，终止');
  process.exitCode = 1;
  throw new Error('create book failed');
}
const bookId = created.body.id;
const bookDir = created.body.dir;
const dup = await j('/books', { method: 'POST', body: JSON.stringify({ name, type: 'novel' }) });
ok(dup.status === 409, '同名建书 409 CONFLICT', dup.body);
const bad = await j('/books', { method: 'POST', body: JSON.stringify({ type: 'novel' }) });
ok(bad.status === 400, '缺 name 400', bad.body);
const got = await j('/books/' + bookId);
ok(got.status === 200 && Array.isArray(got.body?.stages), 'GET /books/:id', got.status);
ok((await j('/books/nope')).status === 404, 'GET /books/:id 不存在 404');

section('files（mtime 乐观锁）');
const p1 = '正文/第001章_校验.md';
const w1 = await j('/files', { method: 'PUT', body: JSON.stringify({ path: p1, content: '# 第001章 校验\n\n' + '这是一段用于校验的正文。'.repeat(30), mtime: null, book_id: bookId }) });
ok(w1.status === 200 && w1.body?.mtime > 0, 'PUT /files 新建', w1.body);
const r1 = await j('/files?path=' + encodeURIComponent(p1) + '&book_id=' + bookId);
ok(r1.status === 200 && r1.body?.content.includes('校验'), 'GET /files 读回', r1.status);
const conflict = await j('/files', { method: 'PUT', body: JSON.stringify({ path: p1, content: 'x', mtime: r1.body.mtime - 99999, book_id: bookId }) });
ok(conflict.status === 409 && conflict.body?.error?.code === 'CONFLICT', 'mtime 不符 409', conflict.body);
const w2 = await j('/files', { method: 'PUT', body: JSON.stringify({ path: '正文/第002章_校验.md', content: '# 第002章 校验\n\n' + '第二段正文。'.repeat(30), mtime: null, book_id: bookId }) });
ok(w2.status === 200, 'PUT 第002章', w2.body);
ok((await j('/files?path=' + encodeURIComponent('../evil.md') + '&book_id=' + bookId)).status === 400, '路径穿越 400');
ok((await j('/files?path=x.md')).status === 400, '缺 book_id 400');

section('tree / tracking');
const tree = await j('/books/' + bookId + '/tree');
const flat = [];
(function walk(ns) { for (const n of ns) { if (n.type === 'file') flat.push(n.path); if (n.children) walk(n.children); } })(tree.body?.tree ?? []);
ok(flat.includes(p1), 'GET /books/:id/tree 含写入文件', flat.slice(0, 6));
const seed = await j('/files?path=' + encodeURIComponent('设定/题材定位.md') + '&book_id=' + bookId);
ok(seed.status === 200 && seed.body.content.includes('都市'), '新建向导种子落盘（设定/题材定位.md）', seed.status);
ok((await j('/books/' + bookId + '/tracking')).status === 404, 'GET tracking 无状态 404');

section('gates');
const g = await j('/books/' + bookId + '/gates/run', { method: 'POST', body: JSON.stringify({ gates: ['char-count'], failFast: false }) });
ok(g.status === 200 && Array.isArray(g.body?.reports) && g.body.reports.length === 1, 'POST /gates/run 指定门禁', g.body?.reports?.map((r) => r.gate));
const gAll = await j('/books/' + bookId + '/gates/run', { method: 'POST', body: '{}' });
ok(gAll.status === 200 && gAll.body.reports.length > 1, 'POST /gates/run 全门禁', gAll.body?.reports?.length);
const gr = await j('/books/' + bookId + '/gate-runs');
ok(gr.status === 200 && gr.body.items.length > 0, 'GET /gate-runs 留痕', gr.body?.items?.length);

section('export（md/txt/zip/excel/epub）');
for (const format of ['markdown', 'txt', 'zip', 'excel', 'epub']) {
  const r = await j('/books/' + bookId + '/export', { method: 'POST', body: JSON.stringify({ format }) });
  ok(r.status === 200 && r.body?.ok === true && !!r.body?.relPath, 'export ' + format, r.body);
}
ok((await j('/books/' + bookId + '/export', { method: 'POST', body: JSON.stringify({ format: 'nope' }) })).status === 400, 'export 非法 format 400');
const emptyBook = await j('/books', { method: 'POST', body: JSON.stringify({ name: 'verify空书_' + stamp, type: 'novel', pipeline: 'long' }) });
ok((await j('/books/' + emptyBook.body.id + '/export', { method: 'POST', body: JSON.stringify({ format: 'markdown' }) })).status === 422, '无章节导出 422 fail-closed');

section('modules');
const list0 = await j('/modules');
ok(list0.status === 200 && Array.isArray(list0.body?.items), 'GET /modules', list0.status);
const arch = await j('/books/' + bookId + '/modules/archive', {
  method: 'POST',
  body: JSON.stringify({ units: [
    { kind: 'hook', title: '校验钩子' + stamp, summary: '章尾悬念模板', body: '钩子正文' },
    { kind: 'rhythm', title: '校验节奏' + stamp, summary: '三拍推进', body: '节奏正文' },
  ], batch_tags: ['verify'], usable_for: ['outline'] }),
});
ok(arch.status === 200 && arch.body.created === 2, 'POST /modules/archive', arch.body);
const mid = arch.body.module_ids?.[0];
const md = await j('/modules/' + mid);
ok(md.status === 200 && md.body?.title?.includes('校验'), 'GET /modules/:id', md.body?.title);
const upd = await j('/modules/' + mid, { method: 'PUT', body: JSON.stringify({ summary: '已编辑', tags: ['verify', 'edited'] }) });
ok(upd.status === 200 && upd.body?.summary === '已编辑', 'PUT /modules/:id', upd.body?.summary);
const attach = await j('/books/' + bookId + '/modules/attach', { method: 'POST', body: JSON.stringify({ module_ids: [mid], scope: 'outline' }) });
ok(attach.status === 200 && attach.body?.attached >= 1, 'POST /modules/attach', attach.body);
const rec = await j('/books/' + bookId + '/modules/recommend', { method: 'POST', body: JSON.stringify({ genre: '都市', kinds: ['hook'] }) });
ok(rec.status === 200, 'POST /modules/recommend', rec.status);
ok((await j('/modules/' + mid, { method: 'DELETE' })).status === 200, 'DELETE /modules/:id 软删');
ok((await j('/modules/' + mid)).status === 404, '软删后 GET 404');

section('characters / curves / search');
const chars = await j('/books/' + bookId + '/characters');
ok(chars.status === 200 && Array.isArray(chars.body?.items), 'GET /characters', chars.body?.items?.length);
ok((await j('/books/' + bookId + '/characters/无此人/arc')).status === 404, 'GET 不存在的角色线 404');
const emo = await j('/books/' + bookId + '/curves/emotion');
ok(emo.status === 200 && Array.isArray(emo.body?.series), 'GET /curves/emotion', emo.status);
const rhy = await j('/books/' + bookId + '/curves/rhythm');
ok(rhy.status === 200 && Array.isArray(rhy.body?.value), 'GET /curves/rhythm', rhy.status);
const search = await j('/search?q=' + encodeURIComponent('校验'));
ok(search.status === 200, 'GET /search', search.status);
ok((await j('/search?q=')).status === 400, 'GET /search 空 q 400');

section('stats / audit / ops');
ok((await j('/stats')).status === 200, 'GET /stats');
const csv = await j('/stats/audit.csv');
ok(csv.status === 200 && String(csv.body).includes(',') && csv.ct.includes('csv'), 'GET /stats/audit.csv', csv.ct);
const audit = await j('/audit?limit=5');
ok(audit.status === 200 && audit.body.items.length > 0, 'GET /audit', audit.body?.items?.length);
const bk = await j('/ops/backup', { method: 'POST', body: JSON.stringify({ mode: 'snapshot' }) });
ok(bk.status === 200 && bk.body?.ok === true && bk.body?.bytes > 0, 'POST /ops/backup', bk.body);
const bks = await j('/ops/backups');
ok(bks.status === 200 && bks.body.items.length > 0, 'GET /ops/backups', bks.body?.items?.length);
ok((await j('/ops/maintain', { method: 'POST', body: '{}' })).status === 200, 'POST /ops/maintain');
const relink = await j('/books/' + bookId + '/relink', { method: 'POST', body: JSON.stringify({ dir: '不存在的目录_xyz' }) });
ok(relink.status >= 400 && relink.status < 500, 'relink 非法目录 4xx fail-closed', relink.status);
const relinkEscape = await j('/books/' + bookId + '/relink', { method: 'POST', body: JSON.stringify({ dir: '../逃逸' }) });
ok(relinkEscape.status === 400, 'relink 越界目录 400', relinkEscape.body);
ok((await j('/jobs/nope/kill', { method: 'POST', body: '{}' })).status === 404, 'kill 不存在任务 404');
const jobs = await j('/jobs?book_id=' + bookId);
ok(jobs.status === 200 && Array.isArray(jobs.body?.items), 'GET /jobs', jobs.body?.items?.length);

section('config');
const cfg = await j('/config');
ok(cfg.status === 200 && Array.isArray(cfg.body?.channels), 'GET /config');
ok((cfg.body?.channels ?? []).every((c) => !c.api_key || c.api_key.includes('****')), 'GET /config 密钥掩码');
const put = await j('/config', { method: 'PUT', body: JSON.stringify({ prefs: { theme: 'night' } }) });
ok(put.status === 200 && put.body?.prefs?.theme === 'night', 'PUT /config 保存', put.body?.prefs?.theme);
ok((await j('/config')).body?.prefs?.theme === 'night', 'PUT /config 已持久化');
await j('/config', { method: 'PUT', body: JSON.stringify({ prefs: { theme: 'day' } }) });

section('ai-edit');
const ai = await j('/books/' + bookId + '/ai-edit', { method: 'POST', body: JSON.stringify({ mode: 'rewrite', target: { path: p1 }, demand: { kind: 'custom' } }) });
if (ai.status === 200) {
  // 无渠道时降级 demo：结果必须显式标注 fake，绝不能被当成真实模型输出
  ok(ai.body?.fake === true && String(ai.body?.note).includes('demo'), 'POST /ai-edit 无渠道降级 demo 且显式标注 fake', ai.body?.note);
} else {
  ok([503, 400].includes(ai.status), 'POST /ai-edit 无渠道 fail-closed（503/400）', ai.body);
}
const aiBad = await j('/books/' + bookId + '/ai-edit', { method: 'POST', body: JSON.stringify({ mode: 'nope', target: { path: p1 }, demand: { kind: 'custom' } }) });
ok(aiBad.status === 400, 'POST /ai-edit 非法 mode 400', aiBad.body);

section('import / teardown / 软删');
const imp = await j('/import', { method: 'POST', body: JSON.stringify({ name: 'verify导入_' + stamp, mode: 'clipboard', text: '# 第1章 导入测试\n\n正文内容甲。\n\n# 第2章 继续\n\n正文内容乙。' }) });
ok(imp.status === 200 && imp.body?.book?.id, 'POST /import 导入', imp.body?.book?.id ?? imp.body);
if (imp.body?.book?.id) {
  const st = await j('/books/' + imp.body.book.id + '/import-review/status');
  ok(st.status === 200 && 'pending' in (st.body ?? {}), 'GET /import-review/status', st.body?.pending);
}
const td = await j('/books', { method: 'POST', body: JSON.stringify({ name: 'verify拆文_' + stamp, type: 'teardown' }) });
ok(td.status === 201, 'POST /books type=teardown', td.body?.kind);
const tdi = await j('/teardowns/' + td.body.id + '/import-text', { method: 'POST', body: JSON.stringify({ text: '# 第1章 拆文甲\n\n内容甲。\n\n# 第2章 拆文乙\n\n内容乙。', title: '拆文样本' }) });
ok(tdi.status === 200 && tdi.body?.chapters >= 1, 'POST /teardowns/import-text', tdi.body?.chapters);
const tda = await j('/teardowns/' + td.body.id + '/analyze', { method: 'POST', body: '{}' });
ok(tda.status === 200 && Array.isArray(tda.body?.units), 'POST /teardowns/analyze', tda.body?.units?.length);
const del = await j('/books/' + bookId, { method: 'DELETE' });
ok(del.status === 200 && del.body?.ok === true && !!del.body?.archived, 'DELETE /books/:id 软删归档', del.body);
ok((await j('/books/' + bookId)).status === 404, '软删后 GET 404');

console.log('\n=== ' + (checks - failures.length) + '/' + checks + ' 断言通过 ===');
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  // 用 exitCode 而非 process.exit()：Windows 上仍有 fetch 连接在飞时强退会触发 libuv 断言
  process.exitCode = 1;
} else {
  console.log('VERIFY API OK');
}

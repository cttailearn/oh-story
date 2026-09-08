// M1.7 e2e：假渠道全链路（创建书 → 跑 4 阶段 → 每步确认 → 看门禁/产物）
const BASE = 'http://127.0.0.1:3081/api';
async function j(path, init = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 新建一本书到 workspace（fake 也用真实目录）
const name = `e2e测试书_${Date.now().toString(36)}`;
const created = await j('/books', { method: 'POST', body: JSON.stringify({ name, type: 'novel-project' }) });
if (created.status !== 201) { console.log('create failed', created); process.exit(1); }
const bookId = created.body.id;
console.log('book:', bookId, name);

// 2) 跑 intake → concept → characters → outline（fake）
const stagesToRun = ['intake', 'concept', 'characters', 'outline'];
for (const stage of stagesToRun) {
  const r = await j(`/books/${bookId}/stages/${stage}/run`, { method: 'POST', body: JSON.stringify({ fake: true }) });
  console.log(`[run ${stage}]`, r.status, JSON.stringify(r.body ?? r));
  await sleep(300);
}

// 3) stages 视图
const s = await j(`/books/${bookId}/stages`);
console.log('\n=== stages ===');
for (const st of s.body?.stages ?? []) {
  console.log(`  ${st.status.padEnd(8)} rev${st.revision} ${st.id.padEnd(12)} ${st.title}`);
}

// 4) 每步确认（先确认 blocked/还是 review）
// 找当前 review 阶段并 approve；若 blocked 则先 edit_rerun
const afterRun = (await j(`/books/${bookId}/stages`)).body.stages;
for (const st of afterRun) {
  async function approveIt(a) {
    const rr = await j(`/books/${bookId}/stages/${st.id}/review`, { method: 'POST', body: JSON.stringify({ action: a, note: 'e2e' }) });
    console.log(`[review ${st.id} ${a}]`, rr.status, JSON.stringify(rr.body ?? rr));
  }
  if (st.status === 'review') await approveIt('approve');
  else if (st.status === 'blocked') await approveIt('reject_regen');
  await sleep(200);
}

// 5) 最终状态 + 产物核对
const finalStages = (await j(`/books/${bookId}/stages`)).body.stages;
console.log('\n=== final stages ===');
for (const st of finalStages ?? []) {
  console.log(`  ${st.status.padEnd(8)} ${st.id.padEnd(12)} ${st.title}`);
}
// 看产物文件
const book = (await j(`/books/${bookId}`)).body;
console.log('\nbook dir:', book.dir);
const tree = (await j(`/books/${bookId}/tree`)).body?.tree ?? [];
const flat = [];
function walk(ns) { for (const n of ns) { if (n.type === 'file') flat.push(n.path); if (n.children) walk(n.children); } }walk(tree);
console.log('files:', JSON.stringify(flat.slice(0, 30)));
console.log('\nE2E DONE');

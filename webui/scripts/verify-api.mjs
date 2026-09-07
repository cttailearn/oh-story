// 快速集成验证（curl 替代，确保 UTF-8）：mtime 冲突 + 正确写 + 门禁
const BASE = 'http://127.0.0.1:3081/api';

async function j(path, init) {
  const res = await fetch(BASE + path, init);
  let body = null;
  try { body = await res.json(); } catch { /* noop */ }
  return { status: res.status, body };
}

const { body: books } = await j('/books');
const novel = books.items.find((b) => b.kind === 'novel');
console.log('novel:', novel?.id, novel?.name);

const PATH = '正文/第001章_军宣新星.md';
const f = await j(`/files?path=${encodeURIComponent(PATH)}&book_id=${novel.id}`);
console.log('read mtime:', f.body.mtime, 'size:', f.body.size);

const wrong = await j('/files', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: PATH, content: 'x', mtime: f.body.mtime - 99999, book_id: novel.id }),
});
console.log('wrong-mtime ->', wrong.status, wrong.body?.error?.code);

const good = await j('/files', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: PATH, content: f.body.content + '\n', mtime: f.body.mtime, book_id: novel.id }),
});
console.log('correct-mtime ->', good.status, 'new mtime:', good.body?.mtime);

const gates = await j(`/books/${novel.id}/gates/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
console.log('gates blocking:', gates.body?.blocking);
for (const r of gates.body?.reports ?? []) {
  console.log(`  ${r.gate}: passed=${r.passed} blocking=${r.blocking?.length} warnings=${r.warnings?.length}`);
}

// 前端托管自检（无浏览器）：SPA 入口 / 路由回退 / API 404 / 书列表
// 用法：node scripts/verify-page.mjs [--base http://127.0.0.1:3081]（或 WEBUI_BASE）
const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ORIGIN = (argOf('--base', process.env.WEBUI_BASE) || 'http://127.0.0.1:3081').replace(/\/api$/, '').replace(/\/+$/, '');
const failures = [];
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else {
    failures.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
    console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  }
};

const root = await fetch(ORIGIN + '/');
const rootText = await root.text();
ok(root.status === 200 && rootText.includes('id="root"'), 'GET / 返回 SPA 入口', { status: root.status, len: rootText.length });

const spa = await fetch(ORIGIN + '/novels/nb_xxx');
ok(spa.status === 200 && (await spa.text()).includes('id="root"'), 'SPA 路由回退', spa.status);

const api = await fetch(ORIGIN + '/api/books/nope');
ok(api.status === 404 && (await api.text()).includes('NOT_FOUND'), 'GET /api/* 未命中 404 JSON', api.status);

const books = await fetch(ORIGIN + '/api/books');
const body = await books.json();
ok(books.status === 200 && Array.isArray(body.items), 'GET /api/books', { total: body.total });

console.log(failures.length ? '失败 ' + failures.length + ' 项' : 'VERIFY PAGE OK');
// 用 exitCode 而非 process.exit()：Windows 上仍有 fetch 连接在飞时强退会触发 libuv 断言
process.exitCode = failures.length ? 1 : 0;

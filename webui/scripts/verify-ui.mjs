// 浏览器端 UI 冒烟（playwright）：真实 Chromium 打开各页面，断言关键文案 + 收集 console/page 错误。
// 用法：node scripts/verify-ui.mjs [--base http://127.0.0.1:3081] [--shots <dir>]
// 前置：后端已启动且已 npm run build（由后端托管 dist/client）；playwright 从仓库根解析。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ORIGIN = (argOf('--base', process.env.WEBUI_BASE) || 'http://127.0.0.1:3081').replace(/\/api$/, '').replace(/\/+$/, '');
const SHOTS = argOf('--shots', join(process.cwd(), '.tmp-ui-shots'));

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

mkdirSync(SHOTS, { recursive: true });

// 准备一本书（UI 需要真实数据）
const api = ORIGIN + '/api';
const created = await fetch(api + '/books', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'ui校验书_' + Date.now().toString(36), type: 'novel', pipeline: 'long' }),
});
const book = await created.json();
if (!created.ok) {
  console.error('建书失败：', book);
  process.exitCode = 1;
  throw new Error('create book failed');
}
console.log('base: ' + ORIGIN + ' | book: ' + book.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const failedRequests = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (req) => failedRequests.push(req.url().replace(ORIGIN, '') + ' :: ' + (req.failure()?.errorText ?? '')));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 200));
});

const visit = async (path, expects, shot) => {
  await page.goto(ORIGIN + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const text = await page.textContent('body');
  for (const e of expects) ok(text.includes(e), path + ' 含「' + e + '」', text.slice(0, 120));
  if (shot) await page.screenshot({ path: join(SHOTS, shot) });
  return text;
};

await visit('/', ['oh', 'story', '书房'], 'shelf.png');
await visit('/projects/new', ['新建项目'], 'new-project.png');
await visit('/novels/new', ['新建小说', '需求录入'], 'new-novel.png');
await visit('/modules', ['模块库'], 'modules.png');
await visit('/export', ['导出与发布'], 'export.png');
await visit('/settings', ['设置'], 'settings.png');
const ws = await visit('/novels/' + book.id, [book.name], 'workspace.png');
ok(ws.length > 200, '工作台渲染内容', ws.length);
await visit('/novels/' + book.id + '/pipeline', ['流程看板', 'intake'], 'pipeline.png');
await visit('/novels/' + book.id + '/import-review', ['导入校对'], 'import-review.png');

await browser.close();

// SSE 长连接在页面切换时被浏览器主动关闭（ERR_ABORTED / ERR_CONNECTION_CLOSED）属于正常行为，单独归类
const sseClosed = failedRequests.filter((u) => u.includes('/jobs/events'));
const otherFailed = failedRequests.filter((u) => !u.includes('/jobs/events'));
const realErrors = errors.filter((e) => !e.includes('Failed to load resource'));
ok(realErrors.length === 0, '无 console/page 脚本错误', realErrors.slice(0, 5));
ok(otherFailed.length === 0, '无失败请求（SSE 断连除外）', otherFailed.slice(0, 5));
if (sseClosed.length) console.log('  · SSE 长连接随页面切换关闭 ' + sseClosed.length + ' 次（正常）');

console.log('\n=== ' + (checks - failures.length) + '/' + checks + ' 断言通过（截图：' + SHOTS + '）===');
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('VERIFY UI OK');
}

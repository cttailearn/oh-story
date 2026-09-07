// 用 playwright 截图验证 P0 书房 + P3 工作台（M0.5 手验收）
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:3081';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 抓取脚本错误
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 200));
});

await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: 'D:\\AI\\oh-story\\webui\\.tmp-screenshot-shelf.png' });
const shelfText = (await page.textContent('body')).slice(0, 400);

// 进入小说工作台
const books = await (await fetch(base + '/api/books')).json();
const novel = books.items.find((b) => b.kind === 'novel');
await page.goto(base + '/novels/' + novel.id + '?module=chapters', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: 'D:\\AI\\oh-story\\webui\\.tmp-screenshot-workspace.png' });
const wsText = (await page.textContent('body')).slice(0, 400);

// 状态看板
await page.goto(base + '/novels/' + novel.id + '?module=state', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: 'D:\\AI\\oh-story\\webui\\.tmp-screenshot-state.png' });
const stText = (await page.textContent('body')).slice(0, 300);

await browser.close();
console.log('=== SHELF ==='); console.log(shelfText);
console.log('=== WORKSPACE ==='); console.log(wsText);
console.log('=== STATE ==='); console.log(stText);
console.log('=== ERRORS (' + errors.length + ') ===');
errors.slice(0, 8).forEach((e) => console.log(e));

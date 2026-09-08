// 设置页「填 base_url + key → 获取模型 → 勾选 → 保存」端到端验证（真实 Chromium + 本地假网关，断言式）
// 用法：node scripts/verify-settings.mjs [--base http://127.0.0.1:3081] [--config <webui-config.json 路径>]
// 前置：后端已启动且已 npm run build；playwright 从仓库根解析。
// 安全性：不破坏既有配置 —— 只临时追加一个渠道，结束时按原样回写渠道列表（顺带回归「掩码回显不得覆盖真实密钥」）。
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockGateway, MOCK_MODELS } from './mock-gateway.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = (argOf('--base', process.env.WEBUI_BASE) || 'http://127.0.0.1:3081').replace(/\/+$/, '');
const CONFIG_PATH = argOf('--config', join(here, '..', '..', '.webui', 'webui-config.json'));
const KEY = 'sk-mock-SECRET-abcdef123456';
/** 每次运行用唯一渠道名，避免与历史残留/并发运行互相干扰 */
const CH_NAME = 'mock 渠道 ' + Date.now().toString(36);

const failures = [];
let checks = 0;
const ok = (cond, label, extra) => {
  checks++;
  if (cond) console.log('  ✓ ' + label);
  else { failures.push(label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};
const api = async (path, init) => {
  const res = await fetch(BASE + '/api' + path, { headers: init?.body ? { 'Content-Type': 'application/json' } : {}, ...init });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
};
const readConfigFile = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

const gw = await startMockGateway(0);
console.log('base: ' + BASE + ' | mock gateway: ' + gw.url + ' | config: ' + CONFIG_PATH);

const before = await api('/config');
const originalChannels = before.body?.channels ?? [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errs.push('console: ' + m.text().slice(0, 160)); });

try {
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  const addBtn = page.getByText('＋ 新增渠道');
  await addBtn.click();
  await page.waitForTimeout(300);

  // 定位刚追加的渠道（最后一个渠道卡片内的输入框）
  const card = page.locator('[data-channel-card]').last();
  await card.getByPlaceholder('渠道名').fill(CH_NAME);
  await card.getByPlaceholder('https://api.example.com/v1').fill(gw.url);
  await card.getByPlaceholder('API Key（sk-…）').fill(KEY);
  ok(true, '填写渠道名 / base_url / API Key');

  await card.getByText('⤓ 获取模型').click();
  await page.waitForTimeout(1500);
  const text = await page.textContent('body');
  ok(text.includes('获取到 ' + MOCK_MODELS.length + ' 个模型'), '拉取到 ' + MOCK_MODELS.length + ' 个模型', text.match(/获取到[^）]*/)?.[0]);
  ok(text.includes('mock-chat-pro') && text.includes('mock-image-xl'), '列表按对话/图像分组渲染');
  ok(text.includes('text-embedding-3-large'), 'embedding 归入「其它」分组');

  await card.getByRole('button', { name: 'mock-chat-pro', exact: true }).click();
  await card.getByRole('button', { name: 'mock-image-xl', exact: true }).click();
  await page.waitForTimeout(200);
  const modelsInput = card.locator('input[placeholder^="deepseek-v4-pro"]');
  const typedModels = await modelsInput.inputValue();
  ok(typedModels.includes('mock-chat-pro') && typedModels.includes('mock-image-xl'), '勾选写入模型目录', typedModels);

  await page.getByText('保存设置').click();
  await page.waitForTimeout(1200);
  ok((await page.textContent('body')).includes('配置已保存'), '保存成功提示');

  // 服务端 + 磁盘校验
  const after = await api('/config');
  const saved = (after.body?.channels ?? []).find((c) => c.name === CH_NAME);
  ok(!!saved, '渠道已保存');
  ok(saved?.base_url === gw.url, 'base_url 已保存', saved?.base_url);
  ok((saved?.models ?? []).slice().sort().join(',') === 'mock-chat-pro,mock-image-xl', '模型目录已保存', saved?.models);
  ok(String(saved?.api_key ?? '').includes('****'), 'GET /config 回显为掩码', saved?.api_key);

  const disk = readConfigFile();
  const diskCh = (disk.channels ?? []).find((c) => c.name === CH_NAME);
  ok(diskCh?.api_key === KEY, '配置文件存的是真实密钥（非掩码）', diskCh?.api_key);

  // 回归：把 GET 到的整份配置原样 PUT 回去，真实密钥不得被掩码覆盖
  await api('/config', { method: 'PUT', body: JSON.stringify(after.body) });
  const disk2 = readConfigFile();
  const diskCh2 = (disk2.channels ?? []).find((c) => c.name === CH_NAME);
  ok(diskCh2?.api_key === KEY, '掩码回显往返后密钥完好（回归）', diskCh2?.api_key);

  // 探测端点：错误 key 如实反馈上游 401；不传 key 回退已存密钥
  const bad = await api('/config/channels/probe', { method: 'POST', body: JSON.stringify({ base_url: gw.url, api_key: 'wrong' }) });
  ok(bad.body?.ok === false && String(bad.body?.msg).includes('401'), '错误 key → 上游 401 如实反馈', bad.body?.msg);
  const reuse = await api('/config/channels/probe', { method: 'POST', body: JSON.stringify({ base_url: gw.url, id: saved?.id }) });
  ok(reuse.body?.ok === true && (reuse.body?.chat ?? []).length === 2, '不传 key 时回退已存密钥', { ok: reuse.body?.ok, chat: reuse.body?.chat });
  const badUrl = await api('/config/channels/probe', { method: 'POST', body: JSON.stringify({ base_url: 'ftp://x' }) });
  ok(badUrl.status === 400, '非法 base_url → 400', badUrl.status);

  ok(errs.length === 0, '无 console/page 脚本错误', errs.slice(0, 3));
} finally {
  await browser.close();
  // 还原：只把临时渠道摘掉，原有渠道原样回写（掩码值不会覆盖真实密钥）
  const restore = await api('/config', { method: 'PUT', body: JSON.stringify({ channels: originalChannels }) });
  ok(restore.status === 200, '临时渠道已清理、原配置已还原', restore.status);
  await gw.close();
}

console.log('\n=== ' + (checks - failures.length) + '/' + checks + ' 断言通过 ===');
if (failures.length) { for (const f of failures) console.log('  - ' + f); process.exitCode = 1; }
else console.log('VERIFY SETTINGS OK');

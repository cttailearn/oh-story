// 一键冒烟（真实可靠基线）：临时 workspace 起真后端 → 跑 e2e-fake 断言 → 清理
// 用法：npm run smoke [-- --port 3098] [--keep]
// 说明：stdio 全用 inherit（不用管道），任何平台/受限环境下都能拿到子进程退出码。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webuiDir = join(here, '..');
const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const port = Number(argOf('--port', '3098')) || 3098;
const keep = process.argv.includes('--keep');
const root = mkdtempSync(join(tmpdir(), 'ohwebui-smoke-'));
const base = `http://127.0.0.1:${port}/api`;

console.log(`[smoke] workspace=${root} port=${port}`);
const server = spawn(process.execPath, ['server/index.mts', '--port', String(port), '--root', root], {
  cwd: webuiDir,
  stdio: 'inherit',
  // 只保留 warn/error，避免断言输出被 Fastify 请求日志淹没
  env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' },
});

function cleanup(code) {
  try {
    server.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  if (!keep) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows 文件占用时忽略 */
    }
  } else {
    console.log('[smoke] 保留 workspace: ' + root);
  }
  process.exit(code);
}

async function waitHealthy(timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(base + '/health');
      if (res.ok) return true;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

if (!(await waitHealthy())) {
  console.error('[smoke] 后端 30s 内未就绪，终止');
  cleanup(1);
}

// 前端托管自检：build 产物存在时，根路径必须返回 SPA（含 #root），/api 未命中必须 404 JSON
const origin = base.replace(/\/api$/, '');
const pageFailures = [];
const checkPage = async (path, fn, label) => {
  try {
    const res = await fetch(origin + path);
    const text = await res.text();
    if (!fn(res, text)) pageFailures.push(label + ` (status ${res.status})`);
    else console.log('  ✓ ' + label);
  } catch (e) {
    pageFailures.push(label + ' → ' + e.message);
  }
};
const hasDist = existsSync(join(webuiDir, 'dist', 'client', 'index.html'));
if (hasDist) {
  await checkPage('/', (r, t) => r.status === 200 && t.includes('id="root"'), 'GET / 返回 SPA');
  await checkPage('/novels/whatever', (r, t) => r.status === 200 && t.includes('id="root"'), 'SPA 路由回退');
}
await checkPage('/api/__nope__', (r) => r.status === 404, 'GET /api/__nope__ 返回 404');

const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['scripts/e2e-fake.mjs', '--base', base], {
    cwd: webuiDir,
    stdio: 'inherit',
  });
  child.on('close', (c) => resolve(c ?? 1));
});

if (pageFailures.length) {
  console.error('[smoke] 前端托管自检失败：');
  for (const f of pageFailures) console.error('  - ' + f);
  cleanup(1);
}

console.log(code === 0 ? '[smoke] ✅ 通过' : '[smoke] ❌ 失败（exit ' + code + '）');
cleanup(code);

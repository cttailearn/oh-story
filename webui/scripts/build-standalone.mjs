// oh-story WebUI 单文件打包（Node SEA，可选）——生成 bundle + sea-config，并给出 postject/注入后续步骤
// 用法：npm run pack:standalone
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(fileURLToPath(new URL("..", import.meta.url)));
const outDir = join(rootDir, 'dist', 'standalone');
mkdirSync(outDir, { recursive: true });

const steps = [];
try {
  const esbuildModule = await import('esbuild');
  await esbuildModule.build({
    entryPoints: [join(rootDir, 'server', 'index.mts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(outDir, 'entry.mjs'),
    external: ['better-sqlite3'],
    logLevel: 'warning',
  });
  console.log('bundle 已生成: dist/standalone/entry.mjs');
  const seaConfig = { main: 'entry.mjs', output: 'sea-prep.blob', disableExperimentalSEAWarning: true, useCodeCache: true };
  writeFileSync(join(outDir, 'sea-config.json'), JSON.stringify(seaConfig, null, 2), 'utf8');
  console.log('sea-config.json 已生成');
  steps.push('1) 拷贝本机 node.exe 到 dist/standalone/webui.exe');
  steps.push('2) cd dist/standalone && node --experimental-sea-config sea-config.json');
  steps.push('3) npx postject webui.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
  steps.push('4) 原生模块 better-sqlite3 需随包放置（.node 二进制）');
  steps.push('5) 运行 .\\webui.exe --port 3081 --root <workspace>');
} catch (e) {
  console.log('bundle 阶段失败: ' + (e.message || String(e)));
  console.log('备选：npx pkg server/index.mts --target node22-win-x64 --output webui.exe（同样需携带 better-sqlite3 原生模块）');
}

console.log('单文件打包后续步骤（Node SEA）：');
steps.forEach(function (s) { console.log(' - ' + s); });
console.log('详细说明见 webui/README.md「发布 / 单文件打包」。');

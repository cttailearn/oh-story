#!/usr/bin/env node
// check:no-python —— 扫描 server/ 源码，禁止 .py/.sh 运行时引用（standalone-webui §13 风险对策）
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const root = join(import.meta.dirname ?? process.cwd(), '..');
const serverDir = join(root, 'server');

const BANNED_REFS = [
  /\bspawn\s*\(\s*['"](python|py)['"]/i,
  /child_process[^]*['"](python|py)['"]/i,
  /\bexec(File)?\s*\(\s*['"](python|sh|bash)['"]/i,
  /\.py\b/,
  /\.sh\b/,
  /python3? /,
];

function walk(dir) {
  const out = [];
  for (const d of readdirSync(dir)) {
    const p = join(dir, d);
    if (statSync(p).isDirectory()) {
      if (d === 'node_modules' || d === '__migration_spec__') continue;
      out.push(...walk(p));
    } else if (extname(p) === '.ts' || extname(p) === '.mts') {
      out.push(p);
    }
  }
  return out;
}

const files = walk(serverDir);
const offenders = [];
for (const f of files) {
  const content = readFileSync(f, 'utf8');
  for (const re of BANNED_REFS) {
    if (re.test(content)) {
      // 去掉注释行内的误报
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue; // 跳过注释
        if (re.test(line)) {
          offenders.push(`${relative(root, f)}:${i + 1}: ${re.source}  <- ${line.trim().slice(0, 80)}`);
        }
      }
    }
  }
}

if (offenders.length > 0) {
  console.error('❌ check:no-python 失败 —— server/ 中存在 Python/bash 运行时引用：');
  for (const o of offenders) console.error('  ' + o);
  process.exit(1);
}
console.log('✅ check:no-python 通过：server/ 无 Python/bash 运行时依赖');

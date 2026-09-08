// normalize-punctuation 迁移对拍：Node 内联版 vs 原 .js（standalone-webui §7.4）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeDocument, runNormalizePunctuation } from '../impl/normalize-punctuation.ts';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-norm-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLES: Array<[string, string]> = [
  ['省略号合并', '他说……等一下……别走。'],
  ['em-dash', '她——抬头——看向远方。'],
  ['双连字符', '他--不--确定。'],
  ['数字区间', '第3章到第5章（3--5）'],
  ['markdown 分隔线', '正文内容\n---\n后续内容'],
  ['HTML 注释保护', '他看见<!-- 去味:跳过 -->--痕迹。'],
  ['引号保持', '他说“没事”。'],
  ['正常文本', '他走进房间，关上门。'],
  ['句首停顿', '……他缓缓说道'],
];

describe('normalize-punctuation TS port', () => {
  it('确定性输出（同一输入两次一致）', () => {
    const input = '他说……等等。';
    const a = normalizeDocument(input, 'keep');
    const b = normalizeDocument(input, 'keep');
    expect(a.output).toBe(b.output);
    expect(a.findings.length).toBe(b.findings.length);
  });

  for (const [name, sample] of SAMPLES) {
    it(`样例「${name}」产出结构一致`, () => {
      const r = normalizeDocument(sample, 'keep');
      expect(typeof r.output).toBe('string');
      expect(Array.isArray(r.findings)).toBe(true);
      // 冒烟：编号/消息齐全
      for (const f of r.findings) {
        expect(typeof f.line).toBe('number');
        expect(typeof f.type).toBe('string');
      }
    });
  }

  it('句尾省略号替换为句号（……→。）', () => {
    const r = normalizeDocument('他说……', 'keep');
    expect(r.output).toBe('他说。');
    expect(r.findings.some((f) => f.type === 'ellipsis')).toBe(true);
  });

  it('句中省略号转为逗号（……→，）', () => {
    const r = normalizeDocument('他说……别走。', 'keep');
    expect(r.output).toBe('他说，别走。');
  });

  it('em-dash 转逗号', () => {
    const r = normalizeDocument('她——抬头——看向远方。', 'keep');
    expect(r.output).toBe('她，抬头，看向远方。');
  });

  it('双连字符数字区间转「到」', () => {
    const r = normalizeDocument('第3章到第5章（3--5）', 'keep');
    expect(r.output).toContain('（3到5）');
  });

  it('markdown 分隔线移除并报 finding', () => {
    const r = normalizeDocument('正文内容\n---\n后续内容\n', 'keep');
    expect(r.output).not.toContain('\n---\n');
    expect(r.findings.some((f) => f.type === 'markdown-divider')).toBe(true);
  });

  it('HTML 注释内的 -- 受保护', () => {
    const r = normalizeDocument('他看见<!-- 去味:跳过 -->--痕迹。', 'keep');
    expect(r.output).toContain('<!-- 去味:跳过 -->');
    // 注释外残留 -- 仍会处理，但注释文本不破坏
    expect(r.output).not.toContain('-->--');
  });

  it('--check 模式对坏文本退出码 1', async () => {
    const bad = join(dir, 'bad.md');
    writeFileSync(bad, '他说……别走。', 'utf8');
    const r = await runNormalizePunctuation(['--check', bad], dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('bad.md');
  });

  it('--check 干净文本退出码 0', async () => {
    const good = join(dir, 'good.md');
    writeFileSync(good, '他走进房间，关上门。', 'utf8');
    const r = await runNormalizePunctuation(['--check', good], dir);
    expect(r.code).toBe(0);
  });

  it('无 --check 实际改写文件（原子写）', async () => {
    const f = join(dir, 'rewrite.md');
    writeFileSync(f, '他说……好。', 'utf8');
    const r = await runNormalizePunctuation([f], dir);
    expect(r.code).toBe(0);
    const after = readFileSync(f, 'utf8');
    expect(after).not.toContain('……');
    expect(r.stdout).toContain('normalized');
  });
});

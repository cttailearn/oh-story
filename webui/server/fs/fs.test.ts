import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSafe,
  readText,
  writeTextLocked,
  listDir,
  readTree,
} from './index.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ohwebui-fs-'));
  mkdirSync(join(root, '正文'), { recursive: true });
  writeFileSync(join(root, '正文', '第001章_a.md'), '第一章内容', 'utf8');
  mkdirSync(join(root, '大纲', '细纲'), { recursive: true });
  writeFileSync(join(root, '大纲', '细纲', '第001章.md'), '细纲', 'utf8');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fs layer', () => {
  it('resolveSafe 拒绝路径穿越', () => {
    expect(() => resolveSafe(root, '../secret.txt')).toThrow('INVALID_PATH');
    expect(() => resolveSafe(root, '正文/../../x')).toThrow('INVALID_PATH');
    expect(() => resolveSafe(root, '/etc/passwd')).toThrow('INVALID_PATH');
    expect(() => resolveSafe(root, 'C:\\Windows\\x')).toThrow('INVALID_PATH');
  });

  it('resolveSafe 正常路径解析在 root 内', () => {
    const abs = resolveSafe(root, '正文/第001章_a.md');
    expect(abs.startsWith(root)).toBe(true);
    expect(abs.endsWith('第001章_a.md')).toBe(true);
  });

  it('readText 读内容 + mtime', () => {
    const { content, mtime } = readText(root, '正文/第001章_a.md');
    expect(content).toBe('第一章内容');
    expect(mtime).toBeGreaterThan(0);
  });

  it('writeTextLocked mtime 冲突 → 409 语义异常', () => {
    const { mtime } = readText(root, '正文/第001章_a.md');
    // 正确 mtime：写入成功
    const r = writeTextLocked(root, '正文/第001章_a.md', '新内容', mtime);
    expect(r.mtime).toBeGreaterThan(0);
    expect(readText(root, '正文/第001章_a.md').content).toBe('新内容');
    // 错误 mtime：抛 CONFLICT
    expect(() => writeTextLocked(root, '正文/第001章_a.md', 'x', mtime - 10000)).toThrow(
      /CONFLICT|外部修改/,
    );
  });

  it('writeTextLocked 新建文件', () => {
    const r = writeTextLocked(root, '正文/第002章_b.md', '第二章', null);
    expect(r.mtime).toBeGreaterThan(0);
    expect(readText(root, '正文/第002章_b.md').content).toBe('第二章');
  });

  it('listDir 单层（目录优先）', () => {
    const entries = listDir(root, '');
    const names = entries.map((e) => e.name);
    expect(names).toContain('正文');
    expect(names).toContain('大纲');
  });

  it('readTree 递归结构', () => {
    const tree = readTree(root);
    const zheng = tree.find((t) => t.name === '正文')!;
    expect(zheng.type).toBe('dir');
    expect(zheng.children!.some((c) => c.name === '第001章_a.md')).toBe(true);
  });
});

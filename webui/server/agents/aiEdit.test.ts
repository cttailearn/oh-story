// AI 编辑单测：makeLineDiff / applyRange / runAiEdit（fake 路径）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLineDiff, applyRange, runAiEdit } from './aiEdit.ts';
import { initConfig } from '../config/index.ts';
import { AiRuntime } from '../ai/runtime.ts';

let dir: string;
let bookDir: string;
let ai: AiRuntime;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ohwebui-aiedit-'));
  initConfig(join(dir, 'cfg'));
  bookDir = join(dir, 'book');
  mkdirSync(join(bookDir, '设定'), { recursive: true });
  ai = new AiRuntime();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('makeLineDiff', () => {
  it('相同文本返回空 diff', () => {
    expect(makeLineDiff('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });
  it('中间一块替换：公共前缀与后缀保留', () => {
    const d = makeLineDiff('如意图\n地网开城\n苍穹九变', '如意图\n换新段落\n变强了\n苍穹九变');
    expect(d.filter((x) => x.type === 'del')).toHaveLength(1);
    expect(d.filter((x) => x.type === 'add')).toHaveLength(1);
    expect(d.find((x) => x.type === 'del')!.line).toBe(2);
    expect(d.find((x) => x.type === 'add')!.text).toContain('换新段落');
  });
});

describe('applyRange', () => {
  it('只替换选区字符区间', () => {
    expect(applyRange('一二三四五', { start: 1, end: 4 }, 'XYZ')).toBe('一XYZ五');
  });
});

describe('runAiEdit（fake）', () => {
  it('整页 rewrite：返回可采纳 diff（applied:false）且不落盘', async () => {
    writeFileSync(join(bookDir, '正文.txt'), '第一段。\n第二段。\n', 'utf8');
    const r = await runAiEdit(ai, { bookId: 'nb_x', bookDir, bookName: '测试' }, {
      mode: 'rewrite',
      target: { path: '正文.txt' },
      demand: { kind: 'hook', custom: '' },
      fake: true,
    });
    expect(r.applied).toBe(false);
    expect(r.edit_id.startsWith('ed_')).toBe(true);
    expect(r.diff.length).toBeGreaterThan(0);
    expect(r.diff.some((d) => d.type === 'add')).toBe(true);
    // 不应落盘：文件内容保持原样
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(bookDir, '正文.txt'), 'utf8')).toBe('第一段。\n第二段。\n');
    expect(r.note).toContain('尚未落盘');
  });
  it('选区 rewrite：diff 只改选区', async () => {
    const r = await runAiEdit(ai, { bookId: 'nb_x', bookDir, bookName: '测试' }, {
      mode: 'rewrite',
      target: { path: '正文.txt', range: { start: 3, end: 19 } },
      demand: { kind: 'de-ai' },
      fake: true,
    });
    expect(r.diff.some((d) => d.type === 'add')).toBe(true);
    // 拼接校验：original + add 内容含选区被替换后的文本
    const add = r.diff.filter((d) => d.type === 'add').map((d) => d.text).join('\n');
    expect(add).toContain('AI 编辑（demo）');
  });
  it('无渠道时默认降级 fake（不抛错）', async () => {
    const r = await runAiEdit(ai, { bookId: 'nb_x', bookDir, bookName: '测试' }, {
      mode: 'rewrite',
      target: { path: '正文.txt' },
      demand: { kind: 'custom', custom: '压缩到 800 字' },
    });
    expect(r.diff).toBeDefined();
    expect(r.note).toContain('尚未落盘');
  });
  it('目标不存在 → NOT_FOUND', async () => {
    await expect(runAiEdit(ai, { bookId: 'nb_x', bookDir, bookName: '测试' }, {
      mode: 'rewrite',
      target: { path: '不存在.md' },
      demand: { kind: 'custom' },
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

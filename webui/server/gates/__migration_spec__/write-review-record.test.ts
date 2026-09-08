// write-review-record 迁移对拍：Node 内联版保持 CLI/模板契约（§7.4）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReviewRecord, runWriteReviewRecord } from '../impl/write-review-record.ts';

let project: string;
let dataPath: string;

const BASE_DATA = {
  chapter: 12,
  chapter_name: '老兵的故事',
  check1: { last_committed_chapter: 11, state_revision: 37, ok: true, note: '衔接正常' },
  check2: {
    items: [
      { item: '核心事件', ok: true, note: '' },
      { item: '禁止提前释放', ok: false, note: '第3段提前带出天机阁' },
    ],
  },
  check3: { ai_blocking: 0, deg_blocking: 0, note: '无命中' },
  findings: [{ level: 'S2', category: 'consistency', desc: '描述', disposition: '已修' }],
  conclusion: '可进入下一章',
};

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'ohwebui-review-'));
  mkdirSync(join(project, '正文'), { recursive: true });
  mkdirSync(join(project, '大纲'), { recursive: true });
  // 带零填充章号的正文文件 → 记录文件名应对齐（第012章）
  writeFileSync(join(project, '正文', '第012章_老兵的故事.md'), '正文', 'utf8');
  dataPath = join(project, 'review.json');
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('write-review-record TS port', () => {
  it('生成记录：文件名章号与正文对齐（第012章）', async () => {
    writeFileSync(dataPath, JSON.stringify(BASE_DATA), 'utf8');
    const r = await writeReviewRecord(['--project', project, '--data', dataPath], project);
    expect(r.token).toBe('012');
    expect(r.file.endsWith('第012章.md')).toBe(true);
    const out = readFileSync(r.file, 'utf8');
    expect(out).toContain('# 正文审查 — 第12章 老兵的故事');
    expect(out).toContain('last_committed_chapter=11');
    expect(out).toContain('state_revision=37');
    expect(out).toContain('第3段提前带出天机阁');
    expect(out).toContain('check-ai-patterns blocking=0、check-degeneration blocking=0；无命中');
    expect(out).toContain('可进入下一章');
  });

  it('fail-closed：查3 blocking>0 拒绝生成', async () => {
    const bad = { ...BASE_DATA, check3: { ai_blocking: 2, deg_blocking: 0, note: '有命中' } };
    writeFileSync(dataPath, JSON.stringify(bad), 'utf8');
    await expect(
      writeReviewRecord(['--project', project, '--data', dataPath], project),
    ).rejects.toThrow(/查3 禁用词 Gate 未过/);
  });

  it('--allow-blocking 放行', async () => {
    const bad = { ...BASE_DATA, check3: { ai_blocking: 1, deg_blocking: 0, note: '见结论' } };
    writeFileSync(dataPath, JSON.stringify(bad), 'utf8');
    const r = await writeReviewRecord(['--project', project, '--data', dataPath, '--allow-blocking'], project);
    expect(r.file).toContain('第012章.md');
  });

  it('必填字段缺失报错', async () => {
    const incomplete = { ...BASE_DATA };
    delete (incomplete as any).conclusion;
    writeFileSync(dataPath, JSON.stringify(incomplete), 'utf8');
    await expect(
      writeReviewRecord(['--project', project, '--data', dataPath], project),
    ).rejects.toThrow(/缺少必填字段 conclusion/);
  });

  it('CLI 层 runWriteReviewRecord 退出码语义', async () => {
    const good = { ...BASE_DATA };
    writeFileSync(dataPath, JSON.stringify(good), 'utf8');
    const ok = await runWriteReviewRecord(['--project', project, '--data', dataPath], project);
    expect(ok.code).toBe(0);
    const bad = { ...BASE_DATA, check3: { ai_blocking: 5, deg_blocking: 0 } };
    writeFileSync(dataPath, JSON.stringify(bad), 'utf8');
    const fail = await runWriteReviewRecord(['--project', project, '--data', dataPath], project);
    expect(fail.code).toBe(1);
    expect(fail.stderr).toContain('查3 禁用词 Gate 未过');
  });

  it('记录文件可被 project-consistency 识别（.md 存在）', async () => {
    expect(existsSync(join(project, '大纲', '审查记录', '正文审查_第012章.md'))).toBe(true);
  });
});

// write-review-record.ts — 生成「正文审查_第{N}章.md」写章三查落盘记录（⭐ Node 化移植）
// 行为与原 skills/story-long-write/scripts/write-review-record.js 一致：机械字段自动填充、
// fail-closed（查3 blocking>0 拒绝生成，除非 --allow-blocking）、章号宽度与正文文件对齐。
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { resolve, join, relative } from 'node:path';

export interface ReviewData {
  chapter: number;
  chapter_name?: string;
  check1: { last_committed_chapter: number; state_revision: number; ok?: boolean; note?: string };
  check2: { items: Array<{ item: string; ok?: boolean; note?: string }> };
  check3: { ai_blocking: number; deg_blocking: number; note?: string };
  findings?: Array<{ level?: string; category?: string; desc?: string; disposition?: string }>;
  conclusion: string;
}

export async function runWriteReviewRecord(
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  try {
    const report = await writeReviewRecord(argv, cwd);
    out.push(`WriteReview 落盘：${relative(resolve(cwd), report.file)}`);
    out.push(
      `  第${report.token}章 / 衔接=${report.linked ? '正常' : '异常'} / blocking=${report.aiBlocking}/${report.degBlocking} / 结论=${report.conclusion}`,
    );
    return { code: 0, stdout: out.join('\n') + '\n', stderr: '' };
  } catch (e: any) {
    if (e?.type === 'usage') {
      return { code: 2, stdout: '', stderr: e.message };
    }
    return { code: 1, stdout: '', stderr: `[ERROR] write-review-record: ${e.message}` };
  }
}

interface ReviewWriteResult {
  file: string;
  token: string;
  linked: boolean;
  aiBlocking: number;
  degBlocking: number;
  conclusion: string;
}

export async function writeReviewRecord(
  argv: string[],
  cwd: string,
): Promise<ReviewWriteResult> {
  const args = parseArgs(argv);
  const project = resolve(cwd, args.project);
  if (!existsSync(project) || !statSync(project).isDirectory()) {
    throw Object.assign(new Error(`项目根不存在或不是目录：${project}`), { type: 'usage' });
  }

  let dataPath = resolve(cwd, args.data);
  if (!existsSync(dataPath)) {
    const alt = join(project, args.data);
    if (existsSync(alt)) dataPath = alt;
  }
  let data: ReviewData;
  try {
    data = JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch (e: any) {
    throw new Error(`读取/解析 ${args.data} 失败：${e.message}`);
  }

  mustHave(data, 'chapter', 'chapter（章号）');
  mustPosInt(data.chapter, 'chapter');
  const chapter = Number(data.chapter);
  mustHave(data.check1, 'last_committed_chapter', 'check1.last_committed_chapter');
  mustNonNegInt(data.check1.last_committed_chapter, 'check1.last_committed_chapter');
  mustHave(data.check1, 'state_revision', 'check1.state_revision');
  mustNonNegInt(data.check1.state_revision, 'check1.state_revision');
  mustHave(data.check2, 'items', 'check2.items（查2 差异列表）');
  if (!Array.isArray(data.check2.items)) throw new Error('check2.items 必须是数组');
  const items = data.check2.items.filter((it) => it && typeof it === 'object');
  if (items.length === 0) throw new Error('check2.items 必须是非空数组（逐项列出细纲兑现核对）');
  mustHave(data.check3, 'ai_blocking', 'check3.ai_blocking');
  mustNonNegInt(data.check3.ai_blocking, 'check3.ai_blocking');
  mustHave(data.check3, 'deg_blocking', 'check3.deg_blocking');
  mustNonNegInt(data.check3.deg_blocking, 'check3.deg_blocking');
  mustHave(data, 'conclusion', 'conclusion（结论）');

  const ai = data.check3.ai_blocking;
  const deg = data.check3.deg_blocking;
  if ((ai > 0 || deg > 0) && !args.allowBlocking) {
    throw new Error(
      `查3 禁用词 Gate 未过：check-ai-patterns blocking=${ai}、check-degeneration blocking=${deg}。` +
        ' 先改写正文清零再生成记录；确属误报需记录进展可加 --allow-blocking',
    );
  }

  const lines: string[] = [];
  lines.push(`# 正文审查 — 第${chapter}章${data.chapter_name ? ' ' + data.chapter_name : ''}`.trimEnd());
  lines.push('');
  const c1Ok = data.check1.ok !== false;
  lines.push(
    `- 查1 追踪状态（写前）：last_committed_chapter=${data.check1.last_committed_chapter} / ` +
      `state_revision=${data.check1.state_revision}；衔接 ${c1Ok ? '正常' : data.check1.note || '需说明'}`,
  );
  lines.push('- 查2 细纲兑现（写后）：差异列表——');
  for (const it of items) {
    const note = typeof it.note === 'string' && it.note ? it.note : '';
    lines.push(`  - ${it.item}：${it.ok === false ? '✗' : '✓'}${note ? '（' + note + '）' : ''}`);
  }
  const safeNote =
    typeof data.check3.note === 'string' && data.check3.note
      ? data.check3.note
      : ai + deg === 0
        ? '无命中'
        : '见结论文档';
  lines.push(`- 查3 禁用词 Gate（写后）：check-ai-patterns blocking=${ai}、check-degeneration blocking=${deg}；${safeNote}`);
  lines.push('');
  lines.push('## 发现（S1-S4）');
  const findings = (Array.isArray(data.findings) ? data.findings : []).filter((f) => f && typeof f === 'object');
  if (findings.length === 0) {
    lines.push('');
    lines.push('- 无');
  } else {
    for (const f of findings) {
      lines.push('');
      lines.push(`- [${f.level || 'S4'}][${f.category || 'consistency'}] ${f.desc || ''}；处置：${f.disposition || '待确认'}`);
    }
  }
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 本章完成度：${data.conclusion}`);

  const token = chapterToken(project, chapter);
  const outDir = join(project, '大纲', '审查记录');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `正文审查_第${token}章.md`);
  writeFileSync(out, lines.join('\n') + '\n', 'utf8');

  return { file: out, token, linked: c1Ok, aiBlocking: ai, degBlocking: deg, conclusion: data.conclusion };
}

const USAGE = 'Usage: node write-review-record.js --project <项目根> --data <review.json> [--allow-blocking]';

function parseArgs(argv: string[]): { project: string; data: string; allowBlocking: boolean } {
  const args: { project?: string; data?: string; allowBlocking: boolean } = { allowBlocking: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--project' && i + 1 < argv.length) args.project = argv[++i]!;
    else if (a === '--data' && i + 1 < argv.length) args.data = argv[++i]!;
    else if (a === '--allow-blocking') args.allowBlocking = true;
    else throw Object.assign(new Error(USAGE), { type: 'usage' });
  }
  if (!args.project || !args.data) {
    throw Object.assign(new Error(USAGE), { type: 'usage' });
  }
  return { project: args.project, data: args.data, allowBlocking: args.allowBlocking };
}

function mustHave(obj: any, key: string, label: string): void {
  const v = obj == null ? undefined : obj[key];
  if (v === undefined || v === null || v === '') throw new Error(`缺少必填字段 ${label}（${key}）`);
}

function mustPosInt(v: unknown, label: string): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new Error(`${label} 必须是正整数（number 类型，得到 ${JSON.stringify(v)}）`);
  }
}
function mustNonNegInt(v: unknown, label: string): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`${label} 必须是非负整数（number 类型，得到 ${JSON.stringify(v)}）`);
  }
}

function chapterToken(project: string, chapter: number): string {
  try {
    const dir = join(project, '正文');
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        const m = f.match(/^第(\d+)章/);
        if (m && parseInt(m[1]!, 10) === chapter) return m[1]!;
      }
    }
  } catch {
    /* 目录不可读时退回裸章号 */
  }
  return String(chapter);
}

// AI 需求式编辑（agents-runtime §4 / ai-edit-spec）
// 无状态辅助小工具：不占 stage 状态机，只记 audit + 成本。产物 = diff（applied:false），由前端确认后落盘。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AiRuntime } from '../ai/runtime.ts';
import { getConfig } from '../config/index.ts';
import { runRealAgent } from './execute.ts';
import { roleFor } from './roles.ts';


export type AiEditMode = 'rewrite' | 'insert' | 'fix-gates';

export interface AiEditRequest {
  mode: AiEditMode;
  target: { path: string; range?: { start: number; end: number } } | 'new';
  demand: { kind: string; custom?: string; params?: Record<string, string | number> };
  refs?: string[];
  model_role?: 'writer' | 'architect' | 'checker';
  tone?: string;
  intensity?: number;
  fake?: boolean;
}

export interface DiffHunk {
  type: 'add' | 'del';
  line: number;
  text: string;
}

export interface AiEditResult {
  edit_id: string;
  mode: AiEditMode;
  target: string;
  diff: DiffHunk[];
  applied: false;
  note: string;
  cost_cents: number;
  /** 是否为 demo 假渠道产物（非真实模型输出）——必须显式回传，避免假结果被当成真结果采纳 */
  fake: boolean;
  /** 采纳后的完整文件内容（前端直接 PUT /files 落盘） */
  resultText: string;
  gates_hint?: { after_fix?: boolean };
}

/** 需求模板（ai-edit-spec §2 示例子集；其余由前端组合 custom） */
const DEMAND_PROMPTS: Record<string, string> = {
  hook: '把结尾改写成更强的悬念/转折，保留前文事实。',
  opening: '重写开头，前 3 句就要抓住读者（冲突/悬念/画面起手）。',
  condense: '删除复述与无功能过场，压缩篇幅但不丢关键信息。',
  pov: '改为第三人称/受限视角，全章人称一致。',
  'de-ai': '消除 AI 腔：拆分长句、去排比口号、语料口语化。',
  foreshadow: '在不破坏本章事实前提下埋一处可收回伏笔。',
  deepen: '补强角色动机链，贴合既有设定与语言风格。',
  arc: '为当前角色规划下一阶段的弧线（阶段目标/验收/渐变轨迹）。',
  voice: '提炼角色语言风格档案（称呼/口头禅/句式）。',
  fill: '圆场设定漏洞，不得与既有设定冲突。',
  expand: '在保持风格一致的前提下扩展现有小节。',
  trace: '整理当前未收伏笔清单（只读输出，不修改文件）。',
  risk: '诊断本章与追踪状态的一致性风险（只读输出）。',
  custom: '',
};

function estTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** 行级 diff：公共前缀/后缀 -> 中间单块替换（ai-edit-spec §3） */
export function makeLineDiff(oldText: string, newText: string, baseLine = 1): DiffHunk[] {
  if (oldText.trimEnd() === newText.trimEnd()) return [];
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const delLines = oldLines.slice(prefix, oldLines.length - suffix);
  const addLines = newLines.slice(prefix, newLines.length - suffix);
  const startLine = baseLine + prefix;
  const hunks: DiffHunk[] = [];
  if (delLines.length > 0) hunks.push({ type: 'del', line: startLine, text: delLines.join('\n') });
  if (addLines.length > 0) hunks.push({ type: 'add', line: startLine, text: addLines.join('\n') });
  return hunks;
}

/** 依据选区把新文本只替换该区间（区间为字符偏移） */
export function applyRange(oldText: string, range: { start: number; end: number }, newSegment: string): string {
  const a = Math.max(0, range.start);
  const b = Math.min(oldText.length, range.end);
  return oldText.slice(0, a) + newSegment + oldText.slice(b);
}

/**
 * 执行一次 AI 编辑。
 */
export async function runAiEdit(
  ai: AiRuntime,
  opts: { bookId: string; bookDir: string; bookName: string },
  req: AiEditRequest,
): Promise<AiEditResult> {
  const { bookDir } = opts;
  const demandPrompt = DEMAND_PROMPTS[req.demand.kind] ?? DEMAND_PROMPTS.custom;
  let userInstruction = req.demand.custom ? String(req.demand.custom) : demandPrompt || '按需求修改。';
  if (req.demand.params) {
    for (const [k, v] of Object.entries(req.demand.params)) {
      userInstruction = userInstruction.split('{' + k + '}').join(String(v));
      userInstruction = userInstruction.split('「' + k + '」').join(String(v));
    }
  }
  const toneLine = req.tone ? ('语气：' + req.tone + '。') : '';
  const role = req.model_role ?? 'writer';
  const roleSpec = roleFor(role);
  const editId = 'ed_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let originalText = '';
  let targetPath = '';
  if (req.target === 'new') {
    targetPath = '设定/ai-新条目-' + editId + '.md';
  } else {
    targetPath = req.target.path;
    const abs = join(bookDir, targetPath);
    if (!existsSync(abs)) {
      throw Object.assign(new Error('目标文件不存在：' + targetPath), { code: 'NOT_FOUND' });
    }
    originalText = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  }

  const range = req.target !== 'new' ? req.target.range : undefined;
  let contextText = originalText;
  if (range && range.start >= 0 && range.end > range.start) {
    contextText = originalText.slice(Math.max(0, range.start), Math.min(originalText.length, range.end));
  } else if (originalText.length > 4000) {
    contextText = originalText.slice(0, 4000) + '\n\n…（后文省略，如需改全文请分段）…';
  }

  const system = '你是 oh-story 的【' + roleSpec.id + '】。你的任务是按用户需求编辑目标文件，不改动与需求无关的事实/编号。' + toneLine;
  const taskText =
    '## 目标文件\n' + targetPath + '\n\n' +
    '## 当前内容' + (range ? '（选区）' : '') + '\n' + (contextText || '（空）') + '\n\n' +
    '## 你的任务\n' + userInstruction + '\n' +
    '请直接输出编辑后的完整文件内容（保持 markdown 结构）。';
  const bundle = {
    system,
    blocks: [
      { kind: 'facts', title: '目标文件', text: targetPath, tokens: estTokens(targetPath) },
      { kind: 'task', title: 'AI 编辑需求', text: taskText, tokens: estTokens(taskText) },
    ],
    user_message: taskText,
    budget: { system: estTokens(system), blocks: estTokens(taskText) },
  };

  // demo 路径：显式 fake:true，或未配置任何渠道时的降级（保持可用，但结果必须标注为 demo）
  const fake = (req.fake ?? false) || !ai.hasAnyChannel();
  let newText: string;
  let costCents = 0;
  if (fake) {
    const marker = '<!-- AI 编辑（demo）：' + userInstruction.replace(/[*/]/g, '') + ' -->';
    newText = range ? (contextText.trimEnd() + '\n\n' + marker + '\n') : (originalText.trimEnd() + '\n\n' + marker + '\n');
  } else {
    const r = getConfig().model_routing?.[role];
    if (!r) throw Object.assign(new Error('MODEL_ROUTING_MISSING: ' + role), { code: 'CHANNEL_UNCONFIGURED' });
    const result = await runRealAgent(ai, {
      bundle: bundle as any,
      model: { channelId: r.channel, modelId: r.model },
    });
    newText = result.text.trimEnd();
    costCents = result.usage.cost_cents;
  }

  const finalText = range ? applyRange(originalText, range, newText) : newText;
  const diff = makeLineDiff(originalText, finalText);
  const note =
    (fake ? '【demo 假渠道】' : '') +
    'AI 编辑（' +
    req.mode +
    '·' +
    req.demand.kind +
    '）已生成 diff（' +
    diff.filter((d) => d.type === 'add').length +
    ' + / ' +
    diff.filter((d) => d.type === 'del').length +
    ' -），尚未落盘。' +
    (fake ? ' 本次为假渠道产物，不代表真实模型输出。' : '');

  return {
    edit_id: editId,
    mode: req.mode,
    target: targetPath,
    diff,
    applied: false,
    note,
    cost_cents: costCents,
    fake,
    resultText: finalText.endsWith('\n') ? finalText : finalText + '\n',
    gates_hint: req.mode === 'fix-gates' ? { after_fix: true } : undefined,
  };
}

export { DEMAND_PROMPTS };

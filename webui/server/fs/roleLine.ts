// 角色线（role-line）文件模型（character-card-line §2.2/§3.2）：解析 / 阶段推进 / 重渲染
// 线文件存放位置：设定/角色线/{名}.md（设计主位）；兼容 大纲/角色线/{名}.md（旧 glue 引用）
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type StageStatus = 'planned' | 'active' | 'done';

export interface RoleStage {
  no: number;
  title: string;
  range: string;
  status: StageStatus;
  goals: string[];
  acceptance: string[];
  evidence: string[];
}

export interface RoleLine {
  name: string;
  lineTitle: string;
  summary: string;
  stages: RoleStage[];
  interlace: string[];
  progressPointer: string;
  audit: string[];
}

/** 设计主位路径：设定/角色线/{名}.md，旧位兼容 大纲/角色线/{名}.md */
export function resolveLinePath(bookDir: string, name: string): { path: string; rel: string } | null {
  const n = name.replace(/[\\/:*?"<>|]+/g, '').trim();
  if (!n) return null;
  const candidates = [
    { rel: '设定/角色线/' + n + '.md', path: join(bookDir, '设定', '角色线', n + '.md') },
    { rel: '大纲/角色线/' + n + '.md', path: join(bookDir, '大纲', '角色线', n + '.md') },
  ];
  return candidates.find((c) => existsSync(c.path)) ?? null;
}

const STAGE_RE = /^#{2,3}\s*阶段\s*(\d+)\s*[：:]\s*(.*?)\s*(?:（(.*?)）)?\s*\[状态:\s*(done|active|planned)\]/;
const END_RE = /^#{2,3}\s*(?:与其他|进度指针|审计|弧线定义|交织点)/;

function classify(line: string): { kind: 'goals' | 'acceptance' | 'evidence'; text: string } | null {
  const t = line.replace(/^[-*]\s*/, '').trim();
  if (/三层目标/.test(t)) return { kind: 'goals', text: t.replace(/^三层目标[：:]?\s*/, '') };
  if (/验收/.test(t)) return { kind: 'acceptance', text: t };
  if (/渐变证据|证据/.test(t)) return { kind: 'evidence', text: t };
  return null;
}

export function parseRoleLine(text: string, name: string): RoleLine {
  const lines = text.split(/\r?\n/);
  const line: RoleLine = { name, lineTitle: '', summary: '', stages: [], interlace: [], progressPointer: '', audit: [] };
  const titleMatch = text.match(/^#\s*角色线[:：]?\s*(.+?)(?:（(.+)）)?$/);
  if (titleMatch) line.lineTitle = (titleMatch[2] ? titleMatch[2].trim() : (titleMatch[1] ?? name).trim());
  let cur: RoleStage | null = null;
  for (const raw of lines) {
    const lineStr = raw.trimEnd();
    const m = lineStr.match(STAGE_RE);
    if (m) {
      if (cur) line.stages.push(cur);
      cur = {
        no: parseInt(m[1] ?? '0', 10),
        title: (m[2] ?? '').trim(),
        range: (m[3] ?? '').trim(),
        status: (m[4] ?? 'planned') as StageStatus,
        goals: [], acceptance: [], evidence: [],
      };
      continue;
    }
    if (cur && END_RE.test(lineStr)) {
      line.stages.push(cur);
      cur = null;
    }
    if (cur) {
      const c = classify(lineStr);
      if (c) {
        if (c.kind === 'goals') cur.goals.push(c.text);
        else if (c.kind === 'acceptance') cur.acceptance.push(c.text);
        else cur.evidence.push(c.text);
      }
      continue;
    }
    if (/^##\s*其他线|^##\s*交织点/.test(lineStr)) continue;
    if (/^##\s*进度指针/.test(lineStr)) {
      const p = lines.slice(lines.indexOf(lineStr) + 1).map((x) => x.trimEnd()).filter((x) => x.startsWith('-'))[0] ?? '';
      line.progressPointer = p.replace(/^-\s*/, '');
      continue;
    }
    if (/^##\s*审计结果/.test(lineStr)) {
      for (const x of lines.slice(lines.indexOf(lineStr) + 1)) {
        if (/^#{1,3}\s/.test(x)) break;
        if (x.trim().startsWith('-')) line.audit.push(x.replace(/^-\s*/, '').trim());
      }
      continue;
    }
    if (/^##\s*弧线定义/.test(lineStr)) {
      const s = lines.slice(lines.indexOf(lineStr) + 1).map((x) => x.trimEnd()).filter((x) => x.startsWith('-'))[0] ?? '';
      line.summary = s.replace(/^-\s*(?:起点|主题|定位)\s*[（(]?读卡[）)]?[：:]?\s*/, '');
    }
  }
  if (cur) line.stages.push(cur);
  line.stages.sort((a, b) => a.no - b.no);
  return line;
}

export function activeStage(line: RoleLine): { no: number; status: string } | null {
  const a = line.stages.find((s) => s.status === 'active');
  if (a) return { no: a.no, status: 'active' };
  const done = line.stages.filter((s) => s.status === 'done').map((s) => s.no);
  if (done.length) {
    const max = Math.max(...done);
    const next = line.stages.find((s) => s.no === max + 1);
    return next ? { no: next.no, status: 'planned' } : { no: max, status: 'done' };
  }
  return line.stages[0] ? { no: line.stages[0]!.no, status: line.stages[0]!.status } : null;
}

/**
 * 提议/推进角色线阶段：
 *  - to_stage/to_status：done → 该阶段及之前全部 done；active → 之前 done、该 stage active、之后 planned
 *  - acceptance_done[]：作为该阶段验收+渐变证据落行
 *  - confirm_through_chapter：推进到的章节（进度指针）
 *  - note：附加备注（写 audit 与进度指针）
 */
export function applyAdvance(
  line: RoleLine,
  req: { to_stage: number; to_status?: 'done' | 'active'; acceptance_done?: string[]; confirm_through_chapter?: number; note?: string },
): RoleLine {
  const out = structuredClone(line);
  const target = req.to_stage;
  const toStatus: StageStatus = req.to_status === 'active' ? 'active' : 'done';
  for (const s of out.stages) {
    if (s.no < target) s.status = 'done';
    else if (s.no === target) s.status = toStatus;
    else s.status = 'planned';
    // 阶段跳级时，早期 active 清掉
  }
  const t = out.stages.find((s) => s.no === target);
  if (t && req.acceptance_done?.length) {
    for (const a of req.acceptance_done) {
      if (!t.acceptance.some((x) => x === a)) t.acceptance.push('验收：' + a);
      if (!t.evidence.some((x) => x.includes(a))) t.evidence.push('渐变证据：' + a);
    }
  }
  const since = req.confirm_through_chapter ? '第' + req.confirm_through_chapter + ' 章' : (activeStage(out)?.no === target ? '本阶段' : '');
  out.progressPointer = '当前阶段：阶段' + target + '（' + toStatus + '）｜ 最近确认到：' + (since || '—') + (req.note ? '；备注：' + req.note : '');
  return out;
}

export function renderRoleLine(line: RoleLine): string {
  const out: string[] = [];
  out.push('# 角色线：' + line.name + (line.lineTitle ? '（' + line.lineTitle + '）' : ''));
  out.push('');
  out.push('## 弧线定义');
  out.push('- 起点（读卡）：' + (line.summary || '待补'));
  out.push('- 主题：' + line.lineTitle);
  out.push('');
  out.push('## 阶段状态机');
  for (const s of line.stages) {
    const range = s.range ? '（' + s.range + '）' : '';
    out.push('### 阶段 ' + s.no + '：' + s.title + range + '[状态: ' + s.status + ']');
    if (s.goals.length) out.push('- 三层目标：' + s.goals.join('；'));
    else out.push('- 三层目标：待补');
    for (const a of s.acceptance) out.push('- ' + a);
    if (!s.acceptance.length) out.push('- 验收：待补');
    for (const e of s.evidence) out.push('- ' + e);
    if (!s.evidence.length) out.push('- 渐变证据：待补');
    out.push('');
  }
  out.push('## 进度指针');
  out.push('- ' + line.progressPointer);
  out.push('');
  out.push('## 审计结果（卷末由 role-line gate 回填）');
  if (line.audit.length) for (const a of line.audit) out.push('- ' + a);
  else out.push('- （待首轮卷末审计）');
  out.push('');
  return out.join('\n');
}

export function writeRoleLine(bookDir: string, name: string, line: RoleLine): { rel: string; path: string } {
  const n = name.replace(/[\\/:*?"<>|]+/g, '').trim();
  const abs = join(bookDir, '设定', '角色线', n + '.md');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, renderRoleLine(line), 'utf8');
  return { rel: '设定/角色线/' + n + '.md', path: abs };
}

export function readRoleLine(bookDir: string, name: string): { line: RoleLine | null; path: string | null; rel: string | null } {
  const found = resolveLinePath(bookDir, name);
  if (!found) return { line: null, path: null, rel: null };
  return { line: parseRoleLine(readFileSync(found.path, 'utf8'), name), path: found.path, rel: found.rel };
}

/** 角色卡红线计数与线文件关联扫描（GET /characters） */
export function scanCharacters(bookDir: string): Array<{ name: string; rel: string; redLines: number; lineExists: boolean; lineRel: string | null }> {
  const dir = join(bookDir, '设定', '角色');
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; rel: string; redLines: number; lineExists: boolean; lineRel: string | null }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const rel = '设定/角色/' + f;
    const name = f.replace(/\.md$/, '');
    const text = readFileSync(join(dir, f), 'utf8');
    let redLines = 0;
    let inRed = false;
    for (const l of text.split(/\r?\n/)) {
      if (/^#{1,3}\s*写作红线/.test(l.trim())) { inRed = true; continue; }
      if (inRed) {
        if (/^#{1,3}\s/.test(l.trim())) inRed = false;
        else if (l.trim().startsWith('-') || l.trim().startsWith('*')) redLines++;
      }
    }
    const lp = resolveLinePath(bookDir, name);
    out.push({ name, rel, redLines, lineExists: !!lp, lineRel: lp?.rel ?? null });
  }
  return out;
}

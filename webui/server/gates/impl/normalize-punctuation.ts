// normalize-punctuation.ts — 正文标点规范化（⭐ Node 化移植，standalone-webui §7.2）
// 行为与原 skills/story-long-write/scripts/normalize-punctuation.js 保持一致：
//   - 省略号/破折号/双连字符 → 中文标点（确定性）
//   - 移除正文 markdown 分隔线（---）
//   - 引号默认保持；--quote-mode ascii|yan 时显式转换
// 原子写：tmp + rename；--check 只报告不写。
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

export type QuoteMode = 'keep' | 'ascii' | 'yan';

export interface NormalizeFinding {
  line: number;
  column: number;
  type: string;
  message: string;
}

export interface NormalizeResult {
  output: string;
  findings: NormalizeFinding[];
}

export async function runNormalizePunctuation(
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const options = parseArgs(argv);
  if (options.error) {
    return { code: 2, stdout: '', stderr: options.error };
  }
  if (options.help) {
    return { code: 0, stdout: USAGE, stderr: '' };
  }
  const out: string[] = [];
  let totalFindings = 0;
  let changedFiles = 0;
  let failed = false;
  for (const file of options.files) {
    const fullPath = resolve(cwd, file);
    let input: string;
    try {
      input = readFileSync(fullPath, 'utf8').replace(/^\uFEFF/, '');
    } catch (e: any) {
      failed = true;
      out.push(`${file}: unable to read (${e.message})`);
      continue;
    }
    const result = normalizeDocument(input, options.quoteMode);
    totalFindings += result.findings.length;
    if (options.check) {
      for (const finding of result.findings) {
        out.push(`${file}:${finding.line}:${finding.column}: ${finding.type}: ${finding.message}`);
      }
      continue;
    }
    if (result.output !== input) {
      const tmpPath = `${fullPath}.tmp-${process.pid}`;
      try {
        writeFileSync(tmpPath, result.output, 'utf8');
        renameSync(tmpPath, fullPath);
      } catch (writeError: any) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        failed = true;
        out.push(`${file}: unable to write (${writeError.message})`);
        continue;
      }
      changedFiles += 1;
      out.push(`${file}: normalized (${result.findings.length} issue${result.findings.length === 1 ? '' : 's'})`);
    }
  }
  let code = 0;
  if (failed) code = 2;
  else if (options.check && totalFindings > 0) code = 1;
  else if (!options.check) out.push(`Done. Changed files: ${changedFiles}`);
  return { code, stdout: out.join('\n') + (out.length ? '\n' : ''), stderr: '' };
}

function parseArgs(argv: string[]): {
  check: boolean;
  quoteMode: QuoteMode;
  files: string[];
  error?: string;
  help?: boolean;
} {
  const options: ReturnType<typeof parseArgs> = {
    check: false,
    quoteMode: 'keep',
    files: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--check') options.check = true;
    else if (arg === '--quote-mode') {
      const value = argv[i + 1];
      if (!value) return { ...options, error: '--quote-mode requires keep, ascii, or yan' };
      options.quoteMode = value as QuoteMode;
      i += 1;
    } else if (arg.startsWith('--quote-mode=')) {
      options.quoteMode = arg.slice('--quote-mode='.length) as QuoteMode;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      return { ...options, error: `Unknown option: ${arg}` };
    } else {
      options.files.push(arg);
    }
  }
  if (!['keep', 'ascii', 'yan'].includes(options.quoteMode)) {
    return { ...options, error: `Invalid --quote-mode: ${options.quoteMode}` };
  }
  if (options.files.length === 0) {
    return { ...options, error: 'No files provided' };
  }
  return options;
}

const USAGE = `Usage: node normalize-punctuation.js [--check] [--quote-mode keep|ascii|yan] <file...>

Normalize正文 punctuation deterministically:
  - replace ellipses, em dashes, and double hyphens with Chinese punctuation
  - remove markdown divider lines (---) from正文
  - keep quote style by default; convert quotes only when explicitly requested
`;

export function normalizeDocument(input: string, quoteMode: QuoteMode = 'keep'): NormalizeResult {
  const { lines, endings } = splitLinesKeepingEndings(input);
  const findings: NormalizeFinding[] = [];
  const outputLines: string[] = [];
  let fence: { marker: string; minimumLength: number } | null = null;
  let inFrontMatter = hasYamlFrontMatter(lines);
  let quoteOpen = false;
  let commentOpen = false;
  let commentStart: { line: number; column: number } | null = null;
  const commentCloseAhead = new Array<boolean>(lines.length + 1).fill(false);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    commentCloseAhead[index] = lines[index]!.includes('-->') || commentCloseAhead[index + 1]!;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const ending = endings[index]!;
    let line = lines[index]!;
    const trimmed = line.trim();

    if (commentOpen && !commentCloseAhead[index]) {
      findings.push({
        line: commentStart?.line || lineNo,
        column: commentStart?.column || 1,
        type: 'html-comment-unclosed',
        message: 'HTML 注释未闭合；后续内容仍按正文检查。',
      });
      commentOpen = false;
      commentStart = null;
    }

    if (inFrontMatter) {
      outputLines.push(line + ending);
      if (index > 0 && trimmed === '---') inFrontMatter = false;
      continue;
    }

    if (fence) {
      outputLines.push(line + ending);
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }

    const openingFence = parseOpeningFence(line);
    if (openingFence) {
      fence = openingFence;
      outputLines.push(line + ending);
      continue;
    }

    if (trimmed === '---' && !commentOpen) {
      findings.push({
        line: lineNo,
        column: line.indexOf('-') + 1,
        type: 'markdown-divider',
        message: '正文中不要使用 markdown 分隔线；建议移除该行。',
      });
      continue;
    }

    const commentOpenBefore = commentOpen;
    const punctuationResult = normalizePausePunctuation(line, lineNo, commentOpen);
    findings.push(...punctuationResult.findings);
    line = punctuationResult.line;
    commentOpen = punctuationResult.commentOpen;
    if (!commentOpenBefore && commentOpen) {
      commentStart = { line: lineNo, column: Math.max(1, line.lastIndexOf('<!--') + 1) };
    } else if (!commentOpen) {
      commentStart = null;
    }

    const quoteResult = normalizeQuotes(line, quoteMode, quoteOpen, lineNo);
    findings.push(...quoteResult.findings);
    line = quoteResult.line;
    quoteOpen = quoteResult.quoteOpen;

    outputLines.push(line + ending);
  }

  if (commentOpen) {
    findings.push({
      line: commentStart?.line || lines.length,
      column: commentStart?.column || 1,
      type: 'html-comment-unclosed',
      message: 'HTML 注释未闭合；后续内容仍按正文检查。',
    });
  }

  return { output: outputLines.join(''), findings };
}

function splitLinesKeepingEndings(input: string): { lines: string[]; endings: string[] } {
  const lines: string[] = [];
  const endings: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const newlineIndex = input.indexOf('\n', cursor);
    if (newlineIndex === -1) {
      lines.push(input.slice(cursor));
      endings.push('');
      break;
    }
    const crlf = newlineIndex > cursor && input[newlineIndex - 1] === '\r';
    lines.push(input.slice(cursor, crlf ? newlineIndex - 1 : newlineIndex));
    endings.push(crlf ? '\r\n' : '\n');
    cursor = newlineIndex + 1;
  }
  return { lines, endings };
}

function parseOpeningFence(line: string): { marker: string; minimumLength: number } | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const marker = match[1]!;
  const rest = match[2]!;
  if (marker[0] === '`' && rest.includes('`')) return null;
  return { marker: marker[0]!, minimumLength: marker.length };
}

function isClosingFence(line: string, fence: { marker: string; minimumLength: number }): boolean {
  const marker = fence.marker === '`' ? '`' : '~';
  const match = line.match(new RegExp(`^ {0,3}(${marker}{3,})[\\t ]*$`));
  return Boolean(match && match[1]!.length >= fence.minimumLength);
}

function normalizePausePunctuation(
  line: string,
  lineNo: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _commentOpen: boolean,
): { line: string; findings: NormalizeFinding[]; commentOpen: boolean } {
  let current = line;
  let findings: NormalizeFinding[] | null = null;
  let commentOpenAfter = false;
  for (;;) {
    const comments = htmlCommentSpans(current, commentOpenAfter);
    commentOpenAfter = comments.open;
    const pass = normalizePausePunctuationPass(current, lineNo, comments.spans);
    if (findings === null) findings = pass.findings;
    if (pass.line === current) break;
    current = pass.line;
  }
  return {
    line: current,
    findings: findings ?? [],
    commentOpen: commentOpenAfter,
  };
}

function normalizePausePunctuationPass(
  line: string,
  lineNo: number,
  commentSpans: Array<[number, number]>,
): { line: string; findings: NormalizeFinding[] } {
  const findings: NormalizeFinding[] = [];
  const original = line;
  const pattern = /…+|\.{3,}|——|—|--+/g;
  let output = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(original)) !== null) {
    const token = match[0]!;
    if (insideSpans(match.index, match.index + token.length, commentSpans)) continue;
    output += original.slice(lastIndex, match.index);
    const replacement = choosePauseReplacement(original, match.index, token.length);
    output += replacement;
    findings.push({
      line: lineNo,
      column: match.index + 1,
      type: getPauseType(token),
      message: replacement ? `替换为「${replacement}」。` : '移除重复标点。',
    });
    lastIndex = match.index + token.length;
  }
  output += original.slice(lastIndex);
  return { line: output, findings };
}

function htmlCommentSpans(line: string, openBefore: boolean): { spans: Array<[number, number]>; open: boolean } {
  const spans: Array<[number, number]> = [];
  let open = openBefore;
  let cursor = 0;
  while (cursor < line.length) {
    if (open) {
      const close = line.indexOf('-->', cursor);
      if (close === -1) {
        spans.push([cursor, line.length]);
        return { spans, open: true };
      }
      spans.push([cursor, close + 3]);
      cursor = close + 3;
      open = false;
      continue;
    }
    const start = line.indexOf('<!--', cursor);
    if (start === -1) break;
    cursor = start;
    open = true;
  }
  return { spans, open };
}

function insideSpans(start: number, end: number, spans: Array<[number, number]>): boolean {
  return spans.some(([spanStart, spanEnd]) => start < spanEnd && end > spanStart);
}

function hasYamlFrontMatter(lines: string[]): boolean {
  if (!lines[0] || lines[0].trim() !== '---') return false;
  let sawYamlField = false;
  for (let i = 1; i < Math.min(lines.length, 40); i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '---') return sawYamlField;
    if (/^[A-Za-z0-9_-]+:\s*/.test(trimmed)) sawYamlField = true;
  }
  return false;
}

function getPauseType(token: string): string {
  if (token.startsWith('-')) return 'double-hyphen';
  if (token.includes('—')) return 'em-dash';
  return 'ellipsis';
}

function choosePauseReplacement(text: string, start: number, length: number): string {
  const before = previousNonSpace(text, start - 1);
  const after = nextNonSpace(text, start + length);
  const rest = text.slice(start + length).trimStart();
  if (before === '') return '';
  if (isOpeningDelimiter(before)) return '';
  if (/\d/.test(before) && /\d/.test(after)) return '到';
  if (isClosingQuote(after)) return isSentencePunctuation(before) ? '' : '。';
  if (!after) return isSentencePunctuation(before) ? '' : '。';
  if (isSentencePunctuation(before) || isPunctuation(after)) return '';
  if (/^(因为|原来|这是|那是|也就是|换句话|说白了|所谓|答案|原因|结果|真相|问题在于)/.test(rest)) return '：';
  if (/(原因|答案|真相|结果|结论|问题|选择|意思)$/.test(text.slice(0, start).trim())) return '：';
  return '，';
}

function previousNonSpace(text: string, index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    if (!/\s/.test(text[i]!)) return text[i]!;
  }
  return '';
}

function nextNonSpace(text: string, index: number): string {
  for (let i = index; i < text.length; i += 1) {
    if (!/\s/.test(text[i]!)) return text[i]!;
  }
  return '';
}

function isSentencePunctuation(ch: string): boolean {
  return /[，,。.!！?？;；:：…]$/.test(ch || '');
}

function isPunctuation(ch: string): boolean {
  return /[，,。.!！?？;；:：、…"“”'‘’」』）)]/.test(ch || '');
}

function isClosingQuote(ch: string): boolean {
  return /["”」』]/.test(ch || '');
}

function isOpeningDelimiter(ch: string): boolean {
  return /[「『（(“‘]/.test(ch || '');
}

function normalizeQuotes(
  line: string,
  quoteMode: QuoteMode,
  quoteOpen: boolean,
  lineNo: number,
): { line: string; findings: NormalizeFinding[]; quoteOpen: boolean } {
  if (quoteMode === 'keep') {
    return { line, findings: [], quoteOpen };
  }
  const findings: NormalizeFinding[] = [];
  let output = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoteMode === 'ascii' && /[「」『』“”]/.test(ch)) {
      output += '"';
      findings.push({ line: lineNo, column: i + 1, type: 'quote-style', message: '按显式 quote-mode 转为半角双引号。' });
      continue;
    }
    if (quoteMode === 'yan' && (ch === '"' || ch === '“' || ch === '”')) {
      const replacement = quoteOpen || ch === '”' ? '」' : '「';
      output += replacement;
      quoteOpen = replacement === '「';
      findings.push({ line: lineNo, column: i + 1, type: 'quote-style', message: '按显式 quote-mode 转为盐言引号。' });
      continue;
    }
    output += ch;
  }
  return { line: output, findings, quoteOpen };
}

export interface InlinePunctuationResult {
  ok: boolean;
  rewritten: number;
  atomic: boolean;
  findings: NormalizeFinding[];
}

/** 供门禁内联调用的规范化：直接修改书内文件，阻塞=写入失败才发生 */
export function normalizeBookFile(bookDir: string, relPath: string, quoteMode: QuoteMode = 'keep'): InlinePunctuationResult {
  const abs = resolve(bookDir, relPath);
  const input = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  const result = normalizeDocument(input, quoteMode);
  if (result.output !== input) {
    const tmpPath = `${abs}.webui-tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, result.output, 'utf8');
    if (existsSync(abs)) {
      const bak = join(dirname(abs), `.webui-bak-${process.pid}-${Date.now()}`);
      try {
        renameSync(abs, bak);
        renameSync(tmpPath, abs);
        unlinkSync(bak);
      } catch (e) {
        try {
          renameSync(bak, abs);
        } catch {
          /* ignore */
        }
        throw e;
      }
    } else {
      renameSync(tmpPath, abs);
    }
  }
  return { ok: true, rewritten: result.output !== input ? 1 : 0, atomic: true, findings: result.findings };
}

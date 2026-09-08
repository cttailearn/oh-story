/**
 * tracking-commit gate — Node/TypeScript port of
 * skills/story-long-write/scripts/tracking_commit.py (zero-Python-runtime migration).
 *
 * Single-authority tracking-state commit tool: it validates & merges the compact
 * semantic JSON transaction in memory, renders every derived view, then atomically
 * writes `追踪/_tracking-state.json` last as the single commit point.  One book
 * project has one serial writer; concurrent commits are intentionally unsupported.
 *
 * The port keeps the EXACT Python semantics: identical CLI grammar
 * (`init | commit | check | arc-audit` with `--project <root>` and `--input <path>`),
 * identical JSON transaction protocol, identical validation error messages, and
 * byte-identical derived Markdown views.  The WebUI calls this as a library; the
 * exported `runTrackingCommit` reproduces the CLI contract (stdout JSON, stderr
 * `ERROR:`/`WARNING:`/`NOTE:` lines, exit code 2 on failure).
 *
 * No npm dependencies: only node:fs / node:path / node:process.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';

/* --------------------------------------------------------------------------
 * Schema & size constants (must stay exactly as in tracking_commit.py)
 * ------------------------------------------------------------------------ */

export const INPUT_SCHEMA_VERSION = 1;
export const TRACKING_SCHEMA_VERSION = 4;

const DELTA_TARGET_BYTES = 1536;
const DELTA_MAX_BYTES = 3072;
const CONTEXT_TARGET_BYTES = 8192;
const CONTEXT_MAX_BYTES = 12288;
const SNAPSHOT_TARGET_BYTES = 4096;
const SNAPSHOT_MAX_BYTES = 8192;
const ARC_VIEW_TARGET_BYTES = 2048;
const ARC_VIEW_MAX_BYTES = 4096;
const ARC_STAGE_LIMIT = 40;
const CHAPTER_RANGE_RE = /第(\d+)\s*(?:[-—~至]\s*(\d+))?\s*章/;

const CONTEXT_HEADINGS = [
  '## 当前位置',
  '## 长期约束',
  '## 核心角色状态',
  '## 活跃伏笔',
  '## 近三章速记',
  '## 下一章承诺',
  '## 连贯性风险',
] as const;

const FORESHADOW_STATUSES = ['已埋', '已回收', '已过期', '放弃'] as const;
const FORESHADOW_IMPORTANCE = ['高', '中', '低'] as const;
const REVEAL_STATUSES = ['未揭示', '部分揭示', '已揭示'] as const;

const INVALID_FILE_CHARS = /[<>:"/\\|?*\x00-\x1f]/;
const FORESHADOW_ID = /^F\d{3,}$/;
const EVENT_ID = /^E\d{3,}$/;
const WINDOWS_RESERVED_NAMES = new Set<string>([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);
const RETIRED_TRACKING_PATHS = [
  '_tracking-meta.json',
  '阶段摘要.md',
  '角色状态.md',
  '时间线.md',
  '摘要',
  '时间线/事件库.json',
] as const;
const RETIRED_ARCHIVE_DIR = '_旧追踪存档';

/* --------------------------------------------------------------------------
 * Data types
 * ------------------------------------------------------------------------ */

export interface Position {
  volume: string;
  volume_start_chapter: number;
  story_time: string;
  scene: string;
}

export interface RecentChapter {
  chapter: number;
  summary: string;
}

export interface ContextCore {
  position: Position;
  long_term_constraints: string[];
  active_character_names: string[];
  continuity_risks: string[];
}

export interface ContextState extends ContextCore {
  recent_chapters: RecentChapter[];
  next_chapter_commitments: string[];
}

export interface CharacterSnapshot {
  identity: string;
  location: string;
  goal: string;
  state: string;
  abilities_resources: string[];
  relationships: string[];
  knowledge: string[];
  open_threads: string[];
}

export interface ForeshadowRow {
  id: string;
  summary: string;
  planted_chapter: number;
  planned_resolution_chapter: number | null;
  status: string;
  importance: string;
  updated_chapter: number;
}

export interface TimelineEvent {
  id: string;
  story_time: string;
  objective_fact: string;
  reader_knowledge: string;
  reveal_status: string;
  reveal_chapter: number | null;
  characters: string[];
  first_recorded_chapter: number;
  updated_chapter: number;
}

export interface ArcStage {
  name: string;
  planned_chapters: string;
}

export interface ArcDesign {
  line_kind: string;
  summary: string;
  stages: ArcStage[];
}

export interface ArcEvidence {
  chapter: number;
  anchor: string;
}

export interface ArcState extends ArcDesign {
  current_stage: number | null;
  evidence: Record<string, ArcEvidence>;
  registered_chapter: number;
}

export interface TrackingState {
  schema_version: number;
  book_title: string;
  last_committed_chapter: number;
  imported_through_chapter: number;
  state_revision: number;
  context: ContextState;
  characters: Record<string, CharacterSnapshot>;
  foreshadow: Record<string, ForeshadowRow>;
  timeline: Record<string, TimelineEvent>;
  arcs: Record<string, ArcState>;
}

type ForeshadowChange = { action: 'delete'; id: string } | Omit<ForeshadowRow, 'updated_chapter'> & { action: 'upsert' };
type TimelineChange =
  | { action: 'delete'; id: string }
  | (Omit<TimelineEvent, 'first_recorded_chapter' | 'updated_chapter'> & { action: 'upsert' });

interface ContextIn extends ContextCore {
  recent_chapters?: RecentChapter[];
  next_chapter_commitments?: string[];
}

export interface DeltaNormalized {
  result: string;
  character_changes: { name: string; change: string }[];
  foreshadow_changes: ForeshadowChange[];
  timeline_events: TimelineChange[];
  constraints: string[];
  next_chapter_commitments: string[];
  retired_context_items: string[];
  retired_characters: string[];
  arc_advances: ArcAdvance[];
}

interface ArcAdvance {
  line: string;
  stage: number;
  evidence_anchor: string;
}

interface TransactionNormalized {
  mode: 'append' | 'revision';
  chapter: number;
  title: string;
  delta: DeltaNormalized;
  context: ContextIn;
  snapshots: Record<string, CharacterSnapshot>;
  registrations: Record<string, ArcState>;
}

export interface ArcAuditLine {
  status: string;
  total_stages: number;
  achieved_stages: number;
  last_advance_chapter: number | null;
  planned_for_current: string;
  registered_chapter: number;
  overdue: boolean;
}

export interface ArcAuditReport {
  book_title: string;
  last_committed_chapter: number;
  state_revision: number;
  arc_lines: Record<string, ArcAuditLine>;
}

/** stderr sink used by the library functions to surface WARNING:/NOTE: lines. */
export interface TrackingIo {
  stderr(line: string): void;
}

const defaultIo: TrackingIo = {
  stderr(line: string): void {
    process.stderr.write(line + '\n');
  },
};

/* --------------------------------------------------------------------------
 * Core validation helpers
 * ------------------------------------------------------------------------ */

export class TrackingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackingError';
  }
}

/** Python `require(condition, message)` — raises TrackingError when false. */
function require(condition: boolean, message: string): void {
  if (!condition) throw new TrackingError(message);
}

function asMapping(value: unknown, label: string): Record<string, unknown> {
  if (!(value !== null && typeof value === 'object' && !Array.isArray(value))) {
    throw new TrackingError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function asList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TrackingError(`${label} must be a JSON array`);
  return value;
}

/** Python `mapping.get(key, default)` — default only when the key is absent (null stays null). */
function getKey(mapping: Record<string, unknown>, key: string, dflt: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(mapping, key) ? mapping[key] : dflt;
}

/** Python `as_int` — an integer (bools rejected), optionally with a minimum. */
function asInt(value: unknown, label: string, opts?: { minimum?: number }): number {
  const minimum = opts?.minimum ?? 0;
  if (!(typeof value === 'number' && Number.isInteger(value))) {
    throw new TrackingError(`${label} must be an integer`);
  }
  if (value < minimum) throw new TrackingError(`${label} must be >= ${minimum}`);
  return value;
}

function requireKnownKeys(mapping: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(mapping).filter((key) => !allowed.has(key)).sort();
  require(unknown.length === 0, `${label} contains unsupported fields: ${unknown.join(', ')}`);
}

/** Python `clean_text`: coerce whitespace runs, replace `|` with full-width ｜, then size-check. */
function cleanText(value: unknown, label: string, opts?: { allowEmpty?: boolean; maxBytes?: number }): string {
  const maxBytes = opts?.maxBytes ?? 768;
  if (typeof value !== 'string') throw new TrackingError(`${label} must be a string`);
  const cleaned = value
    .replaceAll('|', '｜')
    .split(/\s+/)
    .filter((part: string) => part.length > 0)
    .join(' ');
  require(opts?.allowEmpty === true || cleaned.length > 0, `${label} must not be empty`);
  require(byteSize(cleaned) <= maxBytes, `${label} exceeds ${maxBytes} bytes`);
  return cleaned;
}

function cleanStringList(
  value: unknown,
  label: string,
  opts?: { maximum?: number; itemMaxBytes?: number },
): string[] {
  const values = asList(value, label);
  if (opts?.maximum !== undefined) {
    require(values.length <= opts.maximum, `${label} may contain at most ${opts.maximum} items`);
  }
  return values.map((item, index) => cleanText(item, `${label}[${index}]`, { maxBytes: opts?.itemMaxBytes ?? 384 }));
}

/** Python `safe_file_component` — NFC-normalized, filename-safe single path component. */
function safeFileComponent(value: unknown, label: string): string {
  const name = cleanText(value, label, { maxBytes: 180 }).normalize('NFC');
  require(!INVALID_FILE_CHARS.test(name), `${label} contains an invalid filename character`);
  require(name !== '.' && name !== '..' && !name.endsWith('.') && !name.endsWith(' '), `${label} is not a safe filename`);
  const stem = name.split('.', 1)[0]!.toUpperCase();
  require(!WINDOWS_RESERVED_NAMES.has(stem), `${label} is reserved on Windows`);
  return name;
}

/** Python `portable_name_key` — NFC normalize + casefold (≈ toLowerCase for CJK/ASCII). */
function portableNameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Python `byte_size` — UTF-8 byte length. */
function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

/* --------------------------------------------------------------------------
 * JSON + file I/O (Python `json_payload` / `read_json` / `atomic_write_text` /
 * `write_if_changed` equivalents)
 * ------------------------------------------------------------------------ */

/**
 * Python `json.dumps(value, ensure_ascii=False, indent=indentUnit, sort_keys=True)`
 * clone: object keys are sorted, containers are broken across lines with
 * `indentUnit` spaces, empty containers are compact `{}`/`[]`.
 */
function jsonDumpPy(value: unknown, indentUnit: number, level = 0): string {
  const pad = ' '.repeat(indentUnit * level);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value); // same escaping as Python json for our data (UTF-8, controls)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const innerPad = ' '.repeat(indentUnit * (level + 1));
    const parts = value.map((item) => innerPad + jsonDumpPy(item, indentUnit, level + 1));
    return `[\n${parts.join(',\n')}\n${pad}]`;
  }
  // plain object
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (keys.length === 0) return '{}';
  const innerPad = ' '.repeat(indentUnit * (level + 1));
  const parts = keys.map(
    (key) =>
      `${innerPad}${JSON.stringify(key)}: ${jsonDumpPy((value as Record<string, unknown>)[key], indentUnit, level + 1)}`,
  );
  return `{\n${parts.join(',\n')}\n${pad}}`;
}

/** Python `json_payload` — canonical state serialization (indent 2, sorted keys, UTF-8). */
function jsonPayload(document: unknown): string {
  return jsonDumpPy(document, 2) + '\n';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Python `read_json` — decode strict UTF-8, JSON.parse; failures -> TrackingError. */
function readJson(filePath: string): unknown {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (exc) {
    throw new TrackingError(`unable to read JSON ${filePath}: ${errorMessage(exc)}`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (exc) {
    throw new TrackingError(`unable to read JSON ${filePath}: ${errorMessage(exc)}`);
  }
  try {
    return JSON.parse(text);
  } catch (exc) {
    throw new TrackingError(`unable to read JSON ${filePath}: ${errorMessage(exc)}`);
  }
}

function uniqueTemporaryPath(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const rand = `${process.pid.toString(36)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return path.join(dir, `.${base}.${rand}.tmp`);
}

/**
 * Python `atomic_write_text` — temp file in the same directory (preserving an
 * existing file's mode), fsync, then atomic rename over the target.
 */
function atomicWriteText(filePath: string, payload: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let mode = 0o644;
  try {
    mode = fs.statSync(filePath).mode & 0o7777;
  } catch {
    /* new file: default 0o644 */
  }
  const tmp = uniqueTemporaryPath(filePath);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Python `write_if_changed` — only rewrite when the byte content differs. */
function writeIfChanged(filePath: string, payload: string): void {
  try {
    if (fs.readFileSync(filePath, 'utf8') === payload) return;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== 'ENOENT') throw exc;
  }
  atomicWriteText(filePath, payload);
}

/* --------------------------------------------------------------------------
 * Tracking layout paths
 * ------------------------------------------------------------------------ */

function trackingRoot(project: string): string {
  return path.join(path.resolve(project), '追踪');
}

function statePath(project: string): string {
  return path.join(trackingRoot(project), '_tracking-state.json');
}

/** Zero-padded weekly delta filename, e.g. 第001章.md (width = max(3, digits)). */
function deltaPath(tracking: string, chapter: number): string {
  const width = Math.max(3, String(chapter).length);
  return path.join(tracking, '逐章记录', `第${String(chapter).padStart(width, '0')}章.md`);
}

function findRetiredTrackingPaths(tracking: string): string[] {
  const found: string[] = [];
  for (const relative of RETIRED_TRACKING_PATHS) {
    if (fs.existsSync(path.join(tracking, relative))) found.push(relative);
  }
  const baseline: string[] = [];
  if (fs.existsSync(tracking)) {
    for (const name of fs.readdirSync(tracking)) {
      if (/^基线_截至第.*章\.md$/.test(name)) baseline.push(name);
    }
  }
  baseline.sort();
  found.push(...baseline);
  return found;
}

function requireNoRetiredTrackingPaths(tracking: string): void {
  const found = findRetiredTrackingPaths(tracking);
  require(found.length === 0, `retired tracking files are not supported: ${found.join(', ')}`);
}

/**
 * Move a pre-transaction 追踪/ aside so init can build the current protocol in
 * place.  Nothing is parsed or converted: the old files are kept verbatim.
 */
function archiveRetiredTrackingPaths(tracking: string): string[] {
  const retired = findRetiredTrackingPaths(tracking);
  if (retired.length === 0) return [];
  const archive = path.join(tracking, RETIRED_ARCHIVE_DIR);
  for (const relative of retired) {
    require(
      !fs.existsSync(path.join(archive, relative)),
      `追踪/${RETIRED_ARCHIVE_DIR}/${relative} already exists; move it away before initializing`,
    );
  }
  // 先全量校验再搬运；中断后重跑时已搬走的条目不再出现在待搬列表里，可直接续做。
  for (const relative of retired) {
    const target = path.join(archive, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(path.join(tracking, relative), target);
  }
  return retired;
}

/* --------------------------------------------------------------------------
 * Position / character snapshot normalization
 * ------------------------------------------------------------------------ */

function validatePosition(value: unknown, label = 'context.position'): Position {
  const position = asMapping(value, label);
  requireKnownKeys(
    position,
    new Set(['volume', 'volume_start_chapter', 'story_time', 'scene']),
    label,
  );
  return {
    volume: safeFileComponent(position.volume, `${label}.volume`),
    volume_start_chapter: asInt(position.volume_start_chapter, `${label}.volume_start_chapter`, { minimum: 1 }),
    story_time: cleanText(position.story_time, `${label}.story_time`, { maxBytes: 240 }),
    scene: cleanText(position.scene, `${label}.scene`, { maxBytes: 240 }),
  };
}

function normalizeSnapshot(value: unknown, label: string): CharacterSnapshot {
  const snapshot = asMapping(value, label);
  requireKnownKeys(
    snapshot,
    new Set([
      'identity',
      'location',
      'goal',
      'state',
      'abilities_resources',
      'relationships',
      'knowledge',
      'open_threads',
    ]),
    label,
  );
  return {
    identity: cleanText(snapshot.identity, `${label}.identity`, { maxBytes: 240 }),
    location: cleanText(snapshot.location, `${label}.location`, { maxBytes: 240 }),
    goal: cleanText(snapshot.goal, `${label}.goal`, { maxBytes: 300 }),
    state: cleanText(snapshot.state, `${label}.state`, { maxBytes: 300 }),
    abilities_resources: cleanStringList(getKey(snapshot, 'abilities_resources', []), `${label}.abilities_resources`),
    relationships: cleanStringList(getKey(snapshot, 'relationships', []), `${label}.relationships`),
    knowledge: cleanStringList(getKey(snapshot, 'knowledge', []), `${label}.knowledge`),
    open_threads: cleanStringList(getKey(snapshot, 'open_threads', []), `${label}.open_threads`),
  };
}

function normalizeSnapshots(value: unknown, label = 'character_snapshots'): Record<string, CharacterSnapshot> {
  const snapshots = asMapping(value, label);
  const normalized: Record<string, CharacterSnapshot> = {};
  const portableNames = new Set<string>();
  for (const [rawName, rawSnapshot] of Object.entries(snapshots)) {
    const name = safeFileComponent(rawName, `${label} character name`);
    const key = portableNameKey(name);
    require(!portableNames.has(key), `${label} contains a cross-platform duplicate character ${name}`);
    portableNames.add(key);
    normalized[name] = normalizeSnapshot(rawSnapshot, `${label}.${name}`);
  }
  return normalized;
}

/* --------------------------------------------------------------------------
 * Arc (role-line) design / skeleton / state normalization
 * ------------------------------------------------------------------------ */

function normalizeArcDesign(value: unknown, label: string): ArcDesign {
  const arc = asMapping(value, label);
  const stages = asList(arc.stages, `${label}.stages`);
  require(stages.length >= 1, `${label}.stages must contain at least one stage`);
  require(stages.length <= ARC_STAGE_LIMIT, `${label}.stages may contain at most ${ARC_STAGE_LIMIT} stages`);
  const normalizedStages: ArcStage[] = [];
  for (const [index, rawStage] of stages.entries()) {
    const stage = asMapping(rawStage, `${label}.stages[${index}]`);
    requireKnownKeys(stage, new Set(['name', 'planned_chapters']), `${label}.stages[${index}]`);
    normalizedStages.push({
      name: cleanText(stage.name, `${label}.stages[${index}].name`, { maxBytes: 96 }),
      planned_chapters: cleanText(getKey(stage, 'planned_chapters', ''), `${label}.stages[${index}].planned_chapters`, {
        allowEmpty: true,
        maxBytes: 128,
      }),
    });
  }
  return {
    line_kind: cleanText(getKey(arc, 'line_kind', '角色'), `${label}.line_kind`, { maxBytes: 24 }),
    summary: cleanText(getKey(arc, 'summary', ''), `${label}.summary`, { allowEmpty: true, maxBytes: 480 }),
    stages: normalizedStages,
  };
}

function normalizeArcSkeleton(value: unknown, label: string): ArcDesign {
  asMapping(value, label);
  requireKnownKeys(value as Record<string, unknown>, new Set(['line_kind', 'summary', 'stages']), label);
  return normalizeArcDesign(value, label);
}

function normalizeArcsState(value: unknown, lastChapter: number, label = 'tracking state.arcs'): Record<string, ArcState> {
  const arcs = asMapping(value, label);
  const normalized: Record<string, ArcState> = {};
  const portableNames = new Set<string>();
  for (const [rawName, rawArc] of Object.entries(arcs)) {
    const name = safeFileComponent(rawName, `${label} line name`);
    const key = portableNameKey(name);
    require(!portableNames.has(key), `${label} contains a cross-platform duplicate line ${name}`);
    portableNames.add(key);
    const arc = asMapping(rawArc, `${label}.${name}`);
    requireKnownKeys(
      arc,
      new Set(['line_kind', 'summary', 'stages', 'current_stage', 'evidence', 'registered_chapter']),
      `${label}.${name}`,
    );
    const design = normalizeArcDesign(arc, `${label}.${name}`);
    const stageCount = design.stages.length;
    const currentRaw = arc.current_stage;
    const current = currentRaw === null ? null : asInt(currentRaw, `${label}.${name}.current_stage`, { minimum: 1 });
    require(current === null || current <= stageCount, `${label}.${name}.current_stage exceeds the last stage`);
    const registered = asInt(arc.registered_chapter, `${label}.${name}.registered_chapter`);
    require(registered <= lastChapter, `${label}.${name}.registered_chapter is after the current chapter`);
    const evidence: Record<string, ArcEvidence> = {};
    const evidenceMapping = asMapping(getKey(arc, 'evidence', {}), `${label}.${name}.evidence`);
    for (const [rawIndex, rawRecord] of Object.entries(evidenceMapping)) {
      const index = cleanText(rawIndex, `${label}.${name}.evidence key`, { maxBytes: 12 });
      require(/^\d+$/.test(index) && Number(index) > 0, `${label}.${name}.evidence keys must be 1-based stage numbers`);
      require(Number(index) <= stageCount, `${label}.${name}.evidence references a missing stage`);
      const record = asMapping(rawRecord, `${label}.${name}.evidence.${index}`);
      requireKnownKeys(record, new Set(['chapter', 'anchor']), `${label}.${name}.evidence.${index}`);
      const recordChapter = asInt(record.chapter, `${label}.${name}.evidence.${index}.chapter`, { minimum: 1 });
      require(recordChapter <= lastChapter, `${label}.${name}.evidence is after the current chapter`);
      evidence[index] = {
        chapter: recordChapter,
        anchor: cleanText(record.anchor, `${label}.${name}.evidence.${index}.anchor`, { maxBytes: 240 }),
      };
    }
    const doneIndexes = new Set(Object.keys(evidence).map((k) => Number(k)));
    if (current === null) {
      const expectedAll = new Set(Array.from({ length: stageCount }, (_, i) => i + 1));
      require(
        setsEqual(doneIndexes, expectedAll),
        `${label}.${name} is complete but lacks evidence for every stage`,
      );
    } else {
      const expectedDone = new Set(Array.from({ length: current - 1 }, (_, i) => i + 1));
      require(
        setsEqual(doneIndexes, expectedDone),
        `${label}.${name} evidence must cover exactly the completed stages (before the active stage ${current})`,
      );
    }
    normalized[name] = { ...design, current_stage: current, evidence, registered_chapter: registered };
  }
  return normalized;
}

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function setsEqualStr(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/* --------------------------------------------------------------------------
 * Derived view renderers (byte-for-byte Python templates)
 * ------------------------------------------------------------------------ */

function renderSnapshot(name: string, snapshot: CharacterSnapshot, throughChapter: number, revision: number): string {
  const section = (title: string, values: string[]): string[] => {
    const items = values.length > 0 ? values : ['无'];
    return [`## ${title}`, ...items.map((item) => `- ${item}`), ''];
  };
  const lines: string[] = [
    `# ${name}｜当前状态`,
    '',
    `- 状态修订：${revision}`,
    `- 截至章节：第${throughChapter}章`,
    `- 身份：${snapshot.identity}`,
    `- 位置：${snapshot.location}`,
    `- 当前目标：${snapshot.goal}`,
    `- 身心状态：${snapshot.state}`,
    '',
  ];
  lines.push(...section('能力与资源', snapshot.abilities_resources));
  lines.push(...section('关键关系', snapshot.relationships));
  lines.push(...section('已知信息', snapshot.knowledge));
  lines.push(...section('未结事项', snapshot.open_threads));
  const payload = lines.join('\n').replace(/\s+$/, '') + '\n';
  require(
    byteSize(payload) <= SNAPSHOT_MAX_BYTES,
    `character snapshot ${name} exceeds hard cap of ${SNAPSHOT_MAX_BYTES} bytes`,
  );
  return payload;
}

function renderArc(name: string, arc: ArcState, revision: number): string {
  const stageCount = arc.stages.length;
  const current = arc.current_stage;
  let headline: string;
  let statusText: string;
  if (current === null) {
    headline = `已完结（阶段 ${stageCount}/${stageCount}）`;
    statusText = '全部阶段已完成';
  } else {
    headline = `阶段 ${current}/${stageCount} · 进行中`;
    statusText = '未完';
  }
  const statusOf = (index: number): string => {
    if (current === null || index < current) return '已完成';
    if (index === current) return '进行中';
    return '计划';
  };
  const lines: string[] = [
    `# ${name}｜角色线进度`,
    '',
    `- 线型：${arc.line_kind}`,
    `- 当前：${headline}（${statusText}）`,
    `- 状态修订：${revision}`,
  ];
  if (arc.summary) lines.push(`- 弧线：${arc.summary}`);
  lines.push('', '| 阶段 | 名称 | 计划章节 | 状态 | 证据锚点 |', '|---:|---|---|---|---|');
  arc.stages.forEach((stage, index) => {
    const stageIndex = index + 1;
    const evidence = arc.evidence[String(stageIndex)];
    const evidenceCell = evidence ? `第${evidence.chapter}章｜${evidence.anchor}` : '—';
    lines.push(`| ${stageIndex} | ${stage.name} | ${stage.planned_chapters || '—'} | ${statusOf(stageIndex)} | ${evidenceCell} |`);
  });
  const payload = lines.join('\n').replace(/\s+$/, '') + '\n';
  require(
    byteSize(payload) <= ARC_VIEW_MAX_BYTES,
    `arc view ${name} exceeds hard cap of ${ARC_VIEW_MAX_BYTES} bytes`,
  );
  return payload;
}

/* --------------------------------------------------------------------------
 * Foreshadow changes / state / view
 * ------------------------------------------------------------------------ */

function normalizeForeshadowChange(
  value: unknown,
  label: string,
  opts: { allowDelete: boolean; throughChapter: number },
): ForeshadowChange {
  const row = asMapping(value, label);
  requireKnownKeys(
    row,
    new Set(['action', 'id', 'summary', 'planted_chapter', 'planned_resolution_chapter', 'status', 'importance']),
    label,
  );
  const action = cleanText(getKey(row, 'action', 'upsert'), `${label}.action`, { maxBytes: 24 });
  require(
    opts.allowDelete ? action === 'upsert' || action === 'delete' : action === 'upsert',
    `${label}.action is invalid`,
  );
  const identifier = cleanText(row.id, `${label}.id`, { maxBytes: 24 });
  require(FORESHADOW_ID.test(identifier), `${label}.id must look like F001`);
  if (action === 'delete') return { action, id: identifier };
  const plantedChapter = asInt(row.planted_chapter, `${label}.planted_chapter`, { minimum: 1 });
  require(plantedChapter <= opts.throughChapter, `${label}.planted_chapter cannot be in the future`);
  const plannedRaw = row.planned_resolution_chapter;
  const plannedChapter = plannedRaw === null ? null : asInt(plannedRaw, `${label}.planned_resolution_chapter`, { minimum: 1 });
  require(
    plannedChapter === null || plannedChapter >= plantedChapter,
    `${label}.planned_resolution_chapter cannot precede planted_chapter`,
  );
  const status = cleanText(row.status, `${label}.status`, { maxBytes: 24 });
  const importance = cleanText(row.importance, `${label}.importance`, { maxBytes: 12 });
  require(FORESHADOW_STATUSES.includes(status as (typeof FORESHADOW_STATUSES)[number]), `${label}.status must be one of ('已埋', '已回收', '已过期', '放弃')`);
  require(FORESHADOW_IMPORTANCE.includes(importance as (typeof FORESHADOW_IMPORTANCE)[number]), `${label}.importance must be one of ('高', '中', '低')`);
  return {
    action: action as 'upsert',
    id: identifier,
    summary: cleanText(row.summary, `${label}.summary`, { maxBytes: 360 }),
    planted_chapter: plantedChapter,
    planned_resolution_chapter: plannedChapter,
    status,
    importance,
  };
}

function normalizeForeshadowState(value: unknown, lastChapter: number): Record<string, ForeshadowRow> {
  const rows = asMapping(value, 'tracking state.foreshadow');
  const normalized: Record<string, ForeshadowRow> = {};
  for (const [rawIdentifier, rawRow] of Object.entries(rows)) {
    const identifier = cleanText(rawIdentifier, 'tracking state.foreshadow ID', { maxBytes: 24 });
    const row = asMapping(rawRow, `tracking state.foreshadow.${identifier}`);
    requireKnownKeys(
      row,
      new Set(['id', 'summary', 'planted_chapter', 'planned_resolution_chapter', 'status', 'importance', 'updated_chapter']),
      `tracking state.foreshadow.${identifier}`,
    );
    require(row.id === identifier, `tracking state.foreshadow.${identifier}.id does not match its key`);
    const changeBase: Record<string, unknown> = { action: 'upsert' };
    for (const [key, v] of Object.entries(row)) {
      if (key !== 'updated_chapter') changeBase[key] = v;
    }
    const change = normalizeForeshadowChange(
      changeBase,
      `tracking state.foreshadow.${identifier}`,
      { allowDelete: false, throughChapter: lastChapter },
    ) as unknown as ForeshadowRow & { action?: string };
    delete change.action;
    const updated = asInt(row.updated_chapter, `tracking state.foreshadow.${identifier}.updated_chapter`, { minimum: 1 });
    require(updated <= lastChapter, `foreshadow ${identifier} updates after current chapter`);
    change.updated_chapter = updated;
    normalized[identifier] = change;
  }
  return normalized;
}

function renderForeshadow(rows: Record<string, ForeshadowRow>, revision: number): string {
  const lines: string[] = [
    '# 伏笔当前状态',
    '',
    `> 状态修订：${revision}。每个 ID 只保留一行当前状态；历史变化见 \`逐章记录/\`。`,
    '',
    '| ID | 内容 | 埋设章 | 计划回收章 | 状态 | 重要度 | 最近变更章 |',
    '|---|---|---:|---:|---|---|---:|',
  ];
  for (const identifier of Object.keys(rows).sort()) {
    const row = rows[identifier]!;
    const planned = row.planned_resolution_chapter ? `第${row.planned_resolution_chapter}章` : '—';
    lines.push(
      `| ${identifier} | ${row.summary} | 第${row.planted_chapter}章 | ${planned} | ` +
        `${row.status} | ${row.importance} | 第${row.updated_chapter}章 |`,
    );
  }
  return lines.join('\n') + '\n';
}

/* --------------------------------------------------------------------------
 * Timeline events / state / views
 * ------------------------------------------------------------------------ */

function normalizeTimelineChange(
  value: unknown,
  label: string,
  opts: { allowDelete: boolean; throughChapter: number },
): TimelineChange {
  const event = asMapping(value, label);
  requireKnownKeys(
    event,
    new Set([
      'action',
      'id',
      'story_time',
      'objective_fact',
      'reader_knowledge',
      'reveal_status',
      'reveal_chapter',
      'characters',
    ]),
    label,
  );
  const action = cleanText(getKey(event, 'action', 'upsert'), `${label}.action`, { maxBytes: 24 });
  require(
    opts.allowDelete ? action === 'upsert' || action === 'delete' : action === 'upsert',
    `${label}.action is invalid`,
  );
  const identifier = cleanText(event.id, `${label}.id`, { maxBytes: 24 });
  require(EVENT_ID.test(identifier), `${label}.id must look like E001`);
  if (action === 'delete') return { action, id: identifier };
  const revealStatus = cleanText(event.reveal_status, `${label}.reveal_status`, { maxBytes: 24 });
  require(REVEAL_STATUSES.includes(revealStatus as (typeof REVEAL_STATUSES)[number]), `${label}.reveal_status must be one of ('未揭示', '部分揭示', '已揭示')`);
  const revealRaw = event.reveal_chapter;
  const revealChapter = revealRaw === null ? null : asInt(revealRaw, `${label}.reveal_chapter`, { minimum: 1 });
  if (revealStatus === '未揭示') {
    require(revealChapter === null, `${label} must not put a future reveal chapter in established timeline facts`);
  } else {
    if (revealChapter === null) throw new TrackingError(`${label}.reveal_chapter is required once revealed`);
    require(revealChapter <= opts.throughChapter, `${label}.reveal_chapter cannot be in the future`);
  }
  return {
    action: action as 'upsert',
    id: identifier,
    story_time: cleanText(event.story_time, `${label}.story_time`, { maxBytes: 240 }),
    objective_fact: cleanText(event.objective_fact, `${label}.objective_fact`, { maxBytes: 480 }),
    reader_knowledge: cleanText(event.reader_knowledge, `${label}.reader_knowledge`, { maxBytes: 480 }),
    reveal_status: revealStatus,
    reveal_chapter: revealChapter,
    characters: cleanStringList(getKey(event, 'characters', []), `${label}.characters`, { maximum: 12, itemMaxBytes: 120 }),
  };
}

function normalizeTimelineState(value: unknown, lastChapter: number): Record<string, TimelineEvent> {
  const events = asMapping(value, 'tracking state.timeline');
  const normalized: Record<string, TimelineEvent> = {};
  for (const [rawIdentifier, rawEvent] of Object.entries(events)) {
    const identifier = cleanText(rawIdentifier, 'tracking state.timeline ID', { maxBytes: 24 });
    const event = asMapping(rawEvent, `tracking state.timeline.${identifier}`);
    requireKnownKeys(
      event,
      new Set([
        'id',
        'story_time',
        'objective_fact',
        'reader_knowledge',
        'reveal_status',
        'reveal_chapter',
        'characters',
        'first_recorded_chapter',
        'updated_chapter',
      ]),
      `tracking state.timeline.${identifier}`,
    );
    require(event.id === identifier, `tracking state.timeline.${identifier}.id does not match its key`);
    const changeBase: Record<string, unknown> = { action: 'upsert' };
    for (const [key, v] of Object.entries(event)) {
      if (key !== 'first_recorded_chapter' && key !== 'updated_chapter') changeBase[key] = v;
    }
    const change = normalizeTimelineChange(
      changeBase,
      `tracking state.timeline.${identifier}`,
      { allowDelete: false, throughChapter: lastChapter },
    ) as unknown as TimelineEvent & { action?: string };
    delete change.action;
    const first = asInt(event.first_recorded_chapter, `tracking state.timeline.${identifier}.first_recorded_chapter`, {
      minimum: 1,
    });
    const updated = asInt(event.updated_chapter, `tracking state.timeline.${identifier}.updated_chapter`, { minimum: 1 });
    require(first <= lastChapter, `timeline event ${identifier} starts after current chapter`);
    require(updated <= lastChapter, `timeline event ${identifier} updates after current chapter`);
    change.first_recorded_chapter = first;
    change.updated_chapter = updated;
    normalized[identifier] = change;
  }
  return normalized;
}

function renderTimelineViews(events: Record<string, TimelineEvent>, revision: number): [string, string] {
  const authorLines: string[] = [
    '# 作者真相时间线',
    '',
    `> 状态修订：${revision}。客观事实与读者认知的权威对照；未来揭示计划仍留在大纲。`,
    '',
    '| ID | 首次登记章 | 故事时间 | 客观事实 | 读者当前认知 | 揭示状态 | 实际揭示章 |',
    '|---|---:|---|---|---|---|---:|',
  ];
  const readerLines: string[] = [
    '# 读者已知时间线',
    '',
    `> 状态修订：${revision}。只呈现读者截至当前章节已经知道或相信的内容，不泄露作者侧客观真相。`,
    '',
    '| ID | 读者当前认知 | 认知截至章 |',
    '|---|---|---:|',
  ];
  for (const identifier of Object.keys(events).sort()) {
    const event = events[identifier]!;
    const reveal = event.reveal_chapter ? `第${event.reveal_chapter}章` : '—';
    const characters = event.characters.join('、');
    const objective = event.objective_fact + (characters ? `（涉及：${characters}）` : '');
    authorLines.push(
      `| ${identifier} | 第${event.first_recorded_chapter}章 | ${event.story_time} | ${objective} | ` +
        `${event.reader_knowledge} | ${event.reveal_status} | ${reveal} |`,
    );
    readerLines.push(`| ${identifier} | ${event.reader_knowledge} | 第${event.updated_chapter}章 |`);
  }
  return [authorLines.join('\n') + '\n', readerLines.join('\n') + '\n'];
}

/* --------------------------------------------------------------------------
 * Context validation / rendering
 * ------------------------------------------------------------------------ */

function validateContextInput(value: unknown, opts: { includeInitialFields: boolean }): ContextIn {
  const context = asMapping(value, 'context');
  const allowed = new Set(['position', 'long_term_constraints', 'active_character_names', 'continuity_risks']);
  if (opts.includeInitialFields) {
    allowed.add('recent_chapters');
    allowed.add('next_chapter_commitments');
  }
  requireKnownKeys(context, allowed, 'context');
  const normalized: ContextIn = {
    position: validatePosition(context.position),
    long_term_constraints: cleanStringList(getKey(context, 'long_term_constraints', []), 'context.long_term_constraints', {
      maximum: 6,
    }),
    active_character_names: asList(
      getKey(context, 'active_character_names', []),
      'context.active_character_names',
    ).map((name, index) => safeFileComponent(name, `context.active_character_names[${index}]`)),
    continuity_risks: cleanStringList(getKey(context, 'continuity_risks', []), 'context.continuity_risks', { maximum: 5 }),
  };
  require(
    normalized.active_character_names.length <= 6,
    'context.active_character_names may contain at most 6 names',
  );
  const portableSet = new Set(normalized.active_character_names.map((name) => portableNameKey(name)));
  require(
    portableSet.size === normalized.active_character_names.length,
    'context.active_character_names contains cross-platform duplicates',
  );
  if (opts.includeInitialFields) {
    const recent: RecentChapter[] = [];
    const rawRecent = asList(getKey(context, 'recent_chapters', []), 'context.recent_chapters');
    for (const [index, rawItem] of rawRecent.entries()) {
      const item = asMapping(rawItem, `context.recent_chapters[${index}]`);
      requireKnownKeys(item, new Set(['chapter', 'summary']), `context.recent_chapters[${index}]`);
      recent.push({
        chapter: asInt(item.chapter, `context.recent_chapters[${index}].chapter`, { minimum: 1 }),
        summary: cleanText(item.summary, `context.recent_chapters[${index}].summary`, { maxBytes: 360 }),
      });
    }
    require(recent.length <= 3, 'context.recent_chapters may contain at most 3 items');
    normalized.recent_chapters = recent;
    normalized.next_chapter_commitments = cleanStringList(getKey(context, 'next_chapter_commitments', []), 'context.next_chapter_commitments', {
      maximum: 5,
    });
  }
  return normalized;
}

const FORESHADOW_IMPORTANCE_INDEX: Record<string, number> = { 高: 0, 中: 1, 低: 2 };

function activeForeshadowLines(rows: Record<string, ForeshadowRow>): string[] {
  const candidates = Object.values(rows).filter((row) => row.status === '已埋');
  candidates.sort((a, b) => {
    const byImportance = FORESHADOW_IMPORTANCE_INDEX[a.importance]! - FORESHADOW_IMPORTANCE_INDEX[b.importance]!;
    if (byImportance !== 0) return byImportance;
    const aPlanned = a.planned_resolution_chapter ?? 10 ** 12;
    const bPlanned = b.planned_resolution_chapter ?? 10 ** 12;
    if (aPlanned !== bPlanned) return aPlanned - bPlanned;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const result: string[] = [];
  for (const row of candidates.slice(0, 8)) {
    const planned = row.planned_resolution_chapter ? `第${row.planned_resolution_chapter}章` : '回收章未定';
    result.push(`${row.id}｜${row.summary}｜埋第${row.planted_chapter}章｜${planned}｜${row.importance}`);
  }
  return result;
}

function renderContext(state: TrackingState): string {
  const context = state.context;
  const position = context.position;
  const currentChapter = state.last_committed_chapter === 0 ? '尚未开篇' : `第${state.last_committed_chapter}章`;
  const characterLines = context.active_character_names.map(
    (name) =>
      `${name}｜${state.characters[name]!.identity}｜${state.characters[name]!.state}｜目标：${state.characters[name]!.goal}`,
  );
  const sections: [string, string[]][] = [
    [
      '## 当前位置',
      [
        `当前章：${currentChapter}`,
        `卷：${position.volume}（始于第${position.volume_start_chapter}章）`,
        `故事时间：${position.story_time}`,
        `场景：${position.scene}`,
      ],
    ],
    ['## 长期约束', context.long_term_constraints],
    ['## 核心角色状态', characterLines],
    ['## 活跃伏笔', activeForeshadowLines(state.foreshadow)],
    ['## 近三章速记', context.recent_chapters.map((item) => `第${item.chapter}章｜${item.summary}`)],
    ['## 下一章承诺', context.next_chapter_commitments],
    ['## 连贯性风险', context.continuity_risks],
  ];
  const lines: string[] = [
    `# 写作连续性上下文 — ${state.book_title}`,
    '',
    `> 状态修订：${state.state_revision}。截至当前章的续写状态卡，只放下一章真正需要的连续性状态。`,
    '',
  ];
  for (const [heading, values] of sections) {
    lines.push(heading);
    lines.push(...values.map((value) => `- ${value}`));
    if (values.length === 0) lines.push('- 无');
    lines.push('');
  }
  const payload = lines.join('\n').replace(/\s+$/, '') + '\n';
  const headings = payload.split('\n').filter((line) => line.startsWith('## '));
  const headingsEqual =
    headings.length === CONTEXT_HEADINGS.length &&
    headings.every((heading, index) => heading === CONTEXT_HEADINGS[index]);
  require(headingsEqual, 'generated context headings do not match the seven-section schema');
  require(byteSize(payload) <= CONTEXT_MAX_BYTES, `hot context exceeds ${CONTEXT_MAX_BYTES} bytes`);
  return payload;
}

/* --------------------------------------------------------------------------
 * Delta validation / rendering
 * ------------------------------------------------------------------------ */

function normalizeArcAdvances(value: unknown, label: string): ArcAdvance[] {
  const items = asList(value, label);
  const advanced: ArcAdvance[] = [];
  for (const [index, raw] of items.entries()) {
    const item = asMapping(raw, `${label}[${index}]`);
    requireKnownKeys(item, new Set(['line', 'stage', 'evidence_anchor']), `${label}[${index}]`);
    advanced.push({
      line: safeFileComponent(item.line, `${label}[${index}].line`),
      stage: asInt(item.stage, `${label}[${index}].stage`, { minimum: 1 }),
      evidence_anchor: cleanText(item.evidence_anchor, `${label}[${index}].evidence_anchor`, { maxBytes: 240 }),
    });
  }
  const lineSet = new Set(advanced.map((advance) => advance.line));
  require(lineSet.size === advanced.length, `${label} contains duplicate lines`);
  return advanced;
}

function normalizeDelta(
  value: unknown,
  opts: { throughChapter: number; snapshots: Record<string, CharacterSnapshot>; existingCoreNames: Record<string, string> },
): DeltaNormalized {
  const delta = asMapping(value, 'delta');
  requireKnownKeys(
    delta,
    new Set([
      'result',
      'character_changes',
      'foreshadow_changes',
      'timeline_events',
      'constraints',
      'next_chapter_commitments',
      'retired_context_items',
      'retired_characters',
      'arc_advances',
    ]),
    'delta',
  );
  const retiredCharacters = asList(getKey(delta, 'retired_characters', []), 'delta.retired_characters').map((name, index) =>
    safeFileComponent(name, `delta.retired_characters[${index}]`),
  );
  const retiredKeys = retiredCharacters.map((name) => portableNameKey(name));
  require(new Set(retiredKeys).size === retiredKeys.length, 'delta.retired_characters contains duplicate characters');
  const retiring = new Set(retiredKeys);
  const characterChanges: { name: string; change: string }[] = [];
  const rawChanges = asList(getKey(delta, 'character_changes', []), 'delta.character_changes');
  for (const [index, rawChange] of rawChanges.entries()) {
    const change = asMapping(rawChange, `delta.character_changes[${index}]`);
    requireKnownKeys(change, new Set(['name', 'change']), `delta.character_changes[${index}]`);
    const name = safeFileComponent(change.name, `delta.character_changes[${index}].name`);
    const existing = opts.existingCoreNames[portableNameKey(name)];
    const isCore = Object.prototype.hasOwnProperty.call(opts.snapshots, name) || existing !== undefined;
    // 本章退役的角色记录最后一次变化即可，不必再交一份马上要删的快照。
    require(
      !isCore ||
        Object.prototype.hasOwnProperty.call(opts.snapshots, name) ||
        retiring.has(portableNameKey(name)),
      `core character ${name} changed but has no current snapshot`,
    );
    characterChanges.push({
      name,
      change: cleanText(change.change, `delta.character_changes[${index}].change`, { maxBytes: 360 }),
    });
  }
  const characterKeys = characterChanges.map((item) => portableNameKey(item.name));
  require(new Set(characterKeys).size === characterKeys.length, 'delta.character_changes contains duplicate characters');

  const foreshadowChanges = asList(getKey(delta, 'foreshadow_changes', []), 'delta.foreshadow_changes').map((raw, index) =>
    normalizeForeshadowChange(raw, `delta.foreshadow_changes[${index}]`, {
      allowDelete: true,
      throughChapter: opts.throughChapter,
    }),
  );
  const timelineEvents = asList(getKey(delta, 'timeline_events', []), 'delta.timeline_events').map((raw, index) =>
    normalizeTimelineChange(raw, `delta.timeline_events[${index}]`, {
      allowDelete: true,
      throughChapter: opts.throughChapter,
    }),
  );
  const fsIds = foreshadowChanges.map((item) => item.id);
  require(new Set(fsIds).size === fsIds.length, 'delta.foreshadow_changes contains duplicate IDs');
  const tlIds = timelineEvents.map((item) => item.id);
  require(new Set(tlIds).size === tlIds.length, 'delta.timeline_events contains duplicate IDs');

  const snapshotNames = new Set(Object.keys(opts.snapshots));
  const changedNames = new Set(characterChanges.map((item) => item.name));
  for (const snapshotName of snapshotNames) {
    require(
      changedNames.has(snapshotName),
      'character_snapshots must contain exactly the core characters changed by this transaction',
    );
  }

  const arcAdvances = normalizeArcAdvances(getKey(delta, 'arc_advances', []), 'delta.arc_advances');
  return {
    result: cleanText(delta.result, 'delta.result', { maxBytes: 480 }),
    character_changes: characterChanges,
    foreshadow_changes: foreshadowChanges,
    timeline_events: timelineEvents,
    constraints: cleanStringList(getKey(delta, 'constraints', []), 'delta.constraints', { maximum: 6 }),
    next_chapter_commitments: cleanStringList(getKey(delta, 'next_chapter_commitments', []), 'delta.next_chapter_commitments', {
      maximum: 5,
    }),
    retired_context_items: cleanStringList(getKey(delta, 'retired_context_items', []), 'delta.retired_context_items', {
      maximum: 11,
    }),
    retired_characters: retiredCharacters,
    arc_advances: arcAdvances,
  };
}

function renderDelta(chapter: number, title: string, delta: DeltaNormalized, coreNames: Set<string>): string {
  const lines: string[] = [
    `# 第${String(chapter).padStart(3, '0')}章 · ${title}`,
    `- 结果：${delta.result}`,
    `- 下一章承诺：${delta.next_chapter_commitments.join('；') || '无'}`,
    '',
    '## 角色变化',
  ];
  for (const item of delta.character_changes) {
    lines.push(`- ${item.name}｜${coreNames.has(item.name) ? '核心' : '临时'}｜${item.change}`);
  }
  if (delta.character_changes.length === 0) lines.push('- 无');
  lines.push('', '## 伏笔变化');
  for (const item of delta.foreshadow_changes) {
    if (item.action === 'delete') {
      lines.push(`- ${item.id}｜删除当前登记`);
    } else {
      const planned = item.planned_resolution_chapter ? `第${item.planned_resolution_chapter}章` : '未定';
      lines.push(`- ${item.id}｜${item.status}｜${item.summary}｜回收${planned}`);
    }
  }
  if (delta.foreshadow_changes.length === 0) lines.push('- 无');
  lines.push('', '## 时间与揭示');
  for (const item of delta.timeline_events) {
    if (item.action === 'delete') {
      lines.push(`- ${item.id}｜删除当前登记`);
    } else {
      lines.push(
        `- ${item.id}｜${item.story_time}｜事实：${item.objective_fact}｜读者：${item.reader_knowledge}｜${item.reveal_status}`,
      );
    }
  }
  if (delta.timeline_events.length === 0) lines.push('- 无');
  lines.push('', '## 连贯性约束');
  for (const item of delta.constraints) lines.push(`- ${item}`);
  if (delta.constraints.length === 0) lines.push('- 无');
  const retired = [...delta.retired_context_items, ...delta.retired_characters.map((name) => `角色状态：${name}`)];
  if (retired.length > 0) {
    // 退役条目在此留档，续写状态卡收缩后仍可回查当初撤下了什么。
    lines.push('', '## 本章退役登记');
    for (const item of retired) lines.push(`- ${item}`);
  }
  const payload = lines.join('\n') + '\n';
  const size = byteSize(payload);
  require(size <= DELTA_MAX_BYTES, `chapter delta is ${size} bytes; hard cap is ${DELTA_MAX_BYTES}`);
  return payload;
}

/* --------------------------------------------------------------------------
 * State normalization / loading / initial document
 * ------------------------------------------------------------------------ */

function normalizeState(document: unknown): TrackingState {
  const root = asMapping(document, 'tracking state');
  requireKnownKeys(
    root,
    new Set([
      'schema_version',
      'book_title',
      'last_committed_chapter',
      'imported_through_chapter',
      'state_revision',
      'context',
      'characters',
      'foreshadow',
      'timeline',
      'arcs',
    ]),
    'tracking state',
  );
  require(root.schema_version === TRACKING_SCHEMA_VERSION, 'tracking state schema is unsupported');
  const lastChapter = asInt(root.last_committed_chapter, 'tracking state.last_committed_chapter');
  const importedThrough = asInt(root.imported_through_chapter, 'tracking state.imported_through_chapter');
  require(importedThrough <= lastChapter, 'imported chapter cutoff exceeds current chapter');
  const context = validateContextInput(root.context, { includeInitialFields: true });
  require(
    context.position.volume_start_chapter <= Math.max(1, lastChapter),
    'context.position.volume_start_chapter is after the current writing position',
  );
  const recentNumbers = (context.recent_chapters ?? []).map((item) => item.chapter);
  const sortedRecent = [...recentNumbers].sort((a, b) => a - b);
  require(
    recentNumbers.every((value, index) => sortedRecent[index] === value),
    'context.recent_chapters must be ordered',
  );
  require(new Set(recentNumbers).size === recentNumbers.length, 'context.recent_chapters contains duplicates');
  require(
    recentNumbers.every((value) => value <= lastChapter),
    'context.recent_chapters cannot include future chapters',
  );
  const characters = normalizeSnapshots(getKey(root, 'characters', {}), 'tracking state.characters');
  for (const name of context.active_character_names) {
    require(
      Object.prototype.hasOwnProperty.call(characters, name),
      `active core character ${name} has no current snapshot`,
    );
  }
  const foreshadow = normalizeForeshadowState(getKey(root, 'foreshadow', {}), lastChapter);
  const timeline = normalizeTimelineState(getKey(root, 'timeline', {}), lastChapter);
  const arcs = normalizeArcsState(getKey(root, 'arcs', {}), lastChapter);
  if (lastChapter === 0) {
    require(Object.keys(foreshadow).length === 0, 'a chapter-0 project cannot have planted foreshadow facts');
    require(Object.keys(timeline).length === 0, 'a chapter-0 project cannot have established timeline facts');
    require(
      Object.values(arcs).every((arc) => Object.keys(arc.evidence).length === 0),
      'a chapter-0 project cannot have advanced any role line',
    );
  }
  return {
    schema_version: TRACKING_SCHEMA_VERSION,
    book_title: cleanText(root.book_title, 'tracking state.book_title', { maxBytes: 240 }),
    last_committed_chapter: lastChapter,
    imported_through_chapter: importedThrough,
    state_revision: asInt(root.state_revision, 'tracking state.state_revision'),
    context: context as ContextState,
    characters,
    foreshadow,
    timeline,
    arcs,
  };
}

function loadState(bookDir: string): TrackingState {
  const filePath = statePath(bookDir);
  require(fs.existsSync(filePath), 'tracking state is missing; run init first');
  return normalizeState(readJson(filePath));
}

function normalizeInitialDocument(document: unknown): TrackingState {
  const root = asMapping(document, 'init input');
  requireKnownKeys(
    root,
    new Set([
      'schema_version',
      'book_title',
      'last_chapter',
      'context',
      'character_snapshots',
      'foreshadow',
      'timeline_events',
      'arcs',
    ]),
    'init input',
  );
  require(root.schema_version === INPUT_SCHEMA_VERSION, 'init input schema_version is unsupported');
  const lastChapter = asInt(root.last_chapter, 'last_chapter');
  const context = validateContextInput(root.context, { includeInitialFields: true });
  const snapshots = normalizeSnapshots(getKey(root, 'character_snapshots', {}));

  const foreshadow: Record<string, ForeshadowRow> = {};
  const rawForeshadow = asList(getKey(root, 'foreshadow', []), 'foreshadow');
  for (const [index, rawRow] of rawForeshadow.entries()) {
    const row = normalizeForeshadowChange(rawRow, `foreshadow[${index}]`, {
      allowDelete: false,
      throughChapter: lastChapter,
    }) as unknown as ForeshadowRow & { action?: string };
    require(!Object.prototype.hasOwnProperty.call(foreshadow, row.id), `duplicate foreshadow ID ${row.id}`);
    delete row.action;
    row.updated_chapter = Math.max(1, lastChapter);
    foreshadow[row.id] = row;
  }

  const timeline: Record<string, TimelineEvent> = {};
  const rawTimeline = asList(getKey(root, 'timeline_events', []), 'timeline_events');
  for (const [index, rawEvent] of rawTimeline.entries()) {
    const event = normalizeTimelineChange(rawEvent, `timeline_events[${index}]`, {
      allowDelete: false,
      throughChapter: lastChapter,
    }) as unknown as TimelineEvent & { action?: string };
    require(!Object.prototype.hasOwnProperty.call(timeline, event.id), `duplicate timeline event ID ${event.id}`);
    delete event.action;
    event.first_recorded_chapter = Math.max(1, lastChapter);
    event.updated_chapter = Math.max(1, lastChapter);
    timeline[event.id] = event;
  }

  const arcs: Record<string, ArcState> = {};
  const rawArcs = asMapping(getKey(root, 'arcs', {}), 'init input.arcs');
  for (const [rawName, rawArc] of Object.entries(rawArcs)) {
    const name = safeFileComponent(rawName, 'init input.arcs line name');
    const key = portableNameKey(name);
    const existingKeys = new Set(Object.keys(arcs).map((other) => portableNameKey(other)));
    require(!existingKeys.has(key), `init input.arcs contains a duplicate line ${name}`);
    const skeleton = normalizeArcSkeleton(rawArc, `init input.arcs.${name}`);
    arcs[name] = { ...skeleton, current_stage: 1, evidence: {}, registered_chapter: Math.max(0, lastChapter) };
  }

  return normalizeState({
    schema_version: TRACKING_SCHEMA_VERSION,
    book_title: cleanText(root.book_title, 'book_title', { maxBytes: 240 }),
    last_committed_chapter: lastChapter,
    imported_through_chapter: lastChapter,
    state_revision: 0,
    context,
    characters: snapshots,
    foreshadow,
    timeline,
    arcs,
  });
}

function normalizeTransaction(state: TrackingState, document: unknown): TransactionNormalized {
  const root = asMapping(document, 'transaction');
  requireKnownKeys(
    root,
    new Set([
      'schema_version',
      'mode',
      'chapter',
      'chapter_title',
      'expected_state_revision',
      'delta',
      'context',
      'character_snapshots',
      'arcs',
    ]),
    'transaction',
  );
  require(root.schema_version === INPUT_SCHEMA_VERSION, 'transaction schema_version is unsupported');
  const mode = cleanText(root.mode, 'mode', { maxBytes: 24 });
  require(mode === 'append' || mode === 'revision', 'mode must be append or revision');
  const chapter = asInt(root.chapter, 'chapter', { minimum: 1 });
  const expectedRevision = asInt(root.expected_state_revision, 'expected_state_revision');
  require(expectedRevision === state.state_revision, 'tracking state changed since this transaction was prepared');
  const last = state.last_committed_chapter;
  if (mode === 'append') {
    require(chapter === last + 1, `append chapter must be ${last + 1}, got ${chapter}`);
  } else {
    require(chapter <= last, `cannot revise unwritten chapter ${chapter}; last committed chapter is ${last}`);
  }
  const context = validateContextInput(root.context, { includeInitialFields: false });
  const snapshots = normalizeSnapshots(getKey(root, 'character_snapshots', {}));
  const existingNames: Record<string, string> = {};
  for (const name of Object.keys(state.characters)) {
    existingNames[portableNameKey(name)] = name;
  }
  for (const name of Object.keys(snapshots)) {
    const existing = existingNames[portableNameKey(name)];
    require(existing === undefined || existing === name, `character ${name} conflicts with existing character ${existing}`);
  }
  const throughChapter = mode === 'append' ? chapter : last;
  const delta = normalizeDelta(root.delta, {
    throughChapter,
    snapshots,
    existingCoreNames: existingNames,
  });

  const registrations: Record<string, ArcState> = {};
  const existingArcKeys = new Set(Object.keys(state.arcs).map((name) => portableNameKey(name)));
  const rawArcs = asMapping(getKey(root, 'arcs', {}), 'transaction.arcs');
  for (const [rawName, rawArc] of Object.entries(rawArcs)) {
    const name = safeFileComponent(rawName, 'transaction.arcs line name');
    const key = portableNameKey(name);
    require(!existingArcKeys.has(key), `arc line ${name} is already registered`);
    const registrationKeys = new Set(Object.keys(registrations).map((other) => portableNameKey(other)));
    require(!registrationKeys.has(key), `transaction.arcs contains a duplicate line ${name}`);
    const skeleton = normalizeArcSkeleton(rawArc, `transaction.arcs.${name}`);
    registrations[name] = { ...skeleton, current_stage: 1, evidence: {}, registered_chapter: chapter };
  }

  return {
    mode: mode as 'append' | 'revision',
    chapter,
    title: cleanText(root.chapter_title, 'chapter_title', { maxBytes: 240 }),
    delta,
    context,
    snapshots,
    registrations,
  };
}

/* --------------------------------------------------------------------------
 * Merge transaction (in-memory; all validation happens before any write)
 * ------------------------------------------------------------------------ */

/** Python `checkpoint_record` — recompute updated_chapter (+ first_recorded_chapter when kept). */
function checkpointRecord(
  change: Record<string, unknown>,
  chapter: number,
  previous: Record<string, unknown> | null | undefined,
  opts: { keepFirstChapter: boolean },
): Record<string, unknown> {
  const current: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(change)) {
    if (key !== 'action') current[key] = value;
  }
  const previousUpdated = previous ? (previous.updated_chapter as number | undefined) : undefined;
  current.updated_chapter = Math.max(previousUpdated ?? chapter, chapter);
  if (opts.keepFirstChapter) {
    const previousFirst = previous ? (previous.first_recorded_chapter as number | undefined) : undefined;
    current.first_recorded_chapter = previousFirst ?? chapter;
  }
  return current;
}

function mergeTransaction(state: TrackingState, transaction: TransactionNormalized): TrackingState {
  const nextState: TrackingState = structuredClone(state) as TrackingState;
  const chapter = transaction.chapter;
  if (transaction.mode === 'append') nextState.last_committed_chapter = chapter;
  nextState.state_revision += 1;
  Object.assign(nextState.characters, transaction.snapshots);

  const nextContext = transaction.context;
  // 退役说的是「从此刻起离开当前状态」，只有 append 的逐章记录代表此刻；
  // 修订记录属于被改写的旧章，落在那里会谎报退役发生的章节。
  const isRevision = transaction.mode === 'revision';
  require(
    !(isRevision && transaction.delta.retired_characters.length > 0),
    'retired_characters must be committed in an append transaction, not a revision',
  );
  for (const name of transaction.delta.retired_characters) {
    require(
      Object.prototype.hasOwnProperty.call(nextState.characters, name),
      `retired character ${name} has no current snapshot`,
    );
    require(
      !Object.prototype.hasOwnProperty.call(transaction.snapshots, name),
      `character ${name} cannot be retired and updated in the same transaction`,
    );
    require(
      !nextContext.active_character_names.includes(name),
      `retired character ${name} is still listed in context.active_character_names`,
    );
    delete nextState.characters[name];
  }

  // 上下文条目是整份提交的；漏写会静默丢历史裁定，因此掉落必须显式声明。
  const previousItems = new Set([...state.context.long_term_constraints, ...state.context.continuity_risks]);
  const nextItemsSet = new Set([
    ...(nextContext.long_term_constraints ?? []),
    ...(nextContext.continuity_risks ?? []),
  ]);
  const dropped = new Set([...previousItems].filter((item) => !nextItemsSet.has(item)));
  const droppedSorted = [...dropped].sort();
  require(
    !(isRevision && droppedSorted.length > 0),
    'a revision must resubmit every current context item; retire them in an append transaction instead: ' +
      droppedSorted.join('；'),
  );
  const declared = new Set(transaction.delta.retired_context_items);
  const undeclared = droppedSorted.filter((item) => !declared.has(item));
  require(
    undeclared.length === 0,
    'context items were dropped without being declared in delta.retired_context_items: ' + undeclared.join('；'),
  );
  transaction.delta.retired_context_items = droppedSorted;

  for (const change of transaction.delta.foreshadow_changes) {
    if (change.action === 'delete') {
      delete nextState.foreshadow[change.id];
    } else {
      nextState.foreshadow[change.id] = checkpointRecord(
        change as unknown as Record<string, unknown>,
        chapter,
        nextState.foreshadow[change.id] as unknown as Record<string, unknown>,
        { keepFirstChapter: false },
      ) as unknown as ForeshadowRow;
    }
  }
  for (const change of transaction.delta.timeline_events) {
    if (change.action === 'delete') {
      delete nextState.timeline[change.id];
    } else {
      nextState.timeline[change.id] = checkpointRecord(
        change as unknown as Record<string, unknown>,
        chapter,
        nextState.timeline[change.id] as unknown as Record<string, unknown>,
        { keepFirstChapter: true },
      ) as unknown as TimelineEvent;
    }
  }

  // 角色线：先注册新线，再按序推进（同一事务可注册并立即推进一条新线）。
  require(
    !(isRevision && transaction.delta.arc_advances.length > 0),
    'arc advances must be committed in an append transaction, not a revision',
  );
  for (const [name, arc] of Object.entries(transaction.registrations)) {
    nextState.arcs[name] = arc;
  }
  for (const advance of transaction.delta.arc_advances) {
    const arc = nextState.arcs[advance.line];
    if (arc === undefined) throw new TrackingError(`arc line ${advance.line} is not registered`);
    const current = arc.current_stage;
    require(current !== null, `arc line ${advance.line} is already complete`);
    require(
      advance.stage === current,
      `arc line ${advance.line} can only advance its active stage ${current}, got ${advance.stage}`,
    );
    arc.evidence[String(advance.stage)] = { chapter, anchor: advance.evidence_anchor };
    arc.current_stage = advance.stage === arc.stages.length ? null : advance.stage + 1;
  }

  const recentByChapter = new Map<number, RecentChapter>();
  for (const item of state.context.recent_chapters) recentByChapter.set(item.chapter, item);
  if (recentByChapter.has(chapter) || transaction.mode === 'append') {
    recentByChapter.set(chapter, { chapter, summary: transaction.delta.result });
  }
  const recent = [...recentByChapter.values()].sort((a, b) => a.chapter - b.chapter).slice(-3);
  const currentLast = nextState.last_committed_chapter;
  const nextCommitments =
    transaction.mode === 'append' || chapter === currentLast
      ? transaction.delta.next_chapter_commitments
      : state.context.next_chapter_commitments;
  nextState.context = {
    ...(nextContext as ContextCore),
    recent_chapters: recent,
    next_chapter_commitments: nextCommitments,
  };
  return normalizeState(nextState);
}

/* --------------------------------------------------------------------------
 * View rendering / writing / size warnings
 * ------------------------------------------------------------------------ */

function renderViews(state: TrackingState): Record<string, string> {
  const revision = state.state_revision;
  const views: Record<string, string> = {
    '上下文.md': renderContext(state),
    '伏笔.md': renderForeshadow(state.foreshadow, revision),
  };
  const [author, reader] = renderTimelineViews(state.timeline, revision);
  views['时间线/作者真相.md'] = author;
  views['时间线/读者已知.md'] = reader;
  for (const [name, snapshot] of Object.entries(state.characters)) {
    views[`角色状态/${name}.md`] = renderSnapshot(name, snapshot, state.last_committed_chapter, revision);
  }
  for (const [name, arc] of Object.entries(state.arcs)) {
    views[`角色线/${name}.md`] = renderArc(name, arc, revision);
  }
  return views;
}

function writeViews(tracking: string, views: Record<string, string>): void {
  // 上下文携带 next revision，先写它；任何后续失败都会让 hook/check 发现
  // 上下文 revision 与最后提交的 _tracking-state.json 不一致。
  writeIfChanged(path.join(tracking, '上下文.md'), views['上下文.md']!);
  const sortedRest = Object.keys(views)
    .filter((relative) => relative !== '上下文.md')
    .sort();
  for (const relative of sortedRest) {
    writeIfChanged(path.join(tracking, relative), views[relative]!);
  }
  const expectedCharacterFiles = new Set(
    Object.keys(views)
      .filter((relative) => relative.startsWith('角色状态/'))
      .map((relative) => path.basename(relative)),
  );
  const characterDir = path.join(tracking, '角色状态');
  fs.mkdirSync(characterDir, { recursive: true });
  for (const fileName of fs.readdirSync(characterDir)) {
    if (fileName.endsWith('.md') && !expectedCharacterFiles.has(fileName)) {
      fs.unlinkSync(path.join(characterDir, fileName));
    }
  }
  const expectedArcFiles = new Set(
    Object.keys(views)
      .filter((relative) => relative.startsWith('角色线/'))
      .map((relative) => path.basename(relative)),
  );
  const arcDir = path.join(tracking, '角色线');
  fs.mkdirSync(arcDir, { recursive: true });
  for (const fileName of fs.readdirSync(arcDir)) {
    if (fileName.endsWith('.md') && !expectedArcFiles.has(fileName)) {
      fs.unlinkSync(path.join(arcDir, fileName));
    }
  }
}

function warnSizes(io: TrackingIo, views: Record<string, string>, deltaPayload?: string): void {
  if (deltaPayload !== undefined && byteSize(deltaPayload) > DELTA_TARGET_BYTES) {
    io.stderr(`WARNING: chapter delta is ${byteSize(deltaPayload)} bytes; target is <= ${DELTA_TARGET_BYTES}`);
  }
  const contextSize = byteSize(views['上下文.md']!);
  if (contextSize > CONTEXT_TARGET_BYTES) {
    io.stderr(`WARNING: hot context is ${contextSize} bytes; target is <= ${CONTEXT_TARGET_BYTES}`);
  }
  for (const [relative, payload] of Object.entries(views)) {
    if (!relative.startsWith('角色状态/')) continue;
    const size = byteSize(payload);
    if (size > SNAPSHOT_TARGET_BYTES) {
      io.stderr(
        `WARNING: character snapshot ${path.basename(relative, '.md')} is ${size} bytes; target is <= ${SNAPSHOT_TARGET_BYTES}`,
      );
    }
  }
  for (const [relative, payload] of Object.entries(views)) {
    if (!relative.startsWith('角色线/')) continue;
    const size = byteSize(payload);
    if (size > ARC_VIEW_TARGET_BYTES) {
      io.stderr(
        `WARNING: arc view ${path.basename(relative, '.md')} is ${size} bytes; target is <= ${ARC_VIEW_TARGET_BYTES}`,
      );
    }
  }
}

/* --------------------------------------------------------------------------
 * Library operations (used by WebUI engine)
 * ------------------------------------------------------------------------ */

/**
 * Python `initialize` — build initial state, archive any pre-transaction 追踪/,
 * write derived views, then atomically write `_tracking-state.json` last.
 */
export function initializeTracking(bookDir: string, initDoc: unknown, io: TrackingIo = defaultIo): TrackingState {
  const tracking = trackingRoot(bookDir);
  require(!fs.existsSync(statePath(bookDir)), 'tracking state already exists; init never overwrites project state');
  const state = normalizeInitialDocument(initDoc);
  const views = renderViews(state);
  const statePayload = jsonPayload(state);

  // 输入全部校验通过后才动用户文件，失败的 init 不会挪走任何东西。
  const archived = archiveRetiredTrackingPaths(tracking);
  for (const directory of ['逐章记录', '角色状态', '时间线']) {
    fs.mkdirSync(path.join(tracking, directory), { recursive: true });
  }
  writeViews(tracking, views);
  atomicWriteText(statePath(bookDir), statePayload);
  warnSizes(io, views);
  if (archived.length > 0) {
    io.stderr(
      `NOTE: 旧追踪结构已原样移入 追踪/${RETIRED_ARCHIVE_DIR}/：${archived.join(', ')}；` +
        '当前状态以本次 init 输入为准，旧文件不参与解析。',
    );
  }
  return state;
}

/**
 * Python `apply_transaction` — validate, merge in memory, render delta + views,
 * then write delta and views, and finally atomically replace `_tracking-state.json`.
 */
export function applyTransaction(bookDir: string, txDoc: unknown, io: TrackingIo = defaultIo): TrackingState {
  const tracking = trackingRoot(bookDir);
  requireNoRetiredTrackingPaths(tracking);
  const state = loadState(bookDir);
  const transaction = normalizeTransaction(state, txDoc);
  const nextState = mergeTransaction(state, transaction);

  const coreNames = new Set([...Object.keys(nextState.characters), ...transaction.delta.retired_characters]);
  const deltaPayload = renderDelta(transaction.chapter, transaction.title, transaction.delta, coreNames);
  const views = renderViews(nextState);
  const nextStatePayload = jsonPayload(nextState);
  const deltaFile = deltaPath(tracking, transaction.chapter);
  if (transaction.mode === 'append' && fs.existsSync(deltaFile)) {
    require(
      fs.readFileSync(deltaFile, 'utf8') === deltaPayload,
      `chapter delta ${transaction.chapter} already exists with different content`,
    );
  }

  writeIfChanged(deltaFile, deltaPayload);
  writeViews(tracking, views);
  // 唯一权威文件最后落盘；在此之前失败可用同一事务直接重跑。
  atomicWriteText(statePath(bookDir), nextStatePayload);
  warnSizes(io, views, deltaPayload);
  return nextState;
}

/** Python `check_project` — verify state, weekly deltas, and every derived view. */
export function checkTracking(bookDir: string): TrackingState {
  const tracking = trackingRoot(bookDir);
  requireNoRetiredTrackingPaths(tracking);
  const state = loadState(bookDir);
  const lastChapter = state.last_committed_chapter;
  const requiredDeltaStart = state.imported_through_chapter + 1;
  for (let chapter = requiredDeltaStart; chapter <= lastChapter; chapter++) {
    require(fs.existsSync(deltaPath(tracking, chapter)), `chapter delta ${chapter} is missing`);
  }
  const deltaDir = path.join(tracking, '逐章记录');
  if (fs.existsSync(deltaDir)) {
    for (const fileName of fs.readdirSync(deltaDir)) {
      if (!fileName.startsWith('第') || !fileName.endsWith('章.md')) continue;
      const match = /^第(\d+)章\.md$/.exec(fileName);
      if (match === null) throw new TrackingError(`chapter delta has an invalid filename: ${fileName}`);
      const chapter = asInt(Number(match[1]!), `chapter delta ${fileName}`, { minimum: 1 });
      require(path.join(deltaDir, fileName) === deltaPath(tracking, chapter), `chapter delta ${chapter} filename is not canonical`);
      require(chapter <= lastChapter, `chapter delta ${chapter} exceeds last_committed_chapter`);
      require(
        fs.statSync(path.join(deltaDir, fileName)).size <= DELTA_MAX_BYTES,
        `chapter delta ${chapter} exceeds ${DELTA_MAX_BYTES} bytes`,
      );
    }
  }

  const expectedViews = renderViews(state);
  for (const [relative, expected] of Object.entries(expectedViews)) {
    const viewPath = path.join(tracking, relative);
    require(fs.existsSync(viewPath), `derived view is missing: ${relative}`);
    require(
      fs.readFileSync(viewPath, 'utf8') === expected,
      `derived view differs from _tracking-state.json: ${relative}`,
    );
  }
  const expectedCharacterFiles = new Set(
    Object.keys(expectedViews)
      .filter((relative) => relative.startsWith('角色状态/'))
      .map((relative) => path.basename(relative)),
  );
  const characterDir = path.join(tracking, '角色状态');
  const actualCharacterFiles = fs.existsSync(characterDir)
    ? new Set(fs.readdirSync(characterDir).filter((name) => name.endsWith('.md')))
    : new Set<string>();
  require(
    setsEqualStr(actualCharacterFiles, expectedCharacterFiles),
    'character snapshot files differ from tracking state',
  );
  const expectedArcFiles = new Set(
    Object.keys(expectedViews)
      .filter((relative) => relative.startsWith('角色线/'))
      .map((relative) => path.basename(relative)),
  );
  const arcDir = path.join(tracking, '角色线');
  const actualArcFiles = fs.existsSync(arcDir)
    ? new Set(fs.readdirSync(arcDir).filter((name) => name.endsWith('.md')))
    : new Set<string>();
  require(setsEqualStr(actualArcFiles, expectedArcFiles), 'arc view files differ from tracking state');
  return state;
}

/** Python `audit_arcs` — read-only role-line plan-vs-actual audit from the state authority. */
export function auditArcs(bookDir: string, io: TrackingIo = defaultIo): ArcAuditReport {
  requireNoRetiredTrackingPaths(trackingRoot(bookDir));
  const state = loadState(bookDir);
  const last = state.last_committed_chapter;
  const report: Record<string, ArcAuditLine> = {};
  const notes: string[] = [];
  for (const name of Object.keys(state.arcs).sort()) {
    const arc = state.arcs[name]!;
    const stageCount = arc.stages.length;
    const current = arc.current_stage;
    const completed = current === null;
    // 已达成（含证据）的阶段数：已完成时全部；否则 = 当前进行阶段的前一阶段。
    const achieved = completed ? stageCount : current! - 1;
    const lastEvidence = achieved >= 1 ? arc.evidence[String(achieved)] : undefined;
    const planned = achieved >= 1 ? arc.stages[achieved - 1]!.planned_chapters : '';
    let overdue = false;
    if (!completed && planned) {
      const match = CHAPTER_RANGE_RE.exec(planned);
      if (match) {
        const end = match[2] ? Number(match[2]) : Number(match[1]!);
        if (last > end) overdue = true;
      }
    }
    report[name] = {
      status: completed ? 'completed' : `active:${current}`,
      total_stages: stageCount,
      achieved_stages: achieved,
      last_advance_chapter: lastEvidence ? lastEvidence.chapter : null,
      planned_for_current: planned,
      registered_chapter: arc.registered_chapter,
      overdue,
    };
    if (completed) {
      notes.push(`NOTE: 角色线「${name}」已完结（${stageCount} 个阶段全部达成并有证据锚点）。`);
    } else if (overdue) {
      notes.push(
        `NOTE: 角色线「${name}」可能滞后——当前阶段计划「${planned}」的区间终点已过（截至第${last}章仍未推进）。`,
      );
    }
  }
  for (const note of notes) io.stderr(note);
  return {
    book_title: state.book_title,
    last_committed_chapter: last,
    state_revision: state.state_revision,
    arc_lines: report,
  };
}

/* --------------------------------------------------------------------------
 * CLI entry point (argparse-compatible surface)
 * ------------------------------------------------------------------------ */

export interface TrackingRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function parseTrackingArgs(argv: string[]): { command: string; project: string | null; input: string | null } | string {
  let command: string | null = null;
  let project: string | null = null;
  let input: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--project') {
      if (i + 1 >= argv.length) return 'the following arguments are required: --project';
      project = argv[++i]!;
    } else if (token === '--input') {
      if (i + 1 >= argv.length) return 'the following arguments are required: --input';
      input = argv[++i]!;
    } else if (token.startsWith('--project=')) {
      project = token.slice('--project='.length);
    } else if (token.startsWith('--input=')) {
      input = token.slice('--input='.length);
    } else if (token.startsWith('-')) {
      return `unrecognized arguments: ${token}`;
    } else if (command === null) {
      command = token;
    } else {
      return `unrecognized arguments: ${token}`;
    }
  }
  if (command === null) return 'the following arguments are required: command';
  if (command !== 'init' && command !== 'commit' && command !== 'check' && command !== 'arc-audit') {
    return `invalid choice: '${command}' (choose from 'init', 'commit', 'check', 'arc-audit')`;
  }
  if (project === null) return 'the following arguments are required: --project';
  if ((command === 'init' || command === 'commit') && input === null) {
    return 'the following arguments are required: --input';
  }
  if ((command === 'check' || command === 'arc-audit') && input !== null) {
    return `unrecognized arguments: --input ${input}`;
  }
  return { command, project, input };
}

/**
 * CLI contract replica: `init|commit|check|arc-audit` + `--project <root>` +
 * `--input <path>`.  On success: init/commit/check print compact JSON
 * `{"last_committed_chapter":n,"state_revision":r}`; arc-audit prints the full
 * report JSON.  On TrackingError/OSError/UnicodeError: stderr `ERROR: <msg>`,
 * exit code 2.
 */
export async function runTrackingCommit(argv: string[], cwd: string): Promise<TrackingRunResult> {
  const parsed = parseTrackingArgs(argv);
  if (typeof parsed === 'string') {
    return { code: 2, stdout: '', stderr: `ERROR: ${parsed}\n` };
  }
  const { command, project: projectArg, input } = parsed;
  const project = path.resolve(cwd, projectArg!);
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const io: TrackingIo = {
    stderr(line: string): void {
      stderrBuf.push(line + '\n');
    },
  };
  const projectDir = path.resolve(cwd, project);
  let result: unknown;
  try {
    if (command === 'init') {
      result = initializeTracking(projectDir, readJson(path.resolve(cwd, input!)), io);
    } else if (command === 'commit') {
      result = applyTransaction(projectDir, readJson(path.resolve(cwd, input!)), io);
    } else if (command === 'arc-audit') {
      result = auditArcs(projectDir, io);
    } else {
      result = checkTracking(projectDir);
    }
  } catch (exc) {
    stderrBuf.push(`ERROR: ${errorMessage(exc)}\n`);
    return { code: 2, stdout: '', stderr: stderrBuf.join('') };
  }
  if (command === 'arc-audit') {
    stdoutBuf.push(JSON.stringify(result) + '\n');
  } else {
    const summary = result as { last_committed_chapter: number; state_revision: number };
    stdoutBuf.push(
      JSON.stringify({
        last_committed_chapter: summary.last_committed_chapter,
        state_revision: summary.state_revision,
      }) + '\n',
    );
  }
  return { code: 0, stdout: stdoutBuf.join(''), stderr: stderrBuf.join('') };
}

/** Python `load_state` — read & normalize the tracking authority (no side effects). */
export function loadTrackingState(bookDir: string): unknown {
  return loadState(bookDir);
}





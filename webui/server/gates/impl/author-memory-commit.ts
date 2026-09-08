// Author-memory single-authority transaction tool — Node ESM port.
//
// Faithful port of skills/*/scripts/author_memory_commit.py (all four skill
// copies are byte-identical; this mirrors the CLI skill exactly, zero Python
// dependency). It stores "作者记忆" (evidence-backed author preferences with
// scopes and allow/deny lifecycles) under <workspace>/.story/作者记忆/, applies
// transactional operations (remember/decide/replace/forget), renders the
// derived Markdown views, and writes the JSON state last as the commit point.
//
// CLI contract (exposed via runAuthorMemoryCommit): same subcommands and flags
// as the Python argparse CLI, compact sorted-key JSON on stdout, and on a
// protocol error a `{"ok": false, "error": <msg>}` JSON document on stderr with
// exit code 2. Library functions (loadMemoryState / applyMemoryTransaction /
// memoryStatePath plus every pure helper) let the engine and AI-edit drive the
// same transaction without a subprocess.
//
// JSON serialization is Python-compatible (sorted keys, ensure_ascii=False
// escaping, Python's default/compact/indent=2 separators) so transaction
// digests and state/view bytes are byte-identical to what the Python tool
// produces for the same input.
//
// Constraints honored: zero npm dependencies (node:fs / node:path /
// node:crypto / node:process only), no python, no child_process, no shell.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants (mirror the Python module-level constants)
// ---------------------------------------------------------------------------

export const INPUT_SCHEMA_VERSION = 1;
export const STATE_SCHEMA_VERSION = 1;
export const STATE_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
export const PROFILE_MAX_BYTES = 12288;
export const PENDING_MAX_BYTES = 12288;
export const JOURNAL_MAX_BYTES = 24576;
export const QUERY_MAX_BYTES = 2048;

export const KINDS = [
  'prose_style',
  'story_design',
  'workflow',
  'delivery',
  'interaction',
] as const;

export const KIND_TITLES: Record<string, string> = {
  prose_style: '文风与表达',
  story_design: '故事设计',
  workflow: '创作流程',
  delivery: '交付格式',
  interaction: '协作方式',
};

export const SCOPE_LEVELS = ['global', 'genre', 'book', 'workflow'] as const;
export const STATUSES = ['active', 'pending', 'conflict', 'rejected', 'superseded'] as const;
export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export const IMPORTANCE_LEVELS = ['low', 'medium', 'high'] as const;
export const SOURCES = [
  'explicit_user',
  'accepted_suggestion',
  'repeated_correction',
  'inferred_pattern',
  'manual',
] as const;
export const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthorMemoryScope {
  level: string;
  value: string | null;
}

export interface EvidenceEntry {
  quote: string;
  source_ref: string | null;
}

export interface AuthorMemoryItem {
  id: string;
  kind: string;
  scope: AuthorMemoryScope;
  assertion: string;
  confidence: string;
  importance: string;
  status: string;
  source: string;
  reason: string;
  conflicts_with: string[];
  confirmation_count: number;
  evidence: EvidenceEntry[];
  created_revision: number;
  updated_revision: number;
  superseded_by: string | null;
}

export interface AuthorMemoryJournalEntry {
  revision: number;
  transaction_id: string;
  committed_at: string;
  summaries: string[];
}

export interface AppliedTransactionRecord {
  revision: number;
  digest: string;
  item_ids: string[];
}

export interface AuthorMemoryState {
  schema_version: number;
  state_revision: number;
  next_item_number: number;
  items: Record<string, AuthorMemoryItem>;
  journal: AuthorMemoryJournalEntry[];
  applied_transactions: Record<string, AppliedTransactionRecord>;
}

export interface NormalizedPreference {
  kind: string;
  scope: AuthorMemoryScope;
  assertion: string;
  quote: string;
  source_ref: string | null;
  source: string;
  confidence: string;
  importance: string;
  status: string;
  reason: string;
  conflicts_with: string[];
}

export type NormalizedOperation =
  | { action: 'remember'; preference: NormalizedPreference }
  | { action: 'decide'; item_id: string; decision: 'activate' | 'reject'; quote: string; reason: string }
  | { action: 'replace'; old_ids: string[]; preference: NormalizedPreference }
  | { action: 'forget'; item_id: string; quote: string; reason: string };

export interface NormalizedTransaction {
  schema_version: number;
  transaction_id: string;
  expected_state_revision: number;
  operations: NormalizedOperation[];
}

export interface MemoryApplyResult {
  ok: true;
  command: 'commit';
  transaction_id: string;
  revision: number;
  replayed: boolean;
  item_ids: string[];
  summaries: string[];
  state: AuthorMemoryState;
}

// ---------------------------------------------------------------------------
// Error + helpers
// ---------------------------------------------------------------------------

export class AuthorMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorMemoryError';
  }
}

/** Python `require(condition, message)` equivalent: raise AuthorMemoryError. */
function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AuthorMemoryError(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asMapping(value: unknown, label: string): Record<string, unknown> {
  require(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `${label} must be a JSON object`,
  );
  return value as Record<string, unknown>;
}

function asList(value: unknown, label: string): unknown[] {
  require(Array.isArray(value), `${label} must be a JSON array`);
  return value;
}

function asInt(value: unknown, label: string, minimum = 0): number {
  require(typeof value === 'number' && Number.isInteger(value), `${label} must be an integer`);
  require(value >= minimum, `${label} must be >= ${minimum}`);
  return value;
}

function requireKnownKeys(
  mapping: Record<string, unknown>,
  allowed: ReadonlySet<string> | readonly string[],
  label: string,
): void {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  const unknown = Object.keys(mapping)
    .filter((key) => !allowedSet.has(key))
    .sort();
  require(unknown.length === 0, `${label} contains unsupported fields: ${unknown.join(', ')}`);
}

/**
 * Python str.split() whitespace approximation (str.isspace set). Note: unlike
 * JS `\s` it does NOT treat U+FEFF as whitespace and does include U+001C-001F.
 */
const PY_WHITESPACE = /[\u0009-\u000d\u001c-\u001f\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** Python `" ".join(value.split())` equivalent after `|` → full-width pipe. */
function cleanText(value: unknown, label: string, maxBytes = 768): string {
  require(typeof value === 'string', `${label} must be a string`);
  const withFullWidth = (value as string).replace(/\|/g, '｜');
  const cleaned = withFullWidth
    .split(PY_WHITESPACE)
    .filter((part) => part.length > 0)
    .join(' ');
  require(cleaned.length > 0, `${label} must not be empty`);
  require(Buffer.byteLength(cleaned, 'utf8') <= maxBytes, `${label} exceeds ${maxBytes} bytes`);
  return cleaned;
}

/** Python optional_text: None/undefined → None; otherwise clean_text. */
function optionalText(value: unknown, label: string, maxBytes = 768): string | null {
  if (value === null || value === undefined) return null;
  return cleanText(value, label, maxBytes);
}

function choice(value: unknown, allowed: readonly string[], label: string): string {
  require(
    typeof value === 'string' && (allowed as readonly string[]).includes(value),
    `${label} must be one of: ${(allowed as readonly string[]).join(', ')}`,
  );
  return value as string;
}

/** Python clean_id_list: validated author-memory ids, deduped, order kept. */
function cleanIdList(value: unknown, label: string, maximum = 32): string[] {
  const raw = asList(value, label);
  require(raw.length <= maximum, `${label} may contain at most ${maximum} items`);
  const result: string[] = [];
  for (let index = 0; index < raw.length; index++) {
    const itemId = cleanText(raw[index], `${label}[${index}]`, 32);
    // Python checks `item_id[2:].isdigit() and int(...) >= 1`; `\d` is ASCII [0-9].
    require(/^AP\d+$/.test(itemId) && Number(itemId.slice(2)) >= 1, `${label}[${index}] is not an author-memory id`);
    if (!result.includes(itemId)) result.push(itemId);
  }
  return result;
}

/** Python str.casefold approximation (only characters whose full case-folding
 *  differs from simple lowercasing; CJK text is unaffected). */
function strCasefold(input: string): string {
  let out = input.toLowerCase();
  // Full case-folding → lowercase differences (the realistic sub-set).
  out = out.replace(/\u00df/g, 'ss'); //  ß  -> ss
  out = out.replace(/\u03c2/g, '\u03c3'); // final sigma -> sigma
  out = out.replace(/\u0149/g, '\u02bc\u006e'); //  ŉ  -> ʼn
  return out;
}

// ---------------------------------------------------------------------------
// Python-compatible JSON serialization
//
// Three modes mirror json.dumps(ensure_ascii=False, sort_keys=True, ...):
//   'space'   -> default separators (", ", ": ")   [emit / query output]
//   'compact' -> separators (",", ":")              [digest / fingerprint]
//   'indent'  -> indent=2                           [state JSON file]
// ---------------------------------------------------------------------------

type JsonMode = 'space' | 'compact' | 'indent';

/** String encoding matching Python encode_basestring with ensure_ascii=False
 *  (result includes the surrounding double quotes). */
function encodeJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case '\\':
        out += '\\\\';
        continue;
      case '\b':
        out += '\\b';
        continue;
      case '\t':
        out += '\\t';
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\f':
        out += '\\f';
        continue;
      case '\r':
        out += '\\r';
        continue;
    }
    const code = value.charCodeAt(i);
    if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch; // non-ASCII passes through (ensure_ascii=False)
  }
  out += '"';
  return out;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value) && Object.is(value, -0)) return '0';
  return String(value);
}

function dumpValue(value: unknown, mode: JsonMode, level: number): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return encodeJsonString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (mode === 'indent') {
      const inner = '\n' + '  '.repeat(level + 1);
      const items = value.map((v) => dumpValue(v, mode, level + 1)).join(',' + inner);
      return '[' + inner + items + '\n' + '  '.repeat(level) + ']';
    }
    const itemSep = mode === 'compact' ? ',' : ', ';
    return '[' + value.map((v) => dumpValue(v, mode, level)).join(itemSep) + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    if (keys.length === 0) return '{}';
    if (mode === 'indent') {
      const inner = '\n' + '  '.repeat(level + 1);
      const items = keys
        .map((key) => encodeJsonString(key) + ': ' + dumpValue(obj[key], mode, level + 1))
        .join(',' + inner);
      return '{' + inner + items + '\n' + '  '.repeat(level) + '}';
    }
    const keySep = mode === 'compact' ? ':' : ': ';
    const itemSep = mode === 'compact' ? ',' : ', ';
    return (
      '{' +
      keys
        .map((key) => encodeJsonString(key) + keySep + dumpValue(obj[key], mode, level))
        .join(itemSep) +
      '}'
    );
  }
  throw new AuthorMemoryError('cannot serialize value to JSON');
}

/** Python-compatible JSON stringify (sorted keys, ensure_ascii=False). */
function pyDump(value: unknown, mode: JsonMode = 'space'): string {
  return dumpValue(value, mode, 0);
}

/** Python str.rstrip() (trailing whitespace per str.isspace). */
function pyRstrip(input: string): string {
  return input.replace(/[\u0009-\u000d\u001c-\u001f\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u, '');
}

// ---------------------------------------------------------------------------
// Normalizers (port of normalize_scope / normalize_evidence / normalize_item /
// validate_state / normalize_preference / normalize_transaction /
// normalize_record_event)
// ---------------------------------------------------------------------------

function normalizeScope(value: unknown, label: string): AuthorMemoryScope {
  const scope = asMapping(value, label);
  requireKnownKeys(scope, ['level', 'value'], label);
  const level = choice(scope.level, SCOPE_LEVELS, `${label}.level`);
  const rawValue = scope.value ?? null; // missing key ≡ null (Python .get)
  if (level === 'global') {
    require(rawValue === null, `${label}.value must be null for global scope`);
    return { level, value: null };
  }
  const normalizedValue = cleanText(rawValue, `${label}.value`, 180);
  return { level, value: normalizedValue };
}

function normalizeEvidence(value: unknown, label: string): EvidenceEntry {
  const evidence = asMapping(value, label);
  requireKnownKeys(evidence, ['quote', 'source_ref'], label);
  return {
    quote: cleanText(evidence.quote, `${label}.quote`, 768),
    source_ref: optionalText(evidence.source_ref, `${label}.source_ref`, 240),
  };
}

function normalizeItem(value: unknown, label: string): AuthorMemoryItem {
  const item = asMapping(value, label);
  requireKnownKeys(
    item,
    [
      'id', 'kind', 'scope', 'assertion', 'confidence', 'importance', 'status', 'source',
      'reason', 'conflicts_with', 'confirmation_count', 'evidence', 'created_revision',
      'updated_revision', 'superseded_by',
    ],
    label,
  );
  const itemId = cleanText(item.id, `${label}.id`, 32);
  require(/^AP\d+$/.test(itemId) && Number(itemId.slice(2)) >= 1, `${label}.id is invalid`);
  const rawEvidence = asList(item.evidence, `${label}.evidence`);
  const evidence = rawEvidence.map((entry, index) =>
    normalizeEvidence(entry, `${label}.evidence[${index}]`),
  );
  require(evidence.length > 0, `${label}.evidence must not be empty`);
  const status = choice(item.status, STATUSES, `${label}.status`);
  const conflicts = cleanIdList(item.conflicts_with, `${label}.conflicts_with`);
  const supersededBy = optionalText(item.superseded_by, `${label}.superseded_by`, 32);
  if (supersededBy !== null) {
    // Python: startswith("AP") and [2:].isdigit() (no >= 1 requirement here).
    require(/^AP\d+$/.test(supersededBy), `${label}.superseded_by is invalid`);
  }
  return {
    id: itemId,
    kind: choice(item.kind, KINDS, `${label}.kind`),
    scope: normalizeScope(item.scope, `${label}.scope`),
    assertion: cleanText(item.assertion, `${label}.assertion`, 768),
    confidence: choice(item.confidence, CONFIDENCE_LEVELS, `${label}.confidence`),
    importance: choice(item.importance, IMPORTANCE_LEVELS, `${label}.importance`),
    status,
    source: choice(item.source, SOURCES, `${label}.source`),
    reason: cleanText(item.reason, `${label}.reason`, 480),
    conflicts_with: conflicts,
    confirmation_count: asInt(item.confirmation_count, `${label}.confirmation_count`, 1),
    evidence,
    created_revision: asInt(item.created_revision, `${label}.created_revision`, 1),
    updated_revision: asInt(item.updated_revision, `${label}.updated_revision`, 1),
    superseded_by: supersededBy,
  };
}

/**
 * Full structural validation of a loaded state document; returns the
 * reconstructed state (items normalized, journal/applied_transactions deep
 * copied as validated). Python port of validate_state.
 */
export function validateState(value: unknown): AuthorMemoryState {
  const state = asMapping(value, 'state');
  requireKnownKeys(
    state,
    ['schema_version', 'state_revision', 'next_item_number', 'items', 'journal', 'applied_transactions'],
    'state',
  );
  require(state.schema_version === STATE_SCHEMA_VERSION, `state.schema_version must be ${STATE_SCHEMA_VERSION}`);
  const revision = asInt(state.state_revision, 'state.state_revision');
  const nextNumber = asInt(state.next_item_number, 'state.next_item_number', 1);
  const rawItems = asMapping(state.items, 'state.items');
  const items: Record<string, AuthorMemoryItem> = {};
  let maxNumber = 0;
  for (const rawId of Object.keys(rawItems)) {
    const normalized = normalizeItem(rawItems[rawId], `state.items.${rawId}`);
    require(rawId === normalized.id, `state.items key ${rawId} does not match item id`);
    maxNumber = Math.max(maxNumber, Number(rawId.slice(2)));
    require(
      normalized.created_revision <= normalized.updated_revision && normalized.updated_revision <= revision,
      `state.items.${rawId} revision is ahead of state`,
    );
    items[rawId] = normalized;
  }
  require(nextNumber > maxNumber, 'state.next_item_number must be greater than every allocated item id');
  for (const itemId of Object.keys(items)) {
    const item = items[itemId]!;
    for (const conflictId of item.conflicts_with) {
      require(
        items[conflictId] !== undefined && conflictId !== itemId,
        `state.items.${itemId} has an invalid conflict id`,
      );
    }
    if (item.superseded_by !== null) {
      require(
        items[item.superseded_by] !== undefined && item.superseded_by !== itemId,
        `state.items.${itemId} has an invalid superseded_by id`,
      );
    }
    if (item.status === 'active') require(item.conflicts_with.length === 0, `active item ${itemId} cannot retain conflicts`);
    if (item.status === 'pending') require(item.conflicts_with.length === 0, `pending item ${itemId} cannot retain conflicts`);
    if (item.status === 'conflict') {
      require(item.conflicts_with.length > 0, `conflict item ${itemId} must reference an active item`);
      require(
        item.conflicts_with.every((cid) => items[cid]?.status === 'active'),
        `conflict item ${itemId} must reference only active items`,
      );
    }
    if (item.status !== 'superseded') require(item.superseded_by === null, `only superseded item ${itemId} may set superseded_by`);
  }
  const rawJournal = asList(state.journal, 'state.journal');
  require(rawJournal.length === revision, 'state.journal length must equal state.state_revision');
  const journalRevisions: Record<string, number> = {};
  const journal: AuthorMemoryJournalEntry[] = [];
  for (let index = 0; index < rawJournal.length; index++) {
    const mapping = asMapping(rawJournal[index], `state.journal[${index}]`);
    requireKnownKeys(mapping, ['revision', 'transaction_id', 'committed_at', 'summaries'], `state.journal[${index}]`);
    const entryRevision = asInt(mapping.revision, `state.journal[${index}].revision`, 1);
    require(entryRevision === index + 1, `state.journal[${index}].revision must be ${index + 1}`);
    const transactionId = cleanText(mapping.transaction_id, `state.journal[${index}].transaction_id`, 128);
    require(journalRevisions[transactionId] === undefined, `state.journal repeats transaction_id ${transactionId}`);
    journalRevisions[transactionId] = entryRevision;
    cleanText(mapping.committed_at, `state.journal[${index}].committed_at`, 64);
    const rawSummaries = asList(mapping.summaries, `state.journal[${index}].summaries`);
    require(rawSummaries.length > 0, `state.journal[${index}].summaries must not be empty`);
    for (let si = 0; si < rawSummaries.length; si++) {
      cleanText(rawSummaries[si], `state.journal[${index}].summaries[${si}]`, 768);
    }
    journal.push(mapping as unknown as AuthorMemoryJournalEntry);
  }
  const rawTransactions = asMapping(state.applied_transactions, 'state.applied_transactions');
  const transactionKeys = Object.keys(rawTransactions);
  const journalKeys = Object.keys(journalRevisions);
  require(
    transactionKeys.length === journalKeys.length && transactionKeys.every((key) => key in journalRevisions),
    'state.applied_transactions must match state.journal transaction ids',
  );
  const appliedTransactions: Record<string, AppliedTransactionRecord> = {};
  for (const transactionId of transactionKeys) {
    cleanText(transactionId, 'state.applied_transactions key', 128);
    const mapping = asMapping(rawTransactions[transactionId], `state.applied_transactions.${transactionId}`);
    requireKnownKeys(mapping, ['revision', 'digest', 'item_ids'], `state.applied_transactions.${transactionId}`);
    const transactionRevision = asInt(mapping.revision, `state.applied_transactions.${transactionId}.revision`, 1);
    require(
      transactionRevision === journalRevisions[transactionId],
      `state.applied_transactions.${transactionId}.revision does not match journal`,
    );
    const recordDigest = cleanText(mapping.digest, `state.applied_transactions.${transactionId}.digest`, 64);
    require(
      /^[0-9a-f]{64}$/.test(recordDigest),
      `state.applied_transactions.${transactionId}.digest is invalid`,
    );
    const itemIds = cleanIdList(mapping.item_ids, `state.applied_transactions.${transactionId}.item_ids`);
    require(itemIds.length > 0, `state.applied_transactions.${transactionId}.item_ids must not be empty`);
    require(
      itemIds.every((id) => items[id] !== undefined),
      `state.applied_transactions.${transactionId}.item_ids references an unknown item`,
    );
    appliedTransactions[transactionId] = {
      revision: transactionRevision,
      digest: recordDigest,
      item_ids: itemIds,
    };
  }
  return {
    schema_version: STATE_SCHEMA_VERSION,
    state_revision: revision,
    next_item_number: nextNumber,
    items,
    journal: structuredClone(journal),
    applied_transactions: structuredClone(appliedTransactions),
  };
}

function normalizePreference(value: unknown, label: string, allowStatus: boolean): NormalizedPreference {
  const preference = asMapping(value, label);
  const allowed = [
    'kind', 'scope', 'assertion', 'quote', 'source_ref', 'source', 'confidence', 'importance', 'reason',
  ];
  if (allowStatus) {
    allowed.push('status', 'conflicts_with');
  }
  requireKnownKeys(preference, allowed, label);
  const source = choice(preference.source, SOURCES, `${label}.source`);
  const status = allowStatus
    ? choice(preference.status, ['active', 'pending', 'conflict'], `${label}.status`)
    : 'active';
  // Python uses .get("conflicts_with", []): a missing key defaults to [] but an
  // explicit null is rejected by clean_id_list -> require a missing key only.
  const conflicts = allowStatus
    ? cleanIdList('conflicts_with' in preference ? preference.conflicts_with : [], `${label}.conflicts_with`)
    : [];
  if (status === 'active') {
    require(conflicts.length === 0, `${label}.conflicts_with must be empty for active status`);
    require(
      source !== 'repeated_correction' && source !== 'inferred_pattern',
      `${label} inferred evidence must remain pending`,
    );
  } else if (status === 'conflict') {
    require(conflicts.length > 0, `${label}.conflicts_with is required for conflict status`);
  } else {
    require(conflicts.length === 0, `${label}.conflicts_with is only valid for conflict status`);
  }
  return {
    kind: choice(preference.kind, KINDS, `${label}.kind`),
    scope: normalizeScope(preference.scope, `${label}.scope`),
    assertion: cleanText(preference.assertion, `${label}.assertion`, 768),
    quote: cleanText(preference.quote, `${label}.quote`, 768),
    source_ref: optionalText(preference.source_ref, `${label}.source_ref`, 240),
    source,
    confidence: choice(preference.confidence, CONFIDENCE_LEVELS, `${label}.confidence`),
    importance: choice(preference.importance, IMPORTANCE_LEVELS, `${label}.importance`),
    status,
    reason: cleanText(preference.reason, `${label}.reason`, 480),
    conflicts_with: conflicts,
  };
}

export function normalizeTransaction(value: unknown): NormalizedTransaction {
  const transaction = asMapping(value, 'transaction');
  requireKnownKeys(transaction, ['schema_version', 'transaction_id', 'expected_state_revision', 'operations'], 'transaction');
  require(transaction.schema_version === INPUT_SCHEMA_VERSION, `transaction.schema_version must be ${INPUT_SCHEMA_VERSION}`);
  const transactionId = cleanText(transaction.transaction_id, 'transaction.transaction_id', 128);
  const operations = asList(transaction.operations, 'transaction.operations');
  require(operations.length >= 1 && operations.length <= 32, 'transaction.operations must contain 1-32 operations');
  const normalizedOperations: NormalizedOperation[] = [];
  for (let index = 0; index < operations.length; index++) {
    const label = `transaction.operations[${index}]`;
    const operation = asMapping(operations[index], label);
    const action = operation.action;
    if (action === 'remember') {
      requireKnownKeys(operation, ['action', 'preference'], label);
      normalizedOperations.push({
        action,
        preference: normalizePreference(operation.preference, `${label}.preference`, true),
      });
    } else if (action === 'decide') {
      requireKnownKeys(operation, ['action', 'item_id', 'decision', 'quote', 'reason'], label);
      normalizedOperations.push({
        action,
        item_id: cleanIdList([operation.item_id], `${label}.item_id`, 1)[0]!,
        decision: choice(operation.decision, ['activate', 'reject'], `${label}.decision`) as 'activate' | 'reject',
        quote: cleanText(operation.quote, `${label}.quote`, 768),
        reason: cleanText(operation.reason, `${label}.reason`, 480),
      });
    } else if (action === 'replace') {
      requireKnownKeys(operation, ['action', 'old_ids', 'preference'], label);
      const oldIds = cleanIdList(operation.old_ids, `${label}.old_ids`);
      require(oldIds.length > 0, `${label}.old_ids must not be empty`);
      normalizedOperations.push({
        action,
        old_ids: oldIds,
        preference: normalizePreference(operation.preference, `${label}.preference`, false),
      });
    } else if (action === 'forget') {
      requireKnownKeys(operation, ['action', 'item_id', 'quote', 'reason'], label);
      normalizedOperations.push({
        action,
        item_id: cleanIdList([operation.item_id], `${label}.item_id`, 1)[0]!,
        quote: cleanText(operation.quote, `${label}.quote`, 768),
        reason: cleanText(operation.reason, `${label}.reason`, 480),
      });
    } else {
      throw new AuthorMemoryError(`${label}.action must be one of: remember, decide, replace, forget`);
    }
  }
  return {
    schema_version: INPUT_SCHEMA_VERSION,
    transaction_id: transactionId,
    expected_state_revision: asInt(transaction.expected_state_revision, 'transaction.expected_state_revision'),
    operations: normalizedOperations,
  };
}

export interface RecordEvent {
  event_id: string;
  operation: NormalizedOperation;
}

export function normalizeRecordEvent(value: unknown): RecordEvent {
  const event = asMapping(value, 'event');
  requireKnownKeys(event, ['schema_version', 'event_id', 'operation'], 'event');
  require(event.schema_version === INPUT_SCHEMA_VERSION, `event.schema_version must be ${INPUT_SCHEMA_VERSION}`);
  const eventId = cleanText(event.event_id, 'event.event_id', 120);
  const normalized = normalizeTransaction({
    schema_version: INPUT_SCHEMA_VERSION,
    transaction_id: `record:${eventId}`,
    expected_state_revision: 0,
    operations: [event.operation],
  });
  return { event_id: eventId, operation: normalized.operations[0]! };
}

// ---------------------------------------------------------------------------
// Transaction-core pure functions (port of transaction_digest, fingerprint,
// allocate_item, best_level, add_evidence, require_item, apply_*)
// ---------------------------------------------------------------------------

export function transactionDigest(transaction: NormalizedTransaction): string {
  const canonical = pyDump(transaction, 'compact');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Python fingerprint: kind/scope/assertion with casefold-ed assertion. */
export function fingerprint(preference: {
  kind: string;
  scope: AuthorMemoryScope;
  assertion: string;
}): string {
  const value = {
    kind: preference.kind,
    scope: preference.scope,
    assertion: strCasefold(preference.assertion),
  };
  return pyDump(value, 'compact');
}

/** Allocate the next AP### id and build a fresh item from a preference. */
export function allocateItem(
  state: AuthorMemoryState,
  preference: NormalizedPreference,
  revision: number,
): AuthorMemoryItem {
  const itemId = `AP${String(state.next_item_number).padStart(3, '0')}`;
  state.next_item_number += 1;
  return {
    id: itemId,
    kind: preference.kind,
    scope: { ...preference.scope },
    assertion: preference.assertion,
    confidence: preference.confidence,
    importance: preference.importance,
    status: preference.status,
    source: preference.source,
    reason: preference.reason,
    conflicts_with: [...preference.conflicts_with],
    confirmation_count: 1,
    evidence: [{ quote: preference.quote, source_ref: preference.source_ref }],
    created_revision: revision,
    updated_revision: revision,
    superseded_by: null,
  };
}

export function bestLevel(first: string, second: string): string {
  return (RANK[first] ?? 0) >= (RANK[second] ?? 0) ? first : second;
}

/** Append evidence deduplicated by exact {quote, source_ref} equality. */
export function addEvidence(
  item: AuthorMemoryItem,
  quote: string,
  sourceRef: string | null,
): void {
  if (!item.evidence.some((e) => e.quote === quote && e.source_ref === sourceRef)) {
    item.evidence.push({ quote, source_ref: sourceRef });
  }
}

export function requireItem(
  state: AuthorMemoryState,
  itemId: string,
  label: string,
): AuthorMemoryItem {
  const item = state.items[itemId];
  require(item !== undefined, `${label} references unknown item ${itemId}`);
  return item as AuthorMemoryItem;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function applyRemember(
  state: AuthorMemoryState,
  preference: NormalizedPreference,
  revision: number,
): string {
  for (const conflictId of preference.conflicts_with) {
    const conflict = requireItem(state, conflictId, 'remember');
    require(conflict.status === 'active', `remember conflict ${conflictId} must be active`);
  }
  const preferenceFingerprint = fingerprint(preference);
  for (const item of Object.values(state.items)) {
    if (!['active', 'pending', 'conflict'].includes(item.status)) continue;
    if (fingerprint(item) !== preferenceFingerprint) continue;
    require(
      !(item.status === 'conflict' && preference.status === 'active'),
      `conflict item ${item.id} must be resolved with replace or rejected`,
    );
    require(
      !(item.status === 'active' && preference.status === 'conflict'),
      `active item ${item.id} cannot be recategorized as its own conflict`,
    );
    addEvidence(item, preference.quote, preference.source_ref);
    item.confirmation_count += 1;
    item.confidence = bestLevel(item.confidence, preference.confidence);
    item.importance = bestLevel(item.importance, preference.importance);
    item.updated_revision = revision;
    item.reason = preference.reason;
    if (item.status === 'pending' && preference.status === 'active') {
      item.status = 'active';
    } else if (item.status === 'pending' && preference.status === 'conflict') {
      item.status = 'conflict';
      item.conflicts_with = [...preference.conflicts_with];
    } else if (item.status === 'conflict' && preference.status === 'conflict') {
      item.conflicts_with = [...new Set([...item.conflicts_with, ...preference.conflicts_with])].sort();
    }
    return `强化 ${item.id}：${item.assertion}`;
  }
  const item = allocateItem(state, preference, revision);
  state.items[item.id] = item;
  return `新增 ${item.id}（${item.status}）：${item.assertion}`;
}

export function applyDecide(
  state: AuthorMemoryState,
  operation: Extract<NormalizedOperation, { action: 'decide' }>,
  revision: number,
): string {
  const item = requireItem(state, operation.item_id, 'decide');
  require(
    item.status === 'pending' || item.status === 'conflict',
    `decide requires pending/conflict item, got ${item.status}`,
  );
  let verb: string;
  if (operation.decision === 'activate') {
    require(
      item.status === 'pending' && item.conflicts_with.length === 0,
      'conflict candidates must be activated with replace',
    );
    item.status = 'active';
    verb = '确认';
  } else {
    item.status = 'rejected';
    verb = '拒绝';
  }
  addEvidence(item, operation.quote, null);
  item.reason = operation.reason;
  item.updated_revision = revision;
  return `${verb} ${item.id}：${item.assertion}`;
}

export function applyReplace(
  state: AuthorMemoryState,
  operation: Extract<NormalizedOperation, { action: 'replace' }>,
  revision: number,
): string {
  const oldItems = operation.old_ids.map((itemId) => requireItem(state, itemId, 'replace'));
  for (const item of oldItems) {
    require(
      ['active', 'conflict', 'pending'].includes(item.status),
      `replace target ${item.id} is already ${item.status}`,
    );
  }
  const replacement = allocateItem(state, operation.preference, revision);
  replacement.status = 'active';
  replacement.conflicts_with = [];
  state.items[replacement.id] = replacement;
  for (const item of oldItems) {
    item.status = 'superseded';
    item.superseded_by = replacement.id;
    item.updated_revision = revision;
  }
  const oldIds = new Set(oldItems.map((item) => item.id));
  let released = 0;
  for (const candidate of Object.values(state.items)) {
    if (candidate.status !== 'conflict') continue;
    const retained = candidate.conflicts_with.filter((id) => !oldIds.has(id));
    if (arraysEqual(retained, candidate.conflicts_with)) continue;
    candidate.conflicts_with = retained;
    candidate.updated_revision = revision;
    if (retained.length === 0) {
      candidate.status = 'pending';
      released += 1;
    }
  }
  const replaced = oldItems.map((item) => item.id).join(', ');
  const suffix = released ? `；${released} 个其他冲突候选退回待确认` : '';
  return `用 ${replacement.id} 替代 ${replaced}：${replacement.assertion}${suffix}`;
}

export function applyForget(
  state: AuthorMemoryState,
  operation: Extract<NormalizedOperation, { action: 'forget' }>,
  revision: number,
): string {
  const item = requireItem(state, operation.item_id, 'forget');
  require(
    ['active', 'pending', 'conflict'].includes(item.status),
    `forget target ${item.id} is already ${item.status}`,
  );
  item.status = 'superseded';
  item.superseded_by = null;
  item.reason = operation.reason;
  item.updated_revision = revision;
  addEvidence(item, operation.quote, null);
  let released = 0;
  for (const candidate of Object.values(state.items)) {
    if (candidate.status !== 'conflict' || !candidate.conflicts_with.includes(item.id)) continue;
    candidate.conflicts_with = candidate.conflicts_with.filter((id) => id !== item.id);
    candidate.updated_revision = revision;
    if (candidate.conflicts_with.length === 0) {
      candidate.status = 'pending';
      released += 1;
    }
  }
  const suffix = released ? `；${released} 个其他冲突候选退回待确认` : '';
  return `忘记 ${item.id}：${item.assertion}${suffix}`;
}

function utcNowSecondsIso(): string {
  // datetime.now(timezone.utc).replace(microsecond=0).isoformat() -> "+00:00"
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/**
 * Apply a validated transaction to a validated state. On an idempotent replay
 * of an already-applied transaction, returns the ORIGINAL state object (so
 * callers detect replay via identity) with the replay summary; otherwise a deep
 * copy with the new journal entry / applied_transactions record, re-validated.
 * Port of apply_transaction; returns [state, summaries].
 */
export function applyTransaction(
  state: AuthorMemoryState,
  transaction: NormalizedTransaction,
  digest: string,
): [AuthorMemoryState, string[]] {
  const applied = state.applied_transactions[transaction.transaction_id];
  if (applied !== undefined) {
    require(applied.digest === digest, 'transaction_id was already used with different content');
    return [state, [`事务已应用于修订 ${applied.revision}，本次为幂等重放`]];
  }
  require(
    transaction.expected_state_revision === state.state_revision,
    `stale state revision: expected ${transaction.expected_state_revision}, current ${state.state_revision}`,
  );
  const updated = structuredClone(state);
  const revision = updated.state_revision + 1;
  const summaries: string[] = [];
  for (const operation of transaction.operations) {
    if (operation.action === 'remember') {
      summaries.push(applyRemember(updated, operation.preference, revision));
    } else if (operation.action === 'decide') {
      summaries.push(applyDecide(updated, operation, revision));
    } else if (operation.action === 'replace') {
      summaries.push(applyReplace(updated, operation, revision));
    } else {
      summaries.push(applyForget(updated, operation, revision));
    }
  }
  updated.state_revision = revision;
  updated.journal.push({
    revision,
    transaction_id: transaction.transaction_id,
    committed_at: utcNowSecondsIso(),
    summaries,
  });
  const itemIds = Object.entries(updated.items)
    .filter(([, item]) => item.updated_revision === revision)
    .map(([id]) => id)
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  require(itemIds.length > 0, 'transaction did not update any author-memory item');
  updated.applied_transactions[transaction.transaction_id] = {
    revision,
    digest,
    item_ids: itemIds,
  };
  return [validateState(updated), summaries];
}

// ---------------------------------------------------------------------------
// Derived Markdown views (port of scope_label / render_profile /
// render_pending / render_journal / render_views)
// ---------------------------------------------------------------------------

function scopeLabel(scope: AuthorMemoryScope): string {
  if (scope.level === 'global') return '全局';
  const labels: Record<string, string> = { genre: '题材', book: '本书', workflow: '流程' };
  return `${labels[scope.level] ?? scope.level}：${scope.value ?? ''}`;
}

export function renderProfile(state: AuthorMemoryState): string {
  const lines = [
    '# 作者画像',
    '',
    '<!-- 由 author_memory_commit.py 生成，请勿手改；修改请提交事务。 -->',
    '',
    `> 状态修订：${state.state_revision}。仅列出已确认偏好；当前明确要求、本书设定与硬性门禁优先。`,
    '',
  ];
  const active = Object.values(state.items).filter((item) => item.status === 'active');
  for (const kind of KINDS) {
    lines.push(`## ${KIND_TITLES[kind]}`, '');
    const items = active
      .filter((item) => item.kind === kind)
      .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
    if (items.length === 0) {
      lines.push('- 暂无', '');
      continue;
    }
    for (const item of items) {
      lines.push(
        `- **${item.id}**〔${scopeLabel(item.scope)}｜${item.confidence}｜确认 ${item.confirmation_count} 次〕${item.assertion}`,
      );
    }
    lines.push('');
  }
  return pyRstrip(lines.join('\n')) + '\n';
}

export function renderPending(state: AuthorMemoryState): string {
  const lines = [
    '# 待确认的作者习惯',
    '',
    '<!-- 由 author_memory_commit.py 生成，请勿手改；修改请提交事务。 -->',
    '',
    `> 状态修订：${state.state_revision}。待确认项不参与创作约束，也不应打断当前任务。`,
    '',
  ];
  const items = Object.values(state.items)
    .filter((item) => item.status === 'pending' || item.status === 'conflict')
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  if (items.length === 0) lines.push('暂无待确认项。', '');
  for (const item of items) {
    lines.push(
      `## ${item.id} · ${item.status === 'conflict' ? '冲突' : '待确认'}`,
      '',
      `- 候选习惯：${item.assertion}`,
      `- 范围：${scopeLabel(item.scope)}`,
      `- 原话：\u201c${item.evidence[item.evidence.length - 1]!.quote}\u201d`,
      `- 依据：${item.reason}`,
      `- 置信度 / 重要度：${item.confidence} / ${item.importance}`,
    );
    if (item.conflicts_with.length > 0) lines.push(`- 冲突对象：${item.conflicts_with.join(', ')}`);
    lines.push('');
  }
  return pyRstrip(lines.join('\n')) + '\n';
}

export function renderJournal(state: AuthorMemoryState): string {
  const lines = [
    '# 作者记忆变更记录',
    '',
    '<!-- 由 author_memory_commit.py 生成，请勿手改；最近记录在前。 -->',
    '',
  ];
  if (state.journal.length === 0) lines.push('暂无变更。', '');
  // reversed(state.journal[-100:])
  for (const entry of [...state.journal].reverse().slice(0, 100)) {
    lines.push(`## r${entry.revision} · ${entry.committed_at}`, '', `- 事务：\`${entry.transaction_id}\``);
    for (const summary of entry.summaries) lines.push(`- ${summary}`);
    lines.push('');
  }
  return pyRstrip(lines.join('\n')) + '\n';
}

export function renderViews(state: AuthorMemoryState): Record<string, string> {
  const views: Record<string, string> = {
    '作者画像.md': renderProfile(state),
    '待确认.md': renderPending(state),
    '变更记录.md': renderJournal(state),
  };
  const limits: Record<string, number> = {
    '作者画像.md': PROFILE_MAX_BYTES,
    '待确认.md': PENDING_MAX_BYTES,
    '变更记录.md': JOURNAL_MAX_BYTES,
  };
  for (const name of Object.keys(views)) {
    const payload = views[name]!;
    require(
      Buffer.byteLength(payload, 'utf8') <= limits[name]!,
      `${name} exceeds ${limits[name]} bytes; consolidate old memory first`,
    );
  }
  return views;
}

// ---------------------------------------------------------------------------
// Storage / I/O (port of read_json / atomic_write_text / write_if_changed /
// memory_root / state_path / empty_state / write_snapshot)
// ---------------------------------------------------------------------------

export function memoryRoot(workspace: string): string {
  return join(resolve(workspace), '.story', '作者记忆');
}

export function statePath(workspace: string): string {
  return join(memoryRoot(workspace), '_author-memory-state.json');
}

/** Library: absolute path of the author-memory JSON state file. */
export function memoryStatePath(workspaceRoot: string): string {
  return statePath(workspaceRoot);
}

export function emptyState(): AuthorMemoryState {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    state_revision: 0,
    next_item_number: 1,
    items: {},
    journal: [],
    applied_transactions: {},
  };
}

function readJson(path: string): unknown {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (error) {
    throw new AuthorMemoryError(`unable to read JSON ${path}: ${errorMessage(error)}`);
  }
  require(st.size <= STATE_MAX_BYTES, `${path} exceeds ${STATE_MAX_BYTES} bytes`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new AuthorMemoryError(`unable to read JSON ${path}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AuthorMemoryError(`unable to read JSON ${path}: ${errorMessage(error)}`);
  }
}

/**
 * Atomic write: unique temp file in the same directory, write + fsync (best
 * effort), preserve the destination mode, then rename over the target.
 */
function atomicWriteText(path: string, payload: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    /* new file */
  }
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, payload, 'utf8');
    try {
      const fd = openSync(temporary, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* best-effort fsync (durability only; not observable) */
    }
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed */
    }
  }
}

function writeIfChanged(path: string, payload: string): void {
  try {
    if (readFileSync(path, 'utf8') === payload) return;
  } catch {
    /* missing file -> write */
  }
  atomicWriteText(path, payload);
}

function writeSnapshot(workspace: string, state: AuthorMemoryState): void {
  const root = memoryRoot(workspace);
  const views = renderViews(state);
  const statePayload = pyDump(state, 'indent') + '\n';
  require(
    Buffer.byteLength(statePayload, 'utf8') <= STATE_MAX_BYTES,
    `_author-memory-state.json exceeds ${STATE_MAX_BYTES} bytes`,
  );
  for (const name of Object.keys(views)) {
    writeIfChanged(join(root, name), views[name]!);
  }
  // State is the authority and therefore the last commit point.
  writeIfChanged(statePath(workspace), statePayload);
}

// ---------------------------------------------------------------------------
// Commands (port of command_init / command_commit / command_record /
// command_query / command_check)
// ---------------------------------------------------------------------------

export function commandInit(workspace: string): Record<string, unknown> {
  require(existsSync(workspace) && statSync(workspace).isDirectory(), `workspace does not exist: ${workspace}`);
  const path = statePath(workspace);
  const state = existsSync(path) ? validateState(readJson(path)) : emptyState();
  writeSnapshot(workspace, state);
  return {
    ok: true,
    command: 'init',
    revision: state.state_revision,
    root: memoryRoot(workspace),
  };
}

export function commandCommit(workspace: string, inputPath: string): Record<string, unknown> {
  require(existsSync(statePath(workspace)), 'author memory is not initialized; run init first');
  const state = validateState(readJson(statePath(workspace)));
  const transaction = normalizeTransaction(readJson(inputPath));
  const digest = transactionDigest(transaction);
  const [updated, summaries] = applyTransaction(state, transaction, digest);
  const replayed = updated === state;
  if (!replayed) {
    writeSnapshot(workspace, updated);
  } else {
    // Repair missing or stale views during an idempotent retry.
    writeSnapshot(workspace, state);
  }
  const record = updated.applied_transactions[transaction.transaction_id]!;
  return {
    ok: true,
    command: 'commit',
    revision: updated.state_revision,
    transaction_id: transaction.transaction_id,
    replayed,
    item_ids: [...record.item_ids],
    summaries,
  };
}

export function commandRecord(workspace: string, inputPath: string): Record<string, unknown> {
  require(existsSync(workspace) && statSync(workspace).isDirectory(), `workspace does not exist: ${workspace}`);
  const event = normalizeRecordEvent(readJson(inputPath));
  const path = statePath(workspace);
  const state = existsSync(path) ? validateState(readJson(path)) : emptyState();
  const transactionId = `record:${event.event_id}`;
  const applied = state.applied_transactions[transactionId];
  const expectedRevision = applied !== undefined ? applied.revision - 1 : state.state_revision;
  const transaction: NormalizedTransaction = {
    schema_version: INPUT_SCHEMA_VERSION,
    transaction_id: transactionId,
    expected_state_revision: expectedRevision,
    operations: [event.operation],
  };
  const digest = transactionDigest(transaction);
  const [updated, summaries] = applyTransaction(state, transaction, digest);
  const replayed = updated === state;
  writeSnapshot(workspace, updated);
  const record = updated.applied_transactions[transactionId]!;
  const itemIds = [...record.item_ids];
  const receipt = `Author Memory Receipt: r${record.revision} · ${itemIds.join(', ')}`;
  return {
    ok: true,
    command: 'record',
    revision: updated.state_revision,
    applied_revision: record.revision,
    event_id: event.event_id,
    replayed,
    item_ids: itemIds,
    receipt,
    summaries,
  };
}

function sameScopeValue(itemValue: string | null, requested: string | null): boolean {
  return (
    requested !== null &&
    itemValue !== null &&
    strCasefold(itemValue) === strCasefold(requested)
  );
}

export function commandQuery(
  workspace: string,
  kinds: string[] | null,
  book: string | null,
  genre: string | null,
  workflow: string | null,
): Record<string, unknown> {
  require(existsSync(workspace) && statSync(workspace).isDirectory(), `workspace does not exist: ${workspace}`);
  const path = statePath(workspace);
  if (!existsSync(path)) {
    return { ok: true, command: 'query', initialized: false, revision: 0, items: [], omitted: 0 };
  }
  const state = validateState(readJson(path));
  const requestedKinds = new Set(kinds ?? [...KINDS]);
  const requestedScopes: Record<string, string | null> = {
    book: optionalText(book, 'query.book', 180),
    genre: optionalText(genre, 'query.genre', 180),
    workflow: optionalText(workflow, 'query.workflow', 180),
  };
  const relevant = (item: AuthorMemoryItem): boolean => {
    if (item.status !== 'active' || !requestedKinds.has(item.kind)) return false;
    const level = item.scope.level;
    return level === 'global' || sameScopeValue(item.scope.value, requestedScopes[level] ?? null);
  };
  const scopeRank: Record<string, number> = { book: 0, genre: 1, workflow: 2, global: 3 };
  const candidates = Object.values(state.items).filter(relevant);
  candidates.sort((a, b) => {
    const byScope = (scopeRank[a.scope.level] ?? 0) - (scopeRank[b.scope.level] ?? 0);
    if (byScope !== 0) return byScope;
    // Python tuple sorts (-RANK[importance], -confirmation_count, id) ascending,
    // i.e. higher importance / confirmation count first.
    const byImportance = (RANK[b.importance] ?? 0) - (RANK[a.importance] ?? 0);
    if (byImportance !== 0) return byImportance;
    const byCount = b.confirmation_count - a.confirmation_count;
    if (byCount !== 0) return byCount;
    return Number(a.id.slice(2)) - Number(b.id.slice(2));
  });
  const result: Record<string, unknown> = {
    ok: true,
    command: 'query',
    initialized: true,
    revision: state.state_revision,
    items: [],
    omitted: candidates.length,
  };
  const items = result.items as { id: string; kind: string; scope: AuthorMemoryScope; assertion: string }[];
  for (const item of candidates) {
    items.push({ id: item.id, kind: item.kind, scope: item.scope, assertion: item.assertion });
    result.omitted = candidates.length - items.length;
    const payload = pyDump(result, 'space') + '\n';
    if (Buffer.byteLength(payload, 'utf8') > QUERY_MAX_BYTES) {
      items.pop();
      result.omitted = (result.omitted as number) + 1;
      break;
    }
  }
  const finalPayload = pyDump(result, 'space') + '\n';
  require(
    Buffer.byteLength(finalPayload, 'utf8') <= QUERY_MAX_BYTES,
    'query result exceeds its fixed byte budget',
  );
  return result;
}

export function commandCheck(workspace: string): Record<string, unknown> {
  const path = statePath(workspace);
  require(existsSync(path), 'author memory is not initialized');
  const state = validateState(readJson(path));
  const views = renderViews(state);
  const root = memoryRoot(workspace);
  for (const name of Object.keys(views)) {
    const viewPath = join(root, name);
    require(existsSync(viewPath), `missing derived view: ${viewPath}`);
    require(readFileSync(viewPath, 'utf8') === views[name], `derived view is stale or edited: ${viewPath}`);
  }
  const counts: Record<string, number> = {};
  for (const status of STATUSES) {
    counts[status] = Object.values(state.items).filter((item) => item.status === status).length;
  }
  return { ok: true, command: 'check', revision: state.state_revision, counts };
}

// ---------------------------------------------------------------------------
// Library API surface
// ---------------------------------------------------------------------------

/**
 * Load the validated author-memory state for a workspace root. Returns the
 * canonical empty state when the workspace is not initialized (matches the
 * `query`/`record` read path). Throws AuthorMemoryError on a protocol-invalid
 * or unreadable state. Pure read: does not create any file.
 */
export function loadMemoryState(workspaceRoot: string): AuthorMemoryState {
  const path = statePath(workspaceRoot);
  if (!existsSync(path)) return emptyState();
  return validateState(readJson(path));
}

/**
 * Full single-authority transaction commit for the engine / AI-edit: loads the
 * (initialized) state, normalizes+digests the transaction, applies it, writes
 * the snapshot (state last), and returns the updated state plus the allocated
 * item ids touched by this revision. Idempotent re-invocations return
 * `replayed: true`.
 */
export function applyMemoryTransaction(workspaceRoot: string, txDoc: unknown): MemoryApplyResult {
  const workspace = resolve(workspaceRoot);
  const path = statePath(workspace);
  require(existsSync(path), 'author memory is not initialized; run init first');
  const state = validateState(readJson(path));
  const transaction = normalizeTransaction(txDoc);
  const digest = transactionDigest(transaction);
  const [updated, summaries] = applyTransaction(state, transaction, digest);
  const replayed = updated === state;
  writeSnapshot(workspace, updated);
  const record = updated.applied_transactions[transaction.transaction_id]!;
  return {
    ok: true,
    command: 'commit',
    transaction_id: transaction.transaction_id,
    revision: updated.state_revision,
    replayed,
    item_ids: [...record.item_ids],
    summaries,
    state: updated,
  };
}

// ---------------------------------------------------------------------------
// CLI (port of build_parser / main)
// ---------------------------------------------------------------------------

const APP_NAME = 'author_memory_commit.py';

const USAGE = `usage: ${APP_NAME} [-h] {init,commit,record,query,check} ...`;

const HELP_TEXT = `${USAGE}

Maintain evidence-backed author preferences and deterministic Markdown views.

positional arguments:
  {init,commit,record,query,check}
                        init        initialize the author-memory workspace
                        check       verify state and derived views are in sync
                        commit      apply a transaction document
                        record      record a single-operation event (auto-init)
                        query       query active author preferences

options:
  -h, --help            show this help message and exit

per-command options:
  init/check : --workspace <dir> (required)
  commit     : --workspace <dir> (required), --input <file> (required)
  record     : --workspace <dir> (required), --input <file> (required)
  query      : --workspace <dir> (required), --kind <choice> (repeatable),
               --book <value>, --genre <value>, --workflow <value>
`;

export interface CliArgv {
  command: string;
  workspace: string;
  input: string;
  kinds: string[] | null;
  book: string | null;
  genre: string | null;
  workflow: string | null;
  help: boolean;
}

/** Minimal argparse-compatible parser for the author-memory CLI. */
export function parseCli(argv: string[]): CliArgv {
  const positional: string[] = [];
  const kinds: string[] = [];
  let workspace: string | null = null;
  let input: string | null = null;
  let book: string | null = null;
  let genre: string | null = null;
  let workflow: string | null = null;
  let help = false;
  const valueOpts = new Set(['--workspace', '--input', '--kind', '--book', '--genre', '--workflow']);

  const takeValue = (name: string, inline: string | null, index: number): { value: string; next: number } => {
    if (inline !== null) return { value: inline, next: index };
    const value = argv[index];
    if (value === undefined) throw new CliError(`argument ${name}: expected one argument`);
    return { value, next: index + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      let name = arg;
      let inline: string | null = null;
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        name = arg.slice(0, eq);
        inline = arg.slice(eq + 1);
      }
      if (!valueOpts.has(name)) throw new CliError(`unrecognized arguments: ${arg}`);
      if (name === '--kind') {
        const taken = takeValue('--kind', inline, i + 1);
        // for-loop applies i++ after continue, so land one before next.
        i = taken.next - 1;
        if (!(KINDS as readonly string[]).includes(taken.value)) {
          throw new CliError(`argument --kind: invalid choice: '${taken.value}' (choose from ${KINDS.join(', ')})`);
        }
        kinds.push(taken.value);
        continue;
      }
      const taken = takeValue(name, inline, i + 1);
      i = taken.next - 1;
      if (name === '--workspace') workspace = taken.value;
      else if (name === '--input') input = taken.value;
      else if (name === '--book') book = taken.value;
      else if (name === '--genre') genre = taken.value;
      else if (name === '--workflow') workflow = taken.value;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) throw new CliError(`unrecognized arguments: ${arg}`);
    positional.push(arg);
  }

  const commands = ['init', 'commit', 'record', 'query', 'check'] as const;
  if (positional.length === 0 && !help) {
    throw new CliError('the following arguments are required: command');
  }
  if (positional.length > 1) {
    throw new CliError(`unrecognized arguments: ${positional.slice(1).join(' ')}`);
  }
  const command = positional.length > 0 ? positional[0]! : '';
  if (command !== '' && !(commands as readonly string[]).includes(command)) {
    throw new CliError(`argument command: invalid choice: '${command}' (choose from ${commands.join(', ')})`);
  }
  // --help / -h short-circuits required-argument enforcement (argparse behavior).
  if (help) {
    return { command, workspace: workspace ?? '', input: input ?? '', kinds: kinds.length > 0 ? kinds : null, book, genre, workflow, help: true };
  }
  if (workspace === null) throw new CliError('the following arguments are required: --workspace');
  if ((command === 'commit' || command === 'record') && input === null) {
    throw new CliError('the following arguments are required: --input');
  }
  return {
    command,
    workspace,
    input: input ?? '',
    kinds: kinds.length > 0 ? kinds : null,
    book,
    genre,
    workflow,
    help,
  };
}

class CliError extends Error {}

export interface CliIo {
  /** arbitrary text to stdout (help text) */
  stdout(text: string): void;
  /** arbitrary text to stderr (usage / argparse-like errors) */
  stderr(text: string): void;
  /** JSON result document to stdout */
  ok(document: unknown): void;
  /** JSON error document to stderr */
  error(document: unknown): void;
}

/**
 * Run the author-memory CLI in-process. Returns the process exit code:
 * 0 on success (JSON result on stdout), 2 on protocol errors (JSON error on
 * stderr) or CLI usage errors (usage text on stderr). The `io` callbacks
 * receive the emitted output; use runAuthorMemoryCommit for buffered output.
 */
export function runCli(argv: string[], cwd: string, io: CliIo): number {
  let parsed: CliArgv;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${USAGE}\n${APP_NAME} error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (parsed.help) {
    io.stdout(HELP_TEXT);
    return 0;
  }
  const workspace = parsed.workspace ? resolve(cwd, parsed.workspace) : cwd;
  try {
    let result: unknown;
    switch (parsed.command) {
      case 'init':
        result = commandInit(workspace);
        break;
      case 'check':
        result = commandCheck(workspace);
        break;
      case 'commit':
        result = commandCommit(workspace, resolve(cwd, parsed.input));
        break;
      case 'record':
        result = commandRecord(workspace, resolve(cwd, parsed.input));
        break;
      case 'query':
        result = commandQuery(workspace, parsed.kinds, parsed.book, parsed.genre, parsed.workflow);
        break;
      default:
        throw new AuthorMemoryError('command must be one of: init, commit, record, query, check');
    }
    io.ok(result);
    return 0;
  } catch (error) {
    if (error instanceof AuthorMemoryError) {
      io.error({ ok: false, error: error.message });
      return 2;
    }
    throw error;
  }
}

/** CLI contract: same JSON stdout / JSON error stderr + exit code semantics. */
export async function runAuthorMemoryCommit(
  argv: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ok: (document) => {
      stdout += pyDump(document, 'space') + '\n';
    },
    error: (document) => {
      stderr += pyDump(document, 'space') + '\n';
    },
  };
  const code = runCli(argv, cwd, io);
  return { code, stdout, stderr };
}

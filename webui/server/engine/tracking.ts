// 追踪事务接入（skills/tracking-transaction 契约）：init 初始化 + 从章节产物提取事务 + 落 .story-txn/pending.json
//
// 为什么需要它（修复）：
//   原实现只会在 gate 里跑 tracking_commit check，且期望一个没人写的 .story/pending-tracking.json，
//   于是新书永远没有 追踪/_tracking-state.json、last_committed_chapter 永不推进、chapter 阶段必被阻塞。
//   这里按 skills 契约补齐：init（开书写完大纲后）+ 事务 JSON 落 .story-txn/pending.json + commit。
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initializeTracking, applyTransaction, checkTracking } from '../gates/impl/tracking-commit.ts';

export const TRACKING_REL = '追踪/_tracking-state.json';
/** skills 契约路径（临时事务 JSON，成功后删除，不入 追踪/） */
export const PENDING_TX_REL = '.story-txn/pending.json';
/** 旧版 WebUI 期望的路径，保留兼容 */
const LEGACY_PENDING_REL = '.story/pending-tracking.json';

export interface InitOptions {
  bookDir: string;
  bookTitle: string;
  /** 大纲里的卷名（缺省第一卷） */
  volume?: string;
  /** 长期约束（取自设定/题材定位等） */
  constraints?: string[];
}

export function trackingStatePath(bookDir: string): string {
  return join(bookDir, TRACKING_REL);
}

export function hasTrackingState(bookDir: string): boolean {
  return existsSync(trackingStatePath(bookDir));
}

/** 读取追踪状态（不存在返回 null） */
export function readTrackingState(bookDir: string): Record<string, any> | null {
  const p = trackingStatePath(bookDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 依据 skills 契约构造 init 文档（schema_version=1 输入 → 落盘 schema_version=4） */
export function buildInitDocument(opts: InitOptions): Record<string, unknown> {
  return {
    schema_version: 1,
    book_title: opts.bookTitle,
    last_chapter: 0,
    context: {
      position: {
        volume: opts.volume ?? '第一卷',
        volume_start_chapter: 1,
        story_time: '开篇',
        scene: '开篇',
      },
      long_term_constraints: (opts.constraints ?? []).slice(0, 6),
      active_character_names: [],
      continuity_risks: [],
      recent_chapters: [],
      next_chapter_commitments: [],
    },
    character_snapshots: {},
    foreshadow: [],
    timeline_events: [],
  };
}

/**
 * 初始化追踪状态（幂等：已存在直接返回 ok:true, initialized:false）。
 * fail-closed：init 文档非法时返回 ok:false 并带原因，由调用方决定是否阻塞阶段。
 */
export function ensureTrackingInitialized(opts: InitOptions): { ok: boolean; initialized: boolean; msg: string } {
  if (hasTrackingState(opts.bookDir)) {
    return { ok: true, initialized: false, msg: '追踪状态已存在' };
  }
  try {
    initializeTracking(opts.bookDir, buildInitDocument(opts));
    return { ok: true, initialized: true, msg: '已按契约初始化 追踪/_tracking-state.json' };
  } catch (e: any) {
    return { ok: false, initialized: false, msg: `追踪初始化失败：${e?.message ?? String(e)}` };
  }
}

/** 追踪状态摘要（供 UI 展示） */
export function trackingSummary(bookDir: string): {
  exists: boolean;
  last_committed_chapter: number;
  state_revision: number;
  characters: number;
  foreshadow: number;
  timeline: number;
} {
  const st = readTrackingState(bookDir);
  return {
    exists: !!st,
    last_committed_chapter: Number(st?.last_committed_chapter ?? 0),
    state_revision: Number(st?.state_revision ?? 0),
    characters: Object.keys(st?.characters ?? {}).length,
    foreshadow: Object.keys(st?.foreshadow ?? {}).length,
    timeline: Object.keys(st?.timeline ?? {}).length,
  };
}

/**
 * 从 Agent 产物中提取追踪事务 JSON。
 * 约定（写进 chapter 阶段提示词）：产物里带一个 ```json 代码块，内含
 * { "tracking_tx": { schema_version:1, mode:"append", chapter:N, ... } }
 * 或直接是事务对象本身。缺字段/解析失败返回 null（不猜测）。
 */
export function extractTrackingTx(text: string): Record<string, any> | null {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? '');
  for (const raw of blocks) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const candidate = parsed?.tracking_tx ?? parsed?.trackingTx ?? parsed;
    if (!candidate || typeof candidate !== 'object') continue;
    if (candidate.schema_version === undefined) continue;
    if (candidate.mode !== 'append' && candidate.mode !== 'revision') continue;
    if (!Number.isInteger(candidate.chapter)) continue;
    if (!candidate.delta || typeof candidate.delta !== 'object') continue;
    return candidate as Record<string, any>;
  }
  return null;
}

/**
 * 落盘待提交事务（skills 契约路径 + 旧路径兼容），返回写入的绝对路径。
 * 契约要求事务携带 expected_state_revision（乐观锁）。skills workflow-daily 的做法是
 * 「把最近一次 check 返回的 state_revision 写入事务」——引擎代为补齐（Agent 通常拿不到该值）；
 * 若 Agent 显式给了值则尊重原值，由 commit 自己判 stale 并 fail-closed。
 */
export function writePendingTx(bookDir: string, tx: unknown): string {
  const abs = join(bookDir, PENDING_TX_REL);
  mkdirSync(dirname(abs), { recursive: true });
  let payload: unknown = tx;
  if (tx && typeof tx === 'object' && !Array.isArray(tx)) {
    const o = { ...(tx as Record<string, unknown>) };
    if (!Number.isInteger(o.expected_state_revision)) {
      o.expected_state_revision = Number(readTrackingState(bookDir)?.state_revision ?? 0);
    }
    payload = o;
  }
  writeFileSync(abs, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return abs;
}

/** 读取待提交事务：优先 skills 契约路径，其次旧路径 */
export function readPendingTx(bookDir: string): string | undefined {
  for (const rel of [PENDING_TX_REL, LEGACY_PENDING_REL]) {
    const abs = join(bookDir, rel);
    if (existsSync(abs)) {
      try {
        return readFileSync(abs, 'utf8');
      } catch {
        /* 继续找下一个 */
      }
    }
  }
  return undefined;
}

export function clearPendingTx(bookDir: string): void {
  for (const rel of [PENDING_TX_REL, LEGACY_PENDING_REL]) {
    try {
      rmSync(join(bookDir, rel), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 提交一份事务（成功返回新状态摘要，失败抛错并保留 pending 文件） */
export function commitTrackingTx(bookDir: string, tx: unknown): { last_committed_chapter: number; state_revision: number } {
  const state = applyTransaction(bookDir, tx) as any;
  return {
    last_committed_chapter: Number(state?.last_committed_chapter ?? 0),
    state_revision: Number(state?.state_revision ?? 0),
  };
}

/** 校验追踪状态与派生视图一致（check 语义），返回 null 表示通过 */
export function checkTrackingState(bookDir: string): string | null {
  try {
    checkTracking(bookDir);
    return null;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

// Writing-material decomposition service: break another book's prose into modular
// material, archive it into the module library, and inject it into the current novel.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { listFilesRecursive, readText } from '../fs/index.ts';
import { importTeardownText, analyzeTeardown } from '../teardown/service.ts';
import { archiveModules, attachModules, safeJson } from '../modules/service.ts';

type Sqlite = InstanceType<typeof Database>;

export function sanitizeSourceTitle(t: string): string {
  return (t || '素材').replace(/[\\/:*?"<>|\r\n.]+/g, '').trim().slice(0, 40) || '素材';
}

/**
 * Read a source book's prose: novels -> 正文/*.md concatenated; teardown projects ->
 * 拆文库/<name>/原文/原文.txt.
 */
export function readSourceBookText(sourceDir: string, kind: string, name: string): string {
  if (kind === 'teardown') {
    const p = join(sourceDir, '拆文库', name, '原文', '原文.txt');
    if (existsSync(p)) return readFileSync(p, 'utf8');
    throw Object.assign(new Error('来源书未导入原文（缺 原文/原文.txt）'), { code: 'NOT_FOUND' });
  }
  const md = listFilesRecursive(sourceDir, '正文').filter((p) => p.endsWith('.md')).sort();
  if (md.length === 0) throw Object.assign(new Error('来源书 正文 目录无章节文件'), { code: 'NOT_FOUND' });
  return md.map((p) => readText(sourceDir, p).content).join('\n\n');
}

export interface DecomposeResult {
  title: string;
  source: string;
  chapters: number;
  units: Array<{ kind: string; title: string }>;
  files: string[];
  created: number;
  skipped: number;
  attached: number;
  impact: { glue: string; knowledge_blocks: number; tokens_est: number };
}

/**
 * One-shot flow: split chapters -> deterministic decomposition into units -> archive into
 * the module library -> attach to the current novel as writing material. Output lands in
 * <novelDir>/拆文库/<title>/ so the author can also browse it from the workspace tree.
 */
export function decomposeForNovel(
  db: Sqlite,
  novel: { id: string; dir: string; name: string },
  input: { title?: string; text?: string; sourceDir?: string; sourceKind?: string; sourceName?: string },
): DecomposeResult {
  const title = sanitizeSourceTitle(input.title || input.sourceName || '素材');
  let text = input.text && input.text.trim()
    ? input.text
    : input.sourceDir
      ? readSourceBookText(input.sourceDir, input.sourceKind ?? 'novel', input.sourceName ?? title)
      : '';
  if (!text.trim()) throw Object.assign(new Error('请粘贴来源书正文或选择来源书'), { code: 'INVALID_INPUT' });
  if (text.length > 2 * 1024 * 1024) throw Object.assign(new Error('来源文本超过 2MB，请拆分'), { code: 'INVALID_INPUT' });

  // 1) Write the decomposition folder inside the novel's own directory.
  const teardown = importTeardownText(novel.dir, title, text, title);
  // 2) Deterministic decomposition -> units + files.
  const analyzed = analyzeTeardown(novel.dir, title);
  // 3) Archive into the shared module library (dedup by title+source).
  const archived = archiveModules(db, analyzed.units, {
    sourceBook: title,
    batchTags: ['素材'],
    defaultUsableFor: [novel.name],
  });
  // 4) Inject into this novel's material set.
  const attached = attachModules(db, novel.id, archived.module_ids, 'material');

  return {
    title,
    source: '拆文库:' + title,
    chapters: teardown.chapters,
    units: analyzed.units.map((u) => ({ kind: u.kind, title: u.title })),
    files: analyzed.files,
    created: archived.created,
    skipped: archived.skipped,
    attached: attached.attached,
    impact: attached.impact,
  };
}

/** List the material modules already injected into a book (used_in_json contains the id). */
export function listNovelMaterial(db: Sqlite, bookId: string): { items: any[] } {
  const rows = db
    .prepare('SELECT * FROM modules WHERE deleted_at IS NULL AND used_in_json LIKE ? ORDER BY updated_at DESC')
    .all('%"book_id":"' + bookId + '"%');
  const items = rows.map((r: any) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    source: r.source,
    tags: safeJson(r.tags, []),
    usage_count: r.usage_count,
    used_in: safeJson(r.used_in_json, []),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
  return { items };
}
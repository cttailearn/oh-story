// 短篇「节数守恒」解析（skills/story-short-write §Phase2/§Phase3：正文节数必须等于小节大纲规划节数）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 解析 小节大纲.md 的规划节数。
 * 支持（按优先级）：
 *   1) 显式声明行：`- 总节数：12` / `总节数: 12` / `共 12 节`
 *   2) skills 契约的「每节 1 行」pipe 格式：一行含 ≥5 个 | 分隔（12 字段）
 *   3) 小节标题行：`### 第3节` / `###3.` / `## 第3节`
 * 解析不到返回 null（调用方必须 fail-closed，不得默认通过）。
 */
export function parsePlannedSections(text: string): number | null {
  const lines = String(text ?? '').split(/\r?\n/);
  const explicit = lines
    .map((l) => l.match(/总节数\s*[:：]?\s*(\d+)|共\s*(\d+)\s*节/))
    .find((m) => m);
  if (explicit) {
    const n = Number(explicit[1] ?? explicit[2]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const rows = lines.filter((l) => {
    const t = l.trim();
    if (!t || t.startsWith('#') || /^\|?[-:\s|]+\|?$/.test(t)) return false;
    return (t.match(/\|/g) ?? []).length >= 5;
  });
  if (rows.length > 0) return rows.length;
  const headings = lines.filter((l) => /^#{2,4}\s*(第\s*\d+\s*节|\d+[.、])/.test(l.trim()));
  if (headings.length > 0) return headings.length;
  return null;
}

/** 读取 {bookDir}/小节大纲.md 的规划节数；文件缺失返回 null */
export function plannedSectionsOf(bookDir: string): { count: number | null; reason?: string } {
  const abs = join(bookDir, '小节大纲.md');
  if (!existsSync(abs)) return { count: null, reason: '缺少 小节大纲.md' };
  let text = '';
  try {
    text = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  } catch (e: any) {
    return { count: null, reason: '小节大纲.md 读取失败：' + String(e?.message ?? e) };
  }
  const count = parsePlannedSections(text);
  return count === null ? { count: null, reason: '小节大纲.md 中未识别到节行/总节数声明' } : { count };
}

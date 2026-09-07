// 文件系统层：路径安全 + mtime 乐观锁 + 文件树（api-contract §3.3 / §3.2，data-model §2）
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join, isAbsolute, resolve, relative, sep, basename } from 'node:path';

export interface FileNode {
  name: string;
  path: string; // 相对 {root} 的路径（正斜杠）
  type: 'dir' | 'file';
  size?: number;
  mtime?: number; // ms epoch
  children?: FileNode[];
}

/** 单目录层级（不递归） */
export interface DirEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: number;
}

const MAX_DEPTH = 100;

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * 将相对路径解析到 root 之下，并严防路径穿越。
 * 返回绝对路径（Windows 原生分隔符）。越界抛 400 类错误。
 */
export function resolveSafe(root: string, rel: string): string {
  const normalized = rel.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error('INVALID_PATH');
  }
  const parts = normalized.split('/').filter((x) => x && x !== '.');
  for (const p of parts) {
    if (p === '..') {
      throw new Error('INVALID_PATH');
    }
  }
  const abs = parts.length === 0 ? resolve(root) : resolve(root, ...parts);
  if (!isAbsolute(root)) {
    throw new Error('INVALID_PATH');
  }
  const rootResolved = resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new Error('INVALID_PATH');
  }
  if (parts.length > MAX_DEPTH) {
    throw new Error('INVALID_PATH');
  }
  return abs;
}

export function assertInside(root: string, abs: string): void {
  const rootResolved = resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new Error('INVALID_PATH');
  }
}

/** 读取文本文件，返回内容 + mtime(ms)。文件不存在抛 NOT_FOUND。 */
export function readText(root: string, rel: string): { content: string; mtime: number } {
  const abs = resolveSafe(root, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    const err = new Error('文件不存在');
    (err as any).code = 'NOT_FOUND';
    throw err;
  }
  const st = statSync(abs);
  return { content: readFileSync(abs, 'utf8'), mtime: st.mtimeMs };
}

/**
 * 带 mtime 乐观锁的写入：调用方先 GET 拿到 mtime，PUT 时回传；
 * 实际 mtime 不同 → 抛 CONFLICT(409)。
 * 写入用「临时文件 + rename」保证原子性（对齐 normalize-punctuation 原子写语义）。
 */
export function writeTextLocked(
  root: string,
  rel: string,
  content: string,
  expectedMtime: number | null,
): { mtime: number } {
  const abs = resolveSafe(root, rel);
  const existing = existsSync(abs) ? statSync(abs) : null;
  if (existing && existing.isDirectory()) {
    throw Object.assign(new Error('路径为目录'), { code: 'INVALID_INPUT' });
  }
  if (expectedMtime != null) {
    if (!existing) {
      throw Object.assign(new Error('文件已被删除，请刷新'), { code: 'CONFLICT' });
    }
    const current = Math.round(existing.mtimeMs);
    const expected = Math.round(expectedMtime);
    if (Math.abs(current - expected) > 1) {
      throw Object.assign(
        new Error(`文件已被外部修改（mtime ${current} ≠ ${expected}），请刷新后重试`),
        { code: 'CONFLICT', detail: { current, expected } },
      );
    }
  }
  mkdirSync(dirnameSafe(abs), { recursive: true });
  const tmp = `${abs}.webui-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  // rename 原子替换
  if (existsSync(abs)) {
    // Windows 上 rename 不支持覆盖已有文件，先替换
    const bak = `${abs}.webui-bak-${process.pid}-${Date.now()}`;
    try {
      renameSync(abs, bak);
      try {
        renameSync(tmp, abs);
      } catch (e) {
        renameSync(bak, abs); // 回滚
        throw e;
      }
      unlinkSync(bak);
    } catch {
      // 回退：直接 move
      renameSync(tmp, abs);
    }
  } else {
    renameSync(tmp, abs);
  }
  const st = statSync(abs);
  return { mtime: st.mtimeMs };
}

function dirnameSafe(abs: string): string {
  const i = abs.lastIndexOf(sep);
  return i > 0 ? abs.slice(0, i) : abs;
}

/** 单层目录列表 */
export function listDir(root: string, rel: string): DirEntry[] {
  const abs = resolveSafe(root, rel);
  if (!existsSync(abs)) {
    throw Object.assign(new Error('目录不存在'), { code: 'NOT_FOUND' });
  }
  if (!statSync(abs).isDirectory()) {
    throw Object.assign(new Error('路径不是目录'), { code: 'INVALID_INPUT' });
  }
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.') && !d.name.endsWith('.webui-tmp') && !d.name.endsWith('.webui-bak'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    })
    .map((d) => {
      const p = join(abs, d.name);
      const st = statSync(p);
      const relPath = toPosix(relative(resolve(root), p));
      return {
        name: d.name,
        path: relPath,
        type: d.isDirectory() ? ('dir' as const) : ('file' as const),
        size: d.isDirectory() ? undefined : st.size,
        mtime: st.mtimeMs,
      };
    });
}

/** 递归文件树（M0 用于左树/树 API） */
export function readTree(root: string, rel = '', depth = 0): FileNode[] {
  if (depth > 32) return [];
  const abs = resolveSafe(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter(
      (d) =>
        !d.name.startsWith('.') &&
        d.name !== 'AGENTS.md' &&
        d.name !== '.story-deployed' &&
        !d.name.endsWith('.webui-tmp') &&
        !d.name.endsWith('.webui-bak'),
    )
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    })
    .map((d) => {
      const dirAbs = join(abs, d.name);
      const relPath = rel ? toPosix(`${rel}/${d.name}`) : toPosix(d.name);
      const st = statSync(dirAbs);
      if (d.isDirectory()) {
        return {
          name: d.name,
          path: relPath,
          type: 'dir' as const,
          children: readTree(root, relPath, depth + 1),
        };
      }
      return {
        name: d.name,
        path: relPath,
        type: 'file' as const,
        size: st.size,
        mtime: st.mtimeMs,
      };
    });
}

/** 仅文件路径列表（扁平，供搜索/索引） */
export function listFilesRecursive(root: string, rel = ''): string[] {
  const out: string[] = [];
  const walk = (r: string) => {
    const abs = resolveSafe(root, r);
    if (!existsSync(abs)) return;
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      const childRel = r ? toPosix(`${r}/${d.name}`) : toPosix(d.name);
      const childAbs = join(abs, d.name);
      if (d.isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk(rel);
  return out;
}

export function fileStat(root: string, rel: string): { size: number; mtime: number } {
  const abs = resolveSafe(root, rel);
  if (!existsSync(abs)) throw Object.assign(new Error('文件不存在'), { code: 'NOT_FOUND' });
  const st = statSync(abs);
  return { size: st.size, mtime: st.mtimeMs };
}

export { basename };

// 配置存储：webui-config.json（data-model §3）——密钥唯一明文落点，权限 0600/NTFS ACL
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface ChannelConfig {
  id: string;
  name: string;
  base_url: string;
  api_key?: string; // 唯一明文落点
  models: string[];
  image_models?: string[];
  enabled?: boolean;
}

export interface WebuiConfig {
  version: number;
  node_engine_min: string;
  access_token?: string;
  workspace: string;
  pipeline_ref: { id: string; version: number };
  channels: ChannelConfig[];
  model_routing: Record<string, { channel: string; model: string }>;
  budget: {
    stage_max_cents: number;
    daily_max_cents: number;
    chapter_max_tokens_out: number;
    context_max_tokens_in: number;
  };
  prefs: Record<string, unknown>;
}

const DEFAULT_CONFIG: WebuiConfig = {
  version: 1,
  node_engine_min: '22.19.0',
  workspace: '',
  pipeline_ref: { id: 'long', version: 1 },
  channels: [],
  model_routing: {},
  budget: {
    stage_max_cents: 200,
    daily_max_cents: 1000,
    chapter_max_tokens_out: 6000,
    context_max_tokens_in: 26000,
  },
  prefs: { deslop_level: 'medium', theme: 'day', confirm_required: true },
};

let cache: WebuiConfig | null = null;
let configPath = '';

export function initConfig(workspaceRoot: string, dir?: string): void {
  const dirPath = dir ?? join(workspaceRoot, '.webui');
  mkdirSync(dirPath, { recursive: true });
  configPath = join(dirPath, 'webui-config.json');
  const cfg = DEFAULT_CONFIG;
  cfg.workspace = workspaceRoot;
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<WebuiConfig>;
      cache = { ...DEFAULT_CONFIG, ...parsed, workspace: workspaceRoot };
      applyAcl(configPath);
      return;
    } catch {
      // 解析失败沿用默认
    }
  }
  cache = cfg;
  persist();
}

function applyAcl(p: string): void {
  try {
    // Windows 下 chmod 仅设置只读位；真正的 ACL 由用户/安装器处理（附注即可）
    if (process.platform !== 'win32' || typeof chmodSync === 'function') {
      chmodSync(p, 0o600);
    }
  } catch {
    /* ignore */
  }
}

export function getConfig(): WebuiConfig {
  if (!cache) throw new Error('config not initialized');
  return cache;
}

/** 掩码标记：GET /api/config 回显的密钥形如 sk-a****z，绝不能被当作真实密钥写回 */
export const MASK_MARK = '****';
export function isMaskedSecret(v: unknown): boolean {
  return typeof v === 'string' && v.includes(MASK_MARK);
}

/**
 * 合并前端提交的渠道列表（PUT /api/config 白名单字段）。
 *
 * 密钥语义（修复：前端把 GET 到的整份配置原样 PUT 回来，曾把掩码写进配置文件，真实密钥被抹掉）：
 *   - api_key 缺省 / 掩码值 → 保留既有密钥
 *   - api_key === ''        → 显式清空
 *   - 其它非空字符串         → 覆盖为新密钥
 */
export function mergeChannels(prev: ChannelConfig[], incoming: unknown[]): ChannelConfig[] {
  const prevKey = new Map(prev.map((c) => [c.id, c.api_key]));
  return incoming.map((raw) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const id = String(c.id ?? '');
    let api_key: string | undefined;
    if (typeof c.api_key === 'string') {
      const v = c.api_key.trim();
      if (v === '') api_key = undefined;
      else if (isMaskedSecret(v)) api_key = prevKey.get(id);
      else api_key = v;
    } else {
      api_key = prevKey.get(id);
    }
    return {
      id,
      name: String(c.name ?? ''),
      base_url: String(c.base_url ?? '').trim(),
      models: Array.isArray(c.models) ? (c.models as unknown[]).map(String) : [],
      image_models: Array.isArray(c.image_models) ? (c.image_models as unknown[]).map(String) : undefined,
      enabled: c.enabled !== false,
      api_key,
    };
  });
}

export function persist(): void {
  if (!cache) return;
  writeFileSync(configPath, JSON.stringify(cache, null, 2), 'utf8');
  applyAcl(configPath);
  // 备份一份可读的导入模板（可选）
}

export function updateConfig(mutator: (cfg: WebuiConfig) => WebuiConfig): WebuiConfig {
  if (!cache) throw new Error('config not initialized');
  cache = mutator(cache);
  persist();
  return cache;
}

export function configFilePath(): string {
  return configPath;
}

export function hasConfiguredChannel(): boolean {
  return !!cache && cache.channels.some((c) => c.enabled !== false && !!c.api_key);
}

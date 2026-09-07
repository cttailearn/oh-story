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

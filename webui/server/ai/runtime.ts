// pi-ai 运行时装配（agents-runtime §1）：渠道 = createProvider；真假渠道统一
import {
  createModels,
  createProvider,
  type MutableModels,
  type Provider,
} from '@earendil-works/pi-ai';
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type { Model, SimpleStreamOptions, Context, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { getConfig } from '../config/index.ts';
import type { ChannelConfig } from '../config/index.ts';

/** 单机多渠道密钥存储：读写 webui-config.json（api_key 唯一明文落点；认证异步兼容） */
class ConfigCredentialStore {
  async read(providerId: string) {
    const cfg = getConfig();
    const ch = cfg.channels.find((c) => c.id === providerId);
    if (!ch?.api_key) return undefined;
    return { type: 'api_key' as const, key: ch.api_key, env: {} };
  }
  async list() {
    const cfg = getConfig();
    return cfg.channels.map((c) => ({ providerId: c.id, type: 'api_key' as const }));
  }
  async modify(providerId: string, fn: (current: any) => Promise<any>) {
    const current = await this.read(providerId);
    const next = await fn(current);
    if (next === undefined) return current;
    const cfg = getConfig();
    const ch = cfg.channels.find((c) => c.id === providerId);
    if (ch) {
      ch.api_key = next.key;
    }
    return next;
  }
  async delete(providerId: string) {
    const cfg = getConfig();
    const ch = cfg.channels.find((c) => c.id === providerId);
    if (ch) delete ch.api_key;
  }
}

export class AiRuntime {
  private _models: MutableModels;
  private _byChannel = new Map<string, { llm?: Provider<any> }>();

  constructor() {
    this._models = createModels({ credentials: new ConfigCredentialStore() as any });
  }

  get modelsApi(): MutableModels {
    return this._models;
  }

  /** 重建渠道（配置热更新时调用）：全部清掉再按 config.channels 重建 */
  syncChannels(): void {
    this._models.clearProviders();
    this._byChannel.clear();
    const cfg = getConfig();
    for (const ch of cfg.channels) {
      if (ch.enabled === false) continue;
      this.setChannel(ch);
    }
  }

  setChannel(c: ChannelConfig): void {
    const provider = createProvider({
      id: c.id,
      name: c.name || c.id,
      baseUrl: c.base_url,
      headers: c.api_key ? { Authorization: `Bearer ${c.api_key}` } : undefined,
      auth: {
        apiKey: {
          name: `${c.name || c.id} API key`,
          resolve: async (input: { credential?: { key?: string } }) => {
            const key = input.credential?.key ?? c.api_key;
            return key
              ? {
                  auth: {
                    apiKey: key,
                    headers: { Authorization: `Bearer ${key}` },
                  },
                  source: `config:${c.id}`,
                }
              : undefined;
          },
        },
      } as any,
      models: (c.models || []).map((m) => ({
        id: m,
        name: m,
        api: 'openai-completions' as const,
        provider: c.id,
        baseUrl: c.base_url,
        reasoning: false,
        input: ['text'] as const,
        output: ['text'] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 32_768,
      })),
      api: {
        'openai-completions': {
          stream,
          streamSimple,
        },
      } as any,
    });
    this._models.setProvider(provider);
    this._byChannel.set(c.id, { llm: provider });
  }

  modelFor(channelId: string, modelId: string): Model<any> | undefined {
    return this._models.getModel(channelId, modelId);
  }

  streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
    return this._models.streamSimple(model as any, context, options as any);
  }

  hasAnyChannel(): boolean {
    return this._byChannel.size > 0;
  }

  channels(): string[] {
    return [...this._byChannel.keys()];
  }
}

/** 单项成本 = token * 单价（分/百万）折算；未填单价返回 0（零报价渠道不会意外烧钱） */
export function estimateCents(tokens: number, pricePerMtok = 0): number {
  if (!pricePerMtok) return 0;
  return (tokens / 1_000_000) * pricePerMtok;
}

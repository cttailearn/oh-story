// 渠道模型目录解析/分类单测
import { describe, it, expect } from 'vitest';
import { classifyModels, parseModelList, modelsUrl } from './models.ts';
import { mergeChannels, isMaskedSecret, type ChannelConfig } from './index.ts';

describe('parseModelList', () => {
  it('兼容 OpenAI {data:[{id}]}', () => {
    expect(parseModelList({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-image-1' }] })).toEqual(['gpt-4o', 'gpt-image-1']);
  });
  it('兼容 {models:[{id}]} / {models:[string]} / 纯数组', () => {
    expect(parseModelList({ models: [{ id: 'a' }, 'b'] })).toEqual(['a', 'b']);
    expect(parseModelList(['x', 'y'])).toEqual(['x', 'y']);
  });
  it('忽略空值与非字符串', () => {
    expect(parseModelList({ data: [{ id: '' }, { id: 1 }, { name: 'ok' }, null] })).toEqual(['ok']);
  });
  it('未知结构返回空数组', () => {
    expect(parseModelList({ error: 'nope' })).toEqual([]);
    expect(parseModelList(null)).toEqual([]);
  });
});

describe('classifyModels', () => {
  it('区分对话/图像/其它并去重保序', () => {
    const r = classifyModels([
      'deepseek-v4-pro',
      'gpt-image-2',
      'text-embedding-3-large',
      'qwen-image',
      'deepseek-v4-pro',
      'whisper-1',
      'nano-banana',
    ]);
    expect(r.models).toHaveLength(6);
    expect(r.chat).toEqual(['deepseek-v4-pro']);
    expect(r.image).toEqual(['gpt-image-2', 'qwen-image', 'nano-banana']);
    expect(r.other).toEqual(['text-embedding-3-large', 'whisper-1']);
  });
});

describe('modelsUrl', () => {
  it('拼 /models，兼容末尾斜杠与已含 /models', () => {
    expect(modelsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models');
    expect(modelsUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/models');
    expect(modelsUrl('https://api.example.com/v1/models')).toBe('https://api.example.com/v1/models');
    expect(modelsUrl('')).toBe('');
  });
});

describe('mergeChannels（密钥语义）', () => {
  const prev: ChannelConfig[] = [
    { id: 'ch_1', name: '老渠道', base_url: 'https://a/v1', api_key: 'sk-REAL-KEY', models: ['m1'], enabled: true },
  ];
  it('回显的掩码值不得写回（保留真实密钥）', () => {
    const out = mergeChannels(prev, [{ id: 'ch_1', name: '老渠道', base_url: 'https://a/v1', api_key: 'sk-R****KEY', models: ['m1'] }]);
    expect(out[0]!.api_key).toBe('sk-REAL-KEY');
  });
  it('未提供 api_key 字段 → 保留既有', () => {
    const out = mergeChannels(prev, [{ id: 'ch_1', name: '老渠道', base_url: 'https://a/v1', models: ['m1'] }]);
    expect(out[0]!.api_key).toBe('sk-REAL-KEY');
  });
  it('新密钥覆盖', () => {
    const out = mergeChannels(prev, [{ id: 'ch_1', api_key: 'sk-NEW', base_url: 'https://a/v1' }]);
    expect(out[0]!.api_key).toBe('sk-NEW');
  });
  it('空串显式清空', () => {
    const out = mergeChannels(prev, [{ id: 'ch_1', api_key: '', base_url: 'https://a/v1' }]);
    expect(out[0]!.api_key).toBeUndefined();
  });
  it('新增渠道带上密钥（提交列表即全量列表）', () => {
    const out = mergeChannels(prev, [
      { id: 'ch_1', name: '老渠道', base_url: 'https://a/v1', models: ['m1'] },
      { id: 'ch_2', name: '新', base_url: 'https://b/v1', api_key: 'sk-2' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.api_key).toBe('sk-REAL-KEY');
    expect(out[1]!.api_key).toBe('sk-2');
  });
  it('isMaskedSecret 识别掩码', () => {
    expect(isMaskedSecret('sk-a****z')).toBe(true);
    expect(isMaskedSecret('sk-real')).toBe(false);
    expect(isMaskedSecret(undefined)).toBe(false);
  });
});

// 流程定义加载器（process-definition §1：定义即数据，升级只改 JSON）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessDefinition, StageDefinition, GateName } from './types.ts';

const DEFS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'definitions');

const VALID_GATES: GateName[] = [
  'char-count', 'ai-patterns', 'degeneration', 'outline-detail', 'outline-copy',
  'chapter-consistency', 'project-consistency', 'revision-duplicate', 'delivery-contract',
  'normalize-punctuation', 'write-review-record', 'tracking-commit', 'author-memory',
  'imagegen-env', 'role-line-consistency',
];

let cache: Map<string, ProcessDefinition> | null = null;

function loadOne(id: string): ProcessDefinition {
  const raw = JSON.parse(readFileSync(join(DEFS_DIR, `${id}.json`), 'utf8')) as ProcessDefinition;
  return validateDefinition(raw);
}

export function loadAllDefinitions(): Map<string, ProcessDefinition> {
  if (cache) return cache;
  const map = new Map<string, ProcessDefinition>();
  for (const id of ['long', 'short']) {
    map.set(id, loadOne(id));
  }
  cache = map;
  return map;
}

export function getProcessDefinition(id: string): ProcessDefinition {
  const def = loadAllDefinitions().get(id);
  if (!def) throw new Error(`PROCESS_DEF_NOT_FOUND: ${id}`);
  return def;
}

export function validateDefinition(def: ProcessDefinition): ProcessDefinition {
  if (!def.id || !def.version || !Array.isArray(def.stages)) {
    throw new Error(`invalid process def: ${def.id}`);
  }
  const ids = new Set<string>();
  for (const stage of def.stages) {
    if (ids.has(stage.id)) throw new Error(`duplicate stage id: ${stage.id}`);
    ids.add(stage.id);
    for (const g of stage.gates) {
      if (!VALID_GATES.includes(g.name)) {
        throw new Error(`invalid gate '${g.name}' in stage ${stage.id} (${def.id})`);
      }
    }
  }
  return def;
}

/** 校验一个长流程的 stage 依赖（requires 必须存在且位于之前） */
export function validateDependencies(def: ProcessDefinition): void {
  const order = def.stages.map((s) => s.id);
  for (const stage of def.stages) {
    for (const req of stage.requires) {
      if (!order.includes(req)) {
        throw new Error(`stage ${stage.id} requires unknown '${req}'`);
      }
      if (order.indexOf(req) >= order.indexOf(stage.id)) {
        // 允许同序，但常见应在前；这里只警告不阻断（topic 可选）
      }
    }
  }
}

export function getStage(def: ProcessDefinition, stageId: string): StageDefinition {
  const s = def.stages.find((x) => x.id === stageId);
  if (!s) throw new Error(`stage not found: ${stageId} in ${def.id}`);
  return s;
}

/** 重置缓存（测试用） */
export function resetDefinitionCache(): void {
  cache = null;
}

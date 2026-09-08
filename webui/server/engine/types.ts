// 流程定义类型（process-definition §2 权威接口）
export type StageStatus = 'pending' | 'running' | 'review' | 'blocked' | 'done' | 'skipped';
export type ConfirmAction = 'approve' | 'edit_rerun' | 'reject_regen' | 'skip' | 'force_approve';
export type JobStatus = 'queued' | 'running' | 'review' | 'done' | 'error' | 'killed';

export interface ProcessDefinition {
  id: string; // 'long' | 'short'
  version: number;
  title: string;
  stages: StageDefinition[];
  defaults: {
    retry_limit: number;
    model_role?: string;
    confirm_required: boolean;
    max_tokens_in: number;
    max_tokens_out: number;
  };
}

export interface StageDefinition {
  id: string;
  title: string;
  type: 'single' | 'batch';
  requires: string[];
  entry: StageEntry;
  artifact: ArtifactSpec;
  gates: GateSpec[];
  confirm: ConfirmSpec;
  next?: string[];
  retry_policy?: { limit?: number; on: 'blocking' | 'error' | 'both' };
}

export interface StageEntry {
  assemble: string;
  templates: string[];
  knowledge_refs: string[];
  model_role: string;
  instructions?: string;
}

export interface ArtifactSpec {
  kind: 'file-set' | 'file' | 'record' | 'image-set';
  path: string;
  meta?: string;
  fields?: string[];
}

export type GateName =
  | 'char-count'
  | 'ai-patterns'
  | 'degeneration'
  | 'outline-detail'
  | 'outline-copy'
  | 'chapter-consistency'
  | 'project-consistency'
  | 'revision-duplicate'
  | 'delivery-contract'
  | 'normalize-punctuation'
  | 'write-review-record'
  | 'tracking-commit'
  | 'author-memory'
  | 'imagegen-env'
  | 'role-line-consistency';

export interface GateSpec {
  name: GateName;
  blocking?: boolean;
  args?: string[];
  on_commit?: boolean;
  min?: number;
  max?: number;
}

export interface ConfirmSpec {
  required: boolean;
  actions: ConfirmAction[];
  rerun_scope: 'this_stage' | 'subsequent';
}

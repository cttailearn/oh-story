// 客户端 API 封装（api-contract v0.1 —— M0 子集）
const BASE = '/api';

export interface Book {
  id: string;
  name: string;
  dir: string;
  kind: string;
  pipeline: string | null;
  theme_color: string | null;
  active_stage: string | null;
  created_at: string;
  updated_at: string;
}

export interface BookDetail extends Book {
  stages: Array<{
    stage_id: string;
    status: string;
    revision: number;
    started_at?: string | null;
    reviewed_at?: string | null;
    note?: string | null;
  }>;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: number;
  children?: FileNode[];
}

export interface GateFinding {
  rule: string;
  level: 'blocking' | 'warning';
  evidence: string;
  file?: string;
  line?: number;
}

export interface GateSummary {
  ok: boolean;
  blocking: GateFinding[];
  warnings: GateFinding[];
  value?: unknown;
  ran_ms: number;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    const err = new Error(body?.error?.message ?? `HTTP ${res.status}`);
    (err as any).status = res.status;
    (err as any).code = body?.error?.code;
    (err as any).detail = body?.error?.detail;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => http<any>('/health'),

  listBooks: () => http<{ items: Book[]; total: number }>('/books'),
  getBook: (id: string) => http<BookDetail>(`/books/${id}`),
  workspaceDirs: () => http<{ workspace: string; items: string[] }>('/workspace/dirs'),
  materialList: (bookId: string) => http<any>(`/books/${bookId}/material`),
  materialDecompose: (bookId: string, body: any) =>
    http<any>(`/books/${bookId}/material/decompose`, { method: 'POST', body: JSON.stringify(body) }),
  createBook: (body: { name: string; type?: string; theme_color?: string; dir?: string; pipeline?: string; requirements?: Record<string, unknown> }) =>
    http<Book>('/books', { method: 'POST', body: JSON.stringify(body) }),

  tree: (bookId: string, path = '') => http<{ tree: FileNode[] }>(`/books/${bookId}/tree?path=${encodeURIComponent(path)}`),

  readFile: (bookId: string, path: string) =>
    http<{ content: string; mtime: number }>(`/files?path=${encodeURIComponent(path)}&book_id=${bookId}`),
  writeFile: (bookId: string, path: string, content: string, mtime: number | null, token?: string) =>
    http<{ mtime: number; size: number }>('/files', {
      method: 'PUT',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: JSON.stringify({ path, content, mtime, book_id: bookId }),
    }),

  tracking: (bookId: string) => http<any>(`/books/${bookId}/tracking`),
  cost: (bookId: string) => http<any>(`/books/${bookId}/cost`),
  config: () => http<any>('/config'),
  putConfig: (cfg: any) => http<any>('/config', { method: 'PUT', body: JSON.stringify(cfg) }),
  testChannel: (id: string) =>
    http<any>(`/config/channels/${id}/test`, { method: 'POST', body: JSON.stringify({}) }),
  /** 保存前探测渠道可用模型：填了 base_url(+key) 即可拉 /models 目录 */
  probeChannelModels: (body: { base_url: string; api_key?: string; id?: string }) =>
    http<{
      ok: boolean;
      status?: number;
      ping_ms?: number;
      msg: string;
      models: string[];
      chat: string[];
      image: string[];
      other: string[];
    }>('/config/channels/probe', { method: 'POST', body: JSON.stringify(body) }),

  stages: (bookId: string) => http<any>(`/books/${bookId}/stages`),
  runStage: (bookId: string, stage: string, fake = false) =>
    http<any>(`/books/${bookId}/stages/${stage}/run`, {
      method: 'POST',
      body: JSON.stringify({ fake }),
    }),
  reviewStage: (bookId: string, stage: string, action: string, note?: string) =>
    http<any>(`/books/${bookId}/stages/${stage}/review`, {
      method: 'POST',
      body: JSON.stringify({ action, note }),
    }),
  rollbackStage: (bookId: string, stage: string) =>
    http<any>(`/books/${bookId}/stages/${stage}/rollback`, { method: 'POST' }),

  aiEdit: (bookId: string, body: any) =>
    http<any>(`/books/${bookId}/ai-edit`, { method: 'POST', body: JSON.stringify(body) }),

  runGates: (bookId: string, gates?: string[]) =>
    http<any>(`/books/${bookId}/gates/run`, {
      method: 'POST',
      body: JSON.stringify(gates ? { gates } : {}),
    }),
  gateRuns: (bookId: string) => http<{ items: any[] }>(`/books/${bookId}/gate-runs`),

  search: (q: string) => http<any>(`/search?q=${encodeURIComponent(q)}`),
  emotionCurve: (bookId: string) => http<any>(`/books/${bookId}/curves/emotion`),
  rhythmCurve: (bookId: string) => http<any>(`/books/${bookId}/curves/rhythm`),
  characters: (bookId: string) => http<{ items: any[] }>(`/books/${bookId}/characters`),
  characterArc: (bookId: string, name: string) => http<any>(`/books/${bookId}/characters/${encodeURIComponent(name)}/arc`),
  setCharacterArc: (bookId: string, name: string, body: any) =>
    http<any>(`/books/${bookId}/characters/${encodeURIComponent(name)}/arc`, { method: 'PUT', body: JSON.stringify(body) }),
  proposeArc: (bookId: string, name: string, body: any) =>
    http<any>(`/books/${bookId}/characters/${encodeURIComponent(name)}/arc/propose`, { method: 'POST', body: JSON.stringify(body) }),
  importNovel: (body: any) => http<any>('/import', { method: 'POST', body: JSON.stringify(body) }),
  importReviewStatus: (bookId: string) => http<any>(`/books/${bookId}/import-review/status`),
  applyImportReview: (bookId: string, body: any) =>
    http<any>(`/books/${bookId}/import-review/apply`, { method: 'POST', body: JSON.stringify(body) }),
  exportBook: (bookId: string, body: any) =>
    http<any>(`/books/${bookId}/export`, { method: 'POST', body: JSON.stringify(body) }),
  listModules: (q: string = '') => http<any>(`/modules?${q}`),
  archiveModules: (bookId: string, body: any) =>
    http<any>(`/books/${bookId}/modules/archive`, { method: 'POST', body: JSON.stringify(body) }),
  attachModules: (bookId: string, body: any) =>
    http<any>(`/books/${bookId}/modules/attach`, { method: 'POST', body: JSON.stringify(body) }),
  teardownImport: (bookId: string, body: any) =>
    http<any>(`/teardowns/${bookId}/import-text`, { method: 'POST', body: JSON.stringify(body) }),
  teardownAnalyze: (bookId: string) =>
    http<any>(`/teardowns/${bookId}/analyze`, { method: 'POST', body: JSON.stringify({}) }),
  jobs: () => http<{ items: any[] }>('/jobs'),
  audit: (q: string = '') => http<{ items: any[] }>('/audit?' + q),
  healthFull: () => http<any>('/health?depth=full'),
  stats: () => http<any>('/stats'),
  opsBackup: (mode = 'daily') => http<any>('/ops/backup', { method: 'POST', body: JSON.stringify({ mode }) }),
  opsMaintain: () => http<any>('/ops/maintain', { method: 'POST', body: JSON.stringify({}) }),
  opsBackups: () => http<any>('/ops/backups'),
  relinkBook: (bookId: string, dir: string) =>
    http<any>('/books/' + bookId + '/relink', { method: 'POST', body: JSON.stringify({ dir }) }),
  killJob: (jobId: string) => http<any>('/jobs/' + jobId + '/kill', { method: 'POST', body: JSON.stringify({}) }),
  auditCsvUrl: (q: string = '') => '/api/stats/audit.csv?' + q,
};

/** SSE 订阅：调用方自行关闭 */
export function sseJobs(bookId: string, onEvent: (name: string, data: any) => void): () => void {
  const es = new EventSource(`/api/books/${bookId}/jobs/events`);
  const EVENTS = ['job:start', 'job:progress', 'gate:batch', 'job:review', 'job:error', 'heartbeat'];
  for (const e of EVENTS) {
    es.addEventListener(e, (ev: MessageEvent) => {
      try {
        onEvent(e, JSON.parse(ev.data));
      } catch {
        onEvent(e, ev.data);
      }
    });
  }
  return () => es.close();
}
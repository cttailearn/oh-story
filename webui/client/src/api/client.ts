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
  createBook: (body: { name: string; type?: string; theme_color?: string; dir?: string }) =>
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

  jobs: () => http<{ items: any[] }>('/jobs'),
  audit: () => http<{ items: any[] }>('/audit'),
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

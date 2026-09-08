// SSE 事件桥（api-contract §4）：每个 book 一条订阅线，push 事件给所有订阅者
import type { FastifyReply } from 'fastify';

export type SseEventName =
  | 'job:start'
  | 'job:progress'
  | 'gate:batch'
  | 'job:review'
  | 'edit:diff'
  | 'module:archived'
  | 'module:attached'
  | 'job:error'
  | 'heartbeat';

export interface SseEvent {
  event: SseEventName;
  data: unknown;
}

/** 每本书一个订阅者集合；单进程单机足够 */
const subscriptions = new Map<string, Set<FastifyReply>>();

export function subscribe(bookId: string, reply: FastifyReply): () => void {
  let set = subscriptions.get(bookId);
  if (!set) {
    set = new Set();
    subscriptions.set(bookId, set);
  }
  set.add(reply);
  reply.raw.on('close', () => {
    set!.delete(reply);
    if (set!.size === 0) subscriptions.delete(bookId);
  });
  return () => {
    set!.delete(reply);
  };
}

export function publish(bookId: string, event: SseEvent | SseEvent[]): void {
  const set = subscriptions.get(bookId);
  if (!set || set.size === 0) return;
  const events = Array.isArray(event) ? event : [event];
  for (const rep of set) {
    for (const e of events) {
      const payload = `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
      try {
        rep.raw.write(payload);
      } catch {
        // 连接已断，忽略
      }
    }
  }
}

export function publishJob(bookId: string, jobId: string, name: SseEventName, data: Record<string, unknown>): void {
  publish(bookId, { event: name, data: { jobId, ...data } });
}

import type { CoreEvent } from '../core.js';
import { BackendError } from '../harness.js';
import type { RpcMessage, RpcRequest } from './worker-host.js';

export interface WorkerPort {
  postMessage(message: RpcRequest): void;
  addEventListener(type: 'message' | 'error', callback: (event: { data?: RpcMessage; message?: string }) => void): void;
  removeEventListener(type: 'message' | 'error', callback: (event: { data?: RpcMessage; message?: string }) => void): void;
  terminate(): void;
}
interface Pending {
  events: CoreEvent[]; done: boolean; error?: BackendError; wake?: () => void;
  resolve?: (value: unknown) => void; reject?: (error: Error) => void;
}

/** Public browser/headless client. No page, component or fetch override is required. */
export class WorkerClient {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  constructor(private readonly worker: WorkerPort) {
    worker.addEventListener('message', this.message); worker.addEventListener('error', this.error);
  }
  private readonly message = (event: { data?: RpcMessage }): void => {
    const message = event.data!, pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === 'result') { pending.resolve!(message.value); this.pending.delete(message.id); }
    else if (message.type === 'event') pending.events.push(message.event);
    else if (message.type === 'done') pending.done = true;
    else { pending.error = new BackendError(message.message, message.status); pending.done = true; pending.reject?.(pending.error); }
    pending.wake?.();
  };
  private readonly error = (event: { message?: string }): void => {
    this.closed = true;
    for (const pending of this.pending.values()) { pending.error = new BackendError(event.message ?? 'Backend Worker stopped'); pending.done = true; pending.reject?.(pending.error); pending.wake?.(); }
  };
  call(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new BackendError('Backend Worker is closed'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { events: [], done: false, resolve, reject });
      try { this.worker.postMessage({ id, action, payload }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async *stream(action: string, payload: Record<string, unknown> = {}): AsyncGenerator<CoreEvent> {
    if (this.closed) throw new BackendError('Backend Worker is closed');
    const id = crypto.randomUUID(), pending: Pending = { events: [], done: false };
    this.pending.set(id, pending);
    try {
      this.worker.postMessage({ id, action, payload });
      while (true) {
        if (pending.error) throw pending.error;
        if (pending.events.length) yield pending.events.shift()!;
        else if (pending.done) return;
        else await new Promise<void>(resolve => { pending.wake = resolve; });
      }
    } finally { this.pending.delete(id); if (!pending.done) this.worker.postMessage({ id, action: 'cancel', payload: {} }); }
  }
  close(): void {
    this.error({ message: 'Backend Worker closed' });
    this.worker.removeEventListener('message', this.message); this.worker.removeEventListener('error', this.error); this.worker.terminate();
    this.pending.clear();
  }
}

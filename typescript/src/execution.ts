import type { CoreEvent } from './core.js';

export type ExecutionStatus = 'running' | 'stopping' | 'completed' | 'cancelled' | 'timed-out' | 'policy-disabled' | 'error' | 'limit';
export type StopCause = 'cancelled' | 'timed-out' | 'policy-disabled' | 'limit';
export interface ExecutionSnapshot {
  id: string; agent_id: string; status: ExecutionStatus; timeout_ms: number; started_at: string; deadline_at: string;
  ended_at?: string; result: string; reason?: string; model_requests: number;
}
/** Injectable elapsed-time source; no OS, Worker, DOM, or transport dependency. */
export interface ExecutionClock {
  now(): number;
  set(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}
export const executionClock: ExecutionClock = {
  now: () => performance.now(),
  set: (callback, delay) => setTimeout(callback, delay),
  clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function positiveLimit(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 2_147_483_647) throw new Error(`${name} must be a positive integer no greater than 2147483647.`);
  return Number(value);
}

/** One backend-owned execution attempt. Observers never advance the driver. */
export class Execution {
  readonly snapshot: ExecutionSnapshot;
  readonly events: CoreEvent[] = [];
  deadline: number;
  done: Promise<void> = Promise.resolve();
  private readonly waiters = new Set<() => void>();
  private timer: unknown;
  private finished = false;
  private cause: StopCause | undefined;
  constructor(agentId: string, timeoutMs: number, private readonly cancelWork: () => void,
    private readonly publish: (event: CoreEvent) => void, private readonly clock: ExecutionClock = executionClock, start?: { monotonic: number; wall: number }) {
    positiveLimit(timeoutMs, 'timeoutMs');
    this.deadline = (start?.monotonic ?? clock.now()) + timeoutMs;
    const started = start?.wall ?? Date.now();
    this.snapshot = { id: crypto.randomUUID(), agent_id: agentId, status: 'running', timeout_ms: timeoutMs,
      started_at: new Date(started).toISOString(), deadline_at: new Date(started + timeoutMs).toISOString(), result: '', model_requests: 0 };
  }
  get stopped(): boolean { return this.cause !== undefined; }
  get isSettled(): boolean { return this.finished; }
  get remainingMs(): number { return Math.max(0, this.deadline - this.clock.now()); }
  emit(event: CoreEvent): void {
    const frame = structuredClone({ ...event, run_id: this.snapshot.id, agent_id: this.snapshot.agent_id, sequence: this.events.length });
    this.events.push(frame); this.publish(frame);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  /** Close admission synchronously; completion waits for every owned operation to drain. */
  stop(cause: StopCause): void {
    if (this.finished || this.cause || this.snapshot.ended_at) return;
    this.cause = cause; this.snapshot.status = 'stopping'; this.cancelWork();
    this.emit({ type: 'run_status', status: 'stopping', cause });
  }
  check(): void {
    if (this.remainingMs <= 0) this.stop('timed-out');
    if (this.stopped) throw new Error('Execution stopped.');
  }
  constrainTimeout(timeoutMs: number): void {
    positiveLimit(timeoutMs, 'timeoutMs');
    if (timeoutMs > this.snapshot.timeout_ms) throw new Error('A running deadline cannot be extended.');
    this.deadline -= this.snapshot.timeout_ms - timeoutMs;
    this.snapshot.timeout_ms = timeoutMs;
    this.snapshot.deadline_at = new Date(Date.parse(this.snapshot.started_at) + timeoutMs).toISOString();
    this.clock.clear(this.timer);
    this.timer = this.clock.set(() => this.stop('timed-out'), this.remainingMs);
    this.check();
  }
  start(work: () => Promise<void>, settle: () => Promise<void>, checkpoint?: () => Promise<void>): void {
    this.timer = this.clock.set(() => this.stop('timed-out'), this.remainingMs);
    this.done = (async () => {
      try { await work(); }
      catch (error) {
        if (!this.stopped) { this.snapshot.status = 'error'; this.snapshot.reason = String(error instanceof Error ? error.message : error); }
      }
      finally {
        this.clock.clear(this.timer);
        this.snapshot.status = this.cause ?? (this.snapshot.status === 'error' ? 'error' : 'completed');
        this.snapshot.ended_at = new Date().toISOString();
        try { await settle(); }
        catch (error) { this.snapshot.status = 'error'; this.snapshot.reason = `Checkpoint failed: ${String(error instanceof Error ? error.message : error)}`; }
        this.emit({ type: 'run_ended', run: structuredClone(this.snapshot) });
        try { await checkpoint?.(); }
        catch (error) { this.snapshot.status = 'error'; this.snapshot.reason = `Final checkpoint failed: ${String(error instanceof Error ? error.message : error)}`; this.emit({ type: 'run_checkpoint_error', run: structuredClone(this.snapshot) }); }
        this.finished = true;
        for (const wake of this.waiters) wake();
        this.waiters.clear();
      }
    })();
  }
  inspect(): ExecutionSnapshot { return structuredClone({ ...this.snapshot, ...(!this.finished && this.snapshot.ended_at ? { status: 'stopping' as const } : {}) }); }
  async *subscribe(after = -1, signal?: AbortSignal): AsyncGenerator<CoreEvent> {
    if (!Number.isInteger(after) || after < -1) throw new Error('after must be an integer at least -1.');
    let cursor = after + 1;
    while (!signal?.aborted) {
      if (cursor < this.events.length) yield structuredClone(this.events[cursor++]!);
      else if (this.finished) return;
      else {
        let wake!: () => void;
        const pending = new Promise<void>(resolve => { wake = resolve; this.waiters.add(wake); });
        signal?.addEventListener('abort', wake, { once: true });
        try { await pending; } finally { signal?.removeEventListener('abort', wake); this.waiters.delete(wake); }
      }
    }
  }
}

/** Shared by master requests, child requests, and compaction calls. */
export interface RequestBudget { used: number; max: number; }

import { BrowserWorkspace } from './workspace.js';
import type { GitPort } from '../git.js';
export type BridgeFetch = (input: string, init: RequestInit) => Promise<Response>;
import { BridgeError, type BridgeSnapshot } from '../bridge/protocol.js';

/** A private origin-paired connection. Tokens never appear in state or workspace data. */
export class BridgeClient {
  private token = '';
  private ended = false;
  private snapshot_: BridgeSnapshot | undefined;
  private readonly projects = new Map<string, BridgeSnapshot>();
  constructor(readonly endpoint: string, private readonly fetch_: BridgeFetch = fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new BridgeError('Use an HTTP loopback bridge URL such as http://127.0.0.1:5001');
  }
  get connected(): boolean { return !this.ended && !!this.token; }
  async pair(code: string, persistent = false): Promise<void> {
    const data = await this.request('pair', { code, persistent }); this.token = (data as { token: string }).token;
    this.snapshot_ = await this.call<BridgeSnapshot>('snapshot');
    this.projects.set(this.snapshot_.project.root, this.snapshot_);
  }
  snapshot(root?: string): BridgeSnapshot {
    if (this.ended || !this.snapshot_) throw new BridgeError('Bridge is disconnected; reconnect explicitly');
    if (root === undefined) return this.snapshot_;
    const snapshot = this.projects.get(root);
    if (!snapshot) throw new BridgeError('Select this native workspace explicitly before using its tools');
    return snapshot;
  }
  async selectProject(path: string): Promise<BridgeSnapshot> {
    const snapshot = await this.call<BridgeSnapshot>('selectProject', { path });
    this.projects.set(snapshot.project.root, snapshot); return snapshot;
  }
  private async request(route: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const fetch_ = this.fetch_;
    let response;
    const timeout = (body as { operation?: string }).operation === 'inspectTokens' ? 260_000 : 70_000;
    try { response = await fetch_(new URL('v1/' + route, this.endpoint).href, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.token }, body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) }); }
    catch { throw new BridgeError('Bridge request unavailable, timed out or cancelled. Check origin, browser local-network permission, and the bridge process.'); }
    if (!response.ok) throw new BridgeError('Bridge denied the request (' + response.status + '). Check pairing, local grants, or whether the file changed.');
    return ((await response.json()) as { value: unknown }).value;
  }
  async call<T = unknown>(operation: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (this.ended || !this.token) throw new BridgeError('Bridge is disconnected; reconnect explicitly');
    const id = crypto.randomUUID();
    const abort = () => { void this.request('call', { id: crypto.randomUUID(), operation: 'cancel', args: { id } }).catch(() => undefined); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new BridgeError('Bridge operation cancelled');
      return await this.request('call', { id, operation, args }, signal) as T;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async refresh(root?: string): Promise<BridgeSnapshot> {
    const snapshot = await this.call<BridgeSnapshot>('snapshot', root === undefined ? {} : { workspace: root });
    this.projects.set(snapshot.project.root, snapshot);
    if (root === undefined) this.snapshot_ = snapshot;
    return snapshot;
  }
  async heartbeat(): Promise<void> { await this.call('heartbeat'); }
  async close(): Promise<void> {
    if (!this.ended && this.token) { try { await this.call('release', {}, AbortSignal.timeout(1000)); } catch { /* Lease expiry is the fallback when the host is gone. */ } }
    this.ended = true; this.token = ''; this.snapshot_ = undefined; this.projects.clear();
  }
  git(signal?: AbortSignal, workspace?: string): GitPort {
    const call = <T>(operation: string, args: Record<string, unknown> = {}) => this.call<T>(operation, workspace === undefined ? args : { ...args, workspace }, signal);
    return {
      status: () => call('git_status'), diff: args => call('git_diff', args),
      log: args => call('git_log', args), branches: () => call('git_branches'),
      commit: (message, paths) => call('git_commit', { message, ...(paths ? { paths } : {}) }),
      createBranch: name => call('git_createBranch', { name }), checkout: name => call('git_checkout', { name }),
    };
  }
}

/** Metadata supports synchronous core queries; contents and effects always reach the bridge. */
export class BridgeWorkspace extends BrowserWorkspace {
  private readonly observed = new Map<string, string>();
  constructor(readonly bridge: BridgeClient, root?: string) { super(bridge.snapshot(root).project, async () => {}); }
  private call<T = unknown>(operation: string, args: Record<string, unknown>): Promise<T> { return this.bridge.call<T>(operation, { ...args, workspace: this.root }); }
  override exists(input: string): boolean { this.bridge.snapshot(this.root); return super.exists(input); }
  override isDirectory(input: string): boolean { this.bridge.snapshot(this.root); return super.isDirectory(input); }
  override async refresh(): Promise<void> { Object.assign(this.project, (await this.bridge.refresh(this.root)).project); }
  override async readText(input: string): Promise<string> {
    const path = this.relative(input), value = await this.call<string>('read', { path }); this.observed.set(path, value); return value;
  }
  override async writeText(input: string, content: string): Promise<void> {
    const path = this.relative(input);
    await this.call('write', { path, content, expected: this.observed.get(path) ?? null });
    this.observed.set(path, content); await this.refresh();
  }
  override async remove(input: string): Promise<void> {
    const path = this.relative(input);
    await this.call('remove', { path, expected: this.observed.get(path) ?? null }); this.observed.delete(path); await this.refresh();
  }
  override async move(from: string, to: string): Promise<void> {
    const path = this.relative(from);
    await this.call('move', { path, to: this.relative(to), expected: this.observed.get(path) ?? null }); this.observed.delete(path); await this.refresh();
  }
  override listFiles(path = '.'): Promise<string> { return this.call('list', { path: this.relative(path) }); }
  override readNumbered(path: string, start = 1, end = Number.MAX_SAFE_INTEGER): Promise<string> { return this.call('numbered', { path: this.relative(path), start, end }); }
  override findFiles(pattern: string): Promise<string> { return this.call('find', { pattern }); }
  override search(pattern: string, path = '.', glob = '*'): Promise<string> { return this.call('search', { pattern, path: this.relative(path), glob }); }
}

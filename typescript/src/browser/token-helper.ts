import { HELPER_INSPECTION_TIMEOUT_MS, HELPER_REQUEST_TIMEOUT_MS, HelperError, type HelperInfo } from '../helper-protocol.js';

export type HelperFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Connection to the tokenizer helper on this computer. Its session token stays in memory. */
export class TokenHelperClient {
  private token = '';
  private available = false;
  private info_: HelperInfo | undefined;
  constructor(readonly endpoint: string, private readonly fetch_: HelperFetch = fetch) {
    let url: URL | undefined;
    try { url = new URL(endpoint); } catch { /* reported below */ }
    if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new HelperError('Use a tokenizer helper address on this computer, such as http://127.0.0.1:5002');
  }
  get connected(): boolean { return this.available && !!this.token; }
  get info(): HelperInfo | undefined { return this.connected ? this.info_ : undefined; }
  async connect(): Promise<HelperInfo> {
    const { token, ...info } = await this.request('connect', {}, HELPER_REQUEST_TIMEOUT_MS) as { token: string } & HelperInfo;
    this.token = token; this.info_ = info;
    return info;
  }
  private async request(route: string, body: unknown, timeout: number, signal?: AbortSignal): Promise<unknown> {
    const fetch_ = this.fetch_;
    let response;
    try { response = await fetch_(new URL('v1/' + route, this.endpoint).href, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.token }, body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) }); }
    catch { this.available = false; throw new HelperError('Tokenizer helper unavailable, timed out or cancelled. Check that it is running and allows this website, and that the browser may reach this computer.', 400, timeout); }
    if (!response.ok) {
      // 401: the helper restarted and no longer knows this session. 403: it does not allow this website.
      if (response.status === 401 || response.status === 403) this.available = false;
      throw new HelperError('Tokenizer helper denied the request (' + response.status + ').' + (response.status === 403 ? ' Start it with this website allowed.' : ''));
    }
    this.available = true;
    return ((await response.json()) as { value: unknown }).value;
  }
  async call<T = unknown>(operation: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (!this.token) throw new HelperError('Tokenizer helper is disconnected; connect it again');
    const id = crypto.randomUUID();
    const abort = () => { void this.request('call', { id: crypto.randomUUID(), operation: 'cancel', args: { id } }, HELPER_REQUEST_TIMEOUT_MS).catch(() => undefined); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new HelperError('Tokenizer helper operation cancelled');
      return await this.request('call', { id, operation, args }, operation === 'inspectTokens' ? HELPER_INSPECTION_TIMEOUT_MS : HELPER_REQUEST_TIMEOUT_MS, signal) as T;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async close(): Promise<void> {
    if (this.token) { try { await this.call('release', {}, AbortSignal.timeout(1000)); } catch { /* The helper may already be gone. */ } }
    this.token = ''; this.available = false; this.info_ = undefined;
  }
}

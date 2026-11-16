import { HELPER_PROTOCOL, HELPER_REQUEST_TIMEOUT_MS, HelperError, type HelperInfo, type HelperTokens } from '../helper-protocol.js';

export type HelperFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Connection to the tokenizer helper on this computer. It holds no credential: the helper trusts this page's origin. */
export class TokenHelperClient {
  private available = false;
  private info_: HelperInfo | undefined;
  constructor(readonly endpoint: string, private readonly fetch_: HelperFetch = fetch) {
    let url: URL | undefined;
    try { url = new URL(endpoint); } catch { /* reported below */ }
    if (!url || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new HelperError('Use a tokenizer helper address on this computer, such as http://127.0.0.1:5002');
  }
  /** True after the helper answered the last request. */
  get connected(): boolean { return this.available && this.info_ !== undefined; }
  get info(): HelperInfo | undefined { return this.connected ? this.info_ : undefined; }
  async connect(): Promise<HelperInfo> {
    const info = await this.request('info', {}) as HelperInfo;
    if (!info || info.protocol !== HELPER_PROTOCOL || typeof info.ollamaUrl !== 'string' || !Array.isArray(info.models)) {
      this.available = false;
      throw new HelperError('This tokenizer helper is a different version from this page. Download the current helper and start it again.');
    }
    this.info_ = info;
    return info;
  }
  /** Splits `content` with the vocabulary of `model`, as found by the helper on its own computer. */
  async tokenize(model: string, content: string, signal?: AbortSignal): Promise<HelperTokens> {
    if (!this.info_) throw new HelperError('Tokenizer helper is disconnected; connect it again');
    const result = await this.request('tokenize', { model, content }, signal) as HelperTokens;
    if (!result || typeof result.identity !== 'string' || !Array.isArray(result.tokens)) throw new HelperError('Tokenizer helper returned no token pieces');
    return result;
  }
  private async request(route: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const fetch_ = this.fetch_, timeout = AbortSignal.timeout(HELPER_REQUEST_TIMEOUT_MS);
    let response;
    try { response = await fetch_(new URL('v1/' + route, this.endpoint).href, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
    catch { this.available = false; throw new HelperError('Tokenizer helper unavailable, timed out or cancelled. Check that it is running and allows this website, and that the browser may reach this computer.', 400, HELPER_REQUEST_TIMEOUT_MS); }
    if (!response.ok) {
      // 403: the helper does not serve this website. 422: it answered, but cannot tokenize for this model; it says why.
      if (response.status === 403) this.available = false; else this.available = true;
      let reason = '';
      if (response.status === 422) { try { reason = String(((await response.json()) as { error?: unknown }).error ?? ''); } catch { /* generic message below */ } }
      throw new HelperError(reason || 'Tokenizer helper denied the request (' + response.status + ').' + (response.status === 403 ? ' Start it with this website allowed.' : ''), response.status);
    }
    this.available = true;
    return ((await response.json()) as { value: unknown }).value;
  }
  close(): void { this.available = false; this.info_ = undefined; }
}

import { sseEvents } from '../sse.js';
import type { McpChannel } from './client.js';
import { HttpStatusError, META, headerValue, isObject, isRequest, isResponse, type RpcNotification, type RpcRequest, type RpcResponse } from './protocol.js';

export interface McpFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}
export type McpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<McpFetchResponse>;

const ACCEPT = 'application/json, text/event-stream';
const NAMED = ['tools/call', 'resources/read', 'prompts/get'];
function parse(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }

/** Reads JSON-RPC messages from an SSE body; returns the response to `id`. */
async function awaitResponse(response: McpFetchResponse, id: RpcRequest['id'], answer: (request: RpcRequest) => Promise<void>): Promise<RpcResponse> {
  for await (const event of sseEvents(response)) {
    const message = parse(event.data);
    if (isResponse(message) && message.id === id) return message;
    if (isRequest(message)) await answer(message);
  }
  throw new Error('the server closed the stream without a response');
}

/**
 * Streamable HTTP. Modern requests carry metadata headers and no session;
 * legacy (2025-03-26 to 2025-11-25) requests carry Mcp-Session-Id after initialize.
 */
export class StreamableHttpChannel implements McpChannel {
  readonly transport = 'http';
  onRequest?: (request: RpcRequest) => RpcResponse;
  private session: string | undefined;
  private legacyVersion = '';
  constructor(private readonly fetch_: McpFetch, private readonly url: string, private readonly headers: Record<string, string> = {}) {}

  negotiated(version: string): void { this.legacyVersion = version; }

  private headersFor(message: RpcRequest | RpcNotification | RpcResponse, extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...this.headers, accept: ACCEPT, 'content-type': 'application/json' };
    const params = 'params' in message && isObject(message.params) ? message.params : {};
    const meta = isObject(params._meta) ? params._meta : {};
    if (typeof meta[META.version] === 'string' && 'method' in message) {
      headers['MCP-Protocol-Version'] = meta[META.version] as string;
      headers['Mcp-Method'] = message.method;
      const name = params.name ?? params.uri;
      if (NAMED.includes(message.method) && typeof name === 'string') headers['Mcp-Name'] = headerValue(name);
      Object.assign(headers, extra);
    } else {
      if (this.legacyVersion >= '2025-06-18') headers['MCP-Protocol-Version'] = this.legacyVersion;
      if (this.session) headers['Mcp-Session-Id'] = this.session;
    }
    return headers;
  }
  private post(message: RpcRequest | RpcNotification | RpcResponse, signal?: AbortSignal, extra?: Record<string, string>): Promise<McpFetchResponse> {
    const fetch_ = this.fetch_;
    return fetch_(this.url, { method: 'POST', headers: this.headersFor(message, extra), body: JSON.stringify(message), ...(signal ? { signal } : {}) });
  }

  async request(message: RpcRequest, options: { signal: AbortSignal; headers?: Record<string, string> }): Promise<RpcResponse> {
    if (message.method === 'initialize') { this.session = undefined; this.legacyVersion = ''; }
    const response = await this.post(message, options.signal, options.headers);
    if (!response.ok) {
      const text = await response.text(), body = parse(text);
      if (isResponse(body) && body.error) return body;
      throw new HttpStatusError(response.status, text);
    }
    if (message.method === 'initialize') this.session = response.headers.get('mcp-session-id') ?? undefined;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      return awaitResponse(response, message.id, async request => { await this.post(this.onRequest!(request)); });
    }
    const body = parse(await response.text());
    // 2025-03-26 allowed batched responses.
    const found = (Array.isArray(body) ? body : [body]).find(item => isResponse(item) && item.id === message.id);
    if (!found) throw new Error('the server returned no JSON-RPC response for this request');
    return found as RpcResponse;
  }
  async notify(message: RpcNotification): Promise<void> {
    const response = await this.post(message);
    if (!response.ok) throw new HttpStatusError(response.status, await response.text());
  }
  async close(): Promise<void> {
    if (!this.session) return;
    const fetch_ = this.fetch_, headers = this.headersFor({ jsonrpc: '2.0', method: 'close' });
    this.session = undefined;
    await fetch_(this.url, { method: 'DELETE', headers }).catch(() => undefined);
  }
}

/** The deprecated 2024-11-05 HTTP+SSE transport: GET opens the stream, POSTs go to its endpoint. */
export class LegacySseChannel implements McpChannel {
  readonly transport = 'sse';
  readonly legacyOnly = true;
  onRequest?: (request: RpcRequest) => RpcResponse;
  private readonly stream = new AbortController();
  private endpoint: Promise<string> | undefined;
  private readonly pending = new Map<RpcRequest['id'], { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>();
  constructor(private readonly fetch_: McpFetch, private readonly url: string, private readonly headers: Record<string, string> = {}) {}

  private open(): Promise<string> {
    return this.endpoint ??= new Promise<string>((resolve, reject) => {
      const fetch_ = this.fetch_;
      void (async () => {
        try {
          const response = await fetch_(this.url, { method: 'GET', headers: { ...this.headers, accept: 'text/event-stream' }, signal: this.stream.signal });
          if (!response.ok) throw new HttpStatusError(response.status, await response.text());
          for await (const event of sseEvents(response)) {
            if (event.event === 'endpoint') {
              const target = new URL(event.data, this.url);
              if (target.origin !== new URL(this.url).origin) throw new Error('the SSE endpoint is on another origin');
              resolve(target.href); continue;
            }
            const message = parse(event.data);
            if (isResponse(message)) { this.pending.get(message.id!)?.resolve(message); this.pending.delete(message.id!); }
            else if (isRequest(message)) await this.post(this.onRequest!(message));
          }
          throw new Error('the SSE stream closed');
        } catch (error) {
          reject(error as Error);
          for (const waiter of this.pending.values()) waiter.reject(error as Error);
          this.pending.clear();
        }
      })();
    });
  }
  private async post(message: RpcRequest | RpcNotification | RpcResponse, signal?: AbortSignal): Promise<void> {
    const fetch_ = this.fetch_;
    const response = await fetch_(await this.open(), { method: 'POST', headers: { ...this.headers, 'content-type': 'application/json' }, body: JSON.stringify(message), ...(signal ? { signal } : {}) });
    if (!response.ok) throw new HttpStatusError(response.status, await response.text());
  }
  async request(message: RpcRequest, options: { signal: AbortSignal }): Promise<RpcResponse> {
    const answer = new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject });
      options.signal.addEventListener('abort', () => { this.pending.delete(message.id); reject(options.signal.reason as Error); }, { once: true });
    });
    answer.catch(() => undefined); // observed below; avoids an unhandled rejection if the POST fails first
    try { await this.post(message, options.signal); }
    catch (error) { this.pending.delete(message.id); throw error; }
    return answer;
  }
  async notify(message: RpcNotification): Promise<void> { await this.post(message); }
  async close(): Promise<void> { this.stream.abort(); }
}

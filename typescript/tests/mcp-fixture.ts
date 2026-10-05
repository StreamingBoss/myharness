import { fileURLToPath } from 'node:url';
import type { McpChannel } from '../src/mcp/client.js';
import type { McpFetch, McpFetchResponse } from '../src/mcp/http.js';
import { META, isObject, type JsonObject, type RpcNotification, type RpcRequest, type RpcResponse } from '../src/mcp/protocol.js';

/** The fixture as a stdio server script (see mcp-stdio-server.ts). */
export const STDIO_SERVER = fileURLToPath(new URL('./mcp-stdio-server.js', import.meta.url));

/** A scripted MCP server that can play every protocol era. Test-only. */
export interface FixtureOptions {
  era?: 'modern' | 'legacy' | 'dual';
  supported?: string[];
  legacyVersion?: string;
  /** How a legacy server answers a request that arrives before initialize. */
  probe?: 'error' | 'method' | 'silent';
  instructions?: string;
  capabilities?: JsonObject;
  tools?: JsonObject[];
  resources?: JsonObject[];
  templates?: JsonObject[] | 'error';
  prompts?: JsonObject[];
  pageSize?: number;
  call?: (name: string, args: JsonObject) => JsonObject | 'hang' | 'input';
  /** Legacy only: ask the client ping and an unsupported method before answering tools/call. */
  serverRequests?: boolean;
}
type Message = RpcRequest | RpcNotification | RpcResponse;
export type Ask = (request: RpcRequest) => Promise<RpcResponse>;

export const ECHO = { name: 'echo', title: 'Echo', description: 'Echo the text back', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } };
export const RESOURCE = { uri: 'memo://greeting', name: 'Greeting', mimeType: 'text/plain', description: 'A short greeting' };
export const PROMPT = { name: 'review', description: 'Review a topic', arguments: [{ name: 'topic', description: 'What to review', required: true }, { name: 'focus' }] };

export class FixtureServer {
  readonly log: Message[] = [];
  initialized = false;
  constructor(readonly options: FixtureOptions = {}) {}
  get era(): 'modern' | 'legacy' | 'dual' { return this.options.era ?? 'modern'; }
  capabilities(): JsonObject {
    return this.options.capabilities ?? { tools: {}, ...(this.options.resources ? { resources: {} } : {}), ...(this.options.prompts ? { prompts: {} } : {}) };
  }
  private page(items: JsonObject[], key: string, params: JsonObject): JsonObject {
    const size = this.options.pageSize ?? 100, start = Number(params.cursor ?? 0);
    return { [key]: items.slice(start, start + size), ...(start + size < items.length ? { nextCursor: String(start + size) } : {}), ttlMs: 0, cacheScope: 'private' };
  }

  /** Returns the response, or undefined for notifications and a silent server. */
  async handle(message: Message, ask: Ask = async () => { throw new Error('no client channel'); }): Promise<RpcResponse | undefined> {
    this.log.push(message);
    if (!('method' in message) || !('id' in message)) return undefined;
    const { id, method } = message, params = message.params ?? {};
    const ok = (result: JsonObject): RpcResponse => ({ jsonrpc: '2.0', id, result: this.era === 'legacy' ? result : { resultType: 'complete', ...result } });
    const fail = (code: number, text: string, data?: unknown): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message: text, ...(data ? { data } : {}) } });
    const meta = isObject(params._meta) ? params._meta : undefined, supported = this.options.supported ?? ['2026-07-28'];
    if (method === 'initialize') {
      if (this.era === 'modern') return fail(-32601, `initialize is not supported; this server speaks ${supported.join(', ')}`);
      this.initialized = true;
      return ok({ protocolVersion: this.options.legacyVersion ?? params.protocolVersion, capabilities: this.capabilities(), serverInfo: { name: 'fixture', version: '1' }, ...(this.options.instructions ? { instructions: this.options.instructions } : {}) });
    }
    const modern = meta !== undefined && this.era !== 'legacy';
    if (!modern && !this.initialized) {
      if (this.era === 'modern') return fail(-32022, 'Unsupported protocol version', { supported, requested: null });
      if (this.options.probe === 'silent') return undefined;
      return this.options.probe === 'method' ? fail(-32601, 'Method not found') : fail(-32000, 'Server not initialized');
    }
    if (modern && !supported.includes(String(meta[META.version]))) return fail(-32022, 'Unsupported protocol version', { supported, requested: meta[META.version] });
    switch (method) {
      case 'server/discover':
        return ok({ supportedVersions: supported, capabilities: this.capabilities(), _meta: { [META.serverInfo]: { name: 'fixture', version: '1' } }, ...(this.options.instructions ? { instructions: this.options.instructions } : {}), ttlMs: 0, cacheScope: 'private' });
      case 'tools/list': return ok(this.page(this.options.tools ?? [ECHO], 'tools', params));
      case 'resources/list': return ok(this.page(this.options.resources ?? [], 'resources', params));
      case 'resources/templates/list':
        return this.options.templates === 'error' ? fail(-32601, 'Method not found') : ok(this.page(this.options.templates ?? [], 'resourceTemplates', params));
      case 'resources/read': {
        const resource = (this.options.resources ?? []).find(item => item.uri === params.uri);
        return resource ? ok({ contents: [{ uri: resource.uri, mimeType: 'text/plain', text: `contents of ${String(params.uri)}` }] }) : fail(-32602, `Resource not found: ${String(params.uri)}`);
      }
      case 'prompts/list': return ok(this.page(this.options.prompts ?? [], 'prompts', params));
      case 'prompts/get': {
        if (params.name === 'empty') return ok({});
        const args = isObject(params.arguments) ? params.arguments : {};
        return ok({ messages: [{ role: 'user', content: { type: 'text', text: `Please review ${String(args.topic)}${args.focus ? ` focusing on ${String(args.focus)}` : ''}.` } }, { role: 'assistant', content: { type: 'text', text: 'Sure.' } }] });
      }
      case 'tools/call': {
        if (this.options.serverRequests && this.era !== 'modern') {
          await ask({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' });
          await ask({ jsonrpc: '2.0', id: 'srv-sample', method: 'sampling/createMessage', params: {} });
        }
        const args = isObject(params.arguments) ? params.arguments : {};
        const result = this.options.call?.(String(params.name), args) ?? { content: [{ type: 'text', text: `echo: ${String(args.text)}` }] };
        if (result === 'hang') return new Promise(() => undefined);
        if (result === 'input') return ok({ resultType: 'input_required', inputRequests: { a: { method: 'elicitation/create', params: {} } } });
        return ok(result);
      }
      default: return fail(-32601, `Method not found: ${method}`);
    }
  }
}

/** In-memory channel for client tests: no network, process or timers. */
export class MemoryChannel implements McpChannel {
  onRequest?: (request: RpcRequest) => RpcResponse;
  readonly notified: RpcNotification[] = [];
  closed = false;
  legacyOnly?: boolean;
  constructor(readonly server: FixtureServer, readonly transport: 'stdio' | 'http' | 'sse' = 'stdio', private readonly broken?: Error) {}
  async request(message: RpcRequest, options: { signal: AbortSignal }): Promise<RpcResponse> {
    if (this.broken) throw this.broken;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (options.signal.aborted) reject(options.signal.reason as Error);
      options.signal.addEventListener('abort', () => reject(options.signal.reason as Error), { once: true });
    });
    const answer = this.server.handle(message, async request => { const reply = this.onRequest!(request); this.server.log.push(reply); return reply; }).then(response => response ?? new Promise<never>(() => undefined));
    return Promise.race([answer, aborted]);
  }
  async notify(message: RpcNotification): Promise<void> { this.notified.push(message); await this.server.handle(message); }
  async close(): Promise<void> { this.closed = true; }
}

export interface HttpCall { method: string; url: string; headers: Record<string, string>; body: unknown }
interface FetchOptions {
  /** Answer requests as an SSE stream (with a progress notification first). */
  sse?: boolean;
  /** How a legacy Streamable HTTP server rejects a modern request. */
  legacyReject?: 'plain' | 'jsonrpc' | '404' | 'empty';
  /** Serve the deprecated 2024-11-05 HTTP+SSE transport instead. */
  legacySse?: boolean;
  endpoint?: string;
  /** Fail every request with this status. */
  status?: number;
  /** Legacy sessions: answer 404 once the session has served this many requests. */
  expireAfter?: number;
  /** The GET stream for HTTP+SSE ends after the endpoint event. */
  closeStream?: boolean;
  /** Legacy server without sessions. */
  stateless?: boolean;
}

function text(status: number, body: string, headers: Record<string, string> = {}): McpFetchResponse { return new Response(body || null, { status, headers }) as unknown as McpFetchResponse; }
function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): McpFetchResponse { return text(status, JSON.stringify(value), { 'content-type': 'application/json', ...headers }); }
const sseFrame = (value: unknown, event = 'message'): string => `event: ${event}\ndata: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;

/** An injected fetch that serves the fixture over Streamable HTTP or HTTP+SSE. */
export function fixtureFetch(server: FixtureServer, options: FetchOptions = {}): McpFetch & { calls: HttpCall[] } {
  const calls: HttpCall[] = [], waiters = new Map<unknown, (response: RpcResponse) => void>();
  let session = 0, served = 0, stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const fetch_ = async (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<McpFetchResponse> => {
    const headers = Object.fromEntries(Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value]));
    const body: unknown = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, headers, body });
    if (init.signal?.aborted) throw init.signal.reason;
    if (options.status) return text(options.status, 'nope');
    const message = body as Message;
    if (options.legacySse) {
      if (init.method === 'GET') {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          stream = controller;
          controller.enqueue(encoder.encode(sseFrame(options.endpoint ?? '/messages?session=1', 'endpoint')));
          if (options.closeStream) controller.close();
          init.signal?.addEventListener('abort', () => { try { controller.error(init.signal!.reason); } catch { /* already closed */ } }, { once: true });
        } }), { headers: { 'content-type': 'text/event-stream' } }) as unknown as McpFetchResponse;
      }
      if (!url.includes('/messages')) return text(405, 'Method Not Allowed');
      if (!('method' in message)) { waiters.get(message.id)?.(message); return text(202, ''); }
      const push = (value: unknown) => { try { stream!.enqueue(encoder.encode(sseFrame(value))); } catch { /* the stream already closed */ } };
      void server.handle(message, request => new Promise(resolve => { waiters.set(request.id, resolve); push(request); }))
        .then(response => { if (response) push(response); });
      return text(202, '');
    }
    if (init.method === 'DELETE') return text(200, '');
    if (!('method' in message)) { waiters.get(message.id)?.(message); return text(202, ''); }
    if (!('id' in message)) { await server.handle(message); return text(202, ''); }
    const meta = isObject(message.params?._meta) ? message.params._meta : undefined;
    if (meta && server.era === 'legacy') {
      server.log.push(message);
      if (options.legacyReject === 'jsonrpc') return jsonResponse(400, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: Server not initialized' } });
      if (options.legacyReject === '404') return text(404, 'Not Found');
      return text(400, options.legacyReject === 'empty' ? '' : 'Bad Request: Server not initialized');
    }
    if (meta) {
      if (headers['mcp-protocol-version'] !== meta[META.version] || headers['mcp-method'] !== message.method) return jsonResponse(400, { jsonrpc: '2.0', id: message.id, error: { code: -32020, message: 'Header mismatch' } });
    } else if (message.method !== 'initialize' && !options.stateless) {
      if (headers['mcp-session-id'] !== `S${session}`) return text(400, 'missing session');
      if (options.expireAfter !== undefined && ++served > options.expireAfter) { served = 0; return text(404, 'session expired'); }
    }
    const extra: Record<string, string> = message.method === 'initialize' && server.era !== 'modern' && !options.stateless ? { 'mcp-session-id': `S${++session}` } : {};
    if (!options.sse) {
      const response = await server.handle(message);
      if (!response) return new Promise<never>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
      const status = response.error?.code === -32022 ? 400 : response.error?.code === -32601 && meta ? 404 : 200;
      // Exercise the 2025-03-26 batch form for one method.
      return jsonResponse(status, message.method === 'resources/list' && !meta ? [response] : response, extra);
    }
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      init.signal?.addEventListener('abort', () => { try { controller.error(init.signal!.reason); } catch { /* closed */ } }, { once: true });
      controller.enqueue(encoder.encode(': keep-alive\n\n' + sseFrame({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })));
      const response = await server.handle(message, request => new Promise(resolve => { waiters.set(request.id, resolve); controller.enqueue(encoder.encode(sseFrame(request))); }));
      if (response) { controller.enqueue(encoder.encode(sseFrame(response))); controller.close(); }
    } }), { headers: { 'content-type': 'text/event-stream', ...extra } }) as unknown as McpFetchResponse;
  };
  return Object.assign(fetch_, { calls });
}

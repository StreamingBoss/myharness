import { sliceCharacters } from '../format.js';
import { CLIENT_INFO, ERROR, HttpStatusError, LEGACY_VERSIONS, META, MODERN_VERSIONS, McpError, isModernError, isObject, requestMeta, type JsonObject, type RpcNotification, type RpcRequest, type RpcResponse } from './protocol.js';

/**
 * A transport. It delivers one request and returns its response; server-sent
 * requests (legacy revisions only) go to `onRequest` and are answered by the client.
 */
export interface McpChannel {
  readonly transport: 'stdio' | 'http' | 'sse';
  /** True when the endpoint can only speak a handshake-based revision (HTTP+SSE). */
  readonly legacyOnly?: boolean;
  onRequest?: (request: RpcRequest) => RpcResponse;
  request(message: RpcRequest, options: { signal: AbortSignal; headers?: Record<string, string> }): Promise<RpcResponse>;
  notify(message: RpcNotification): Promise<void>;
  /** The legacy revision chosen by initialize, for transports that send it as a header. */
  negotiated?(version: string): void;
  close(): Promise<void>;
  stderr?(): string[];
}
export interface WireEntry { at: string; direction: 'sent' | 'received' | 'note'; text: string }
export interface Exchange { result: JsonObject; request: RpcRequest; response: RpcResponse }

const FALLBACK_STATUSES = [400, 404, 405];

/** Runs `work` with `signal` plus a deadline. The timer is cleared afterwards. */
export async function withDeadline<T>(signal: AbortSignal, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error(`no reply within ${ms} ms`)), ms);
  try { return await work(AbortSignal.any([signal, deadline.signal])); } finally { clearTimeout(timer); }
}
const shown = (value: unknown): string => sliceCharacters(typeof value === 'string' ? value : JSON.stringify(value), 2000);

/** Hand-written MCP client for every published revision: modern (stateless) and legacy (initialize). */
export class McpClient {
  era: 'modern' | 'legacy' | undefined;
  version = '';
  capabilities: JsonObject = {};
  serverInfo: JsonObject | undefined;
  instructions = '';
  readonly log: WireEntry[] = [];
  private nextId = 0;
  private preferredLegacy = LEGACY_VERSIONS[0]!;

  constructor(private channel: McpChannel, private readonly options: { fallback?: () => McpChannel; probeTimeoutMs?: number } = {}) {
    this.attach();
  }
  get transport(): McpChannel['transport'] { return this.channel.transport; }
  stderr(): string[] { return this.channel.stderr?.() ?? []; }

  private attach(): void {
    this.channel.onRequest = request => {
      this.note('received', request);
      const response: RpcResponse = request.method === 'ping'
        ? { jsonrpc: '2.0', id: request.id, result: {} }
        : { jsonrpc: '2.0', id: request.id, error: { code: ERROR.methodNotFound, message: `myharness does not support ${request.method}` } };
      this.note('sent', response);
      return response;
    };
  }
  private note(direction: WireEntry['direction'], value: unknown): void {
    this.log.push({ at: new Date().toISOString(), direction, text: shown(value) });
    if (this.log.length > 50) this.log.shift();
  }

  /** Detects the server's era, then records its version, capabilities and instructions. */
  async connect(signal: AbortSignal): Promise<void> {
    if (!this.channel.legacyOnly && await this.probe(signal)) return;
    try { await this.handshake(signal); }
    catch (error) {
      if (!(error instanceof HttpStatusError && FALLBACK_STATUSES.includes(error.status) && this.options.fallback)) throw error;
      this.note('note', `initialize failed with HTTP ${error.status}; trying the deprecated HTTP+SSE transport (2024-11-05)`);
      await this.channel.close();
      this.channel = this.options.fallback(); this.attach();
      await this.handshake(signal);
    }
  }

  /** server/discover probe. True for a modern server; false means fall back to initialize. */
  private async probe(signal: AbortSignal): Promise<boolean> {
    let version = MODERN_VERSIONS[0]!, retried = false;
    while (true) {
      // stdio has no status codes: a legacy server may never answer, so the probe has a deadline.
      const discover = (probe: AbortSignal) => this.send('server/discover', {}, probe, version);
      let response: RpcResponse;
      try { response = this.channel.transport === 'stdio' ? await withDeadline(signal, this.options.probeTimeoutMs ?? 5000, discover) : await discover(signal); }
      catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof HttpStatusError && !FALLBACK_STATUSES.includes(error.status)) throw error;
        this.note('note', 'server/discover failed without a modern error: legacy server');
        return false;
      }
      if (response.error) {
        if (!isModernError(response.error)) { this.note('note', 'server/discover returned a non-modern error: legacy server'); return false; }
        if (response.error.code !== ERROR.unsupportedVersion) throw new McpError(response.error);
        const supported = isObject(response.error.data) && Array.isArray(response.error.data.supported) ? response.error.data.supported as unknown[] : [];
        const modern = MODERN_VERSIONS.find(item => supported.includes(item));
        if (modern && !retried) { version = modern; retried = true; continue; }
        return this.legacyFrom(supported);
      }
      const result = response.result!, supported = Array.isArray(result.supportedVersions) ? result.supportedVersions as unknown[] : [version];
      if (!supported.includes(version)) return this.legacyFrom(supported);
      this.era = 'modern'; this.version = version;
      this.capabilities = isObject(result.capabilities) ? result.capabilities : {};
      const meta = isObject(result._meta) ? result._meta : {};
      this.serverInfo = isObject(meta[META.serverInfo]) ? meta[META.serverInfo] as JsonObject : undefined;
      this.instructions = typeof result.instructions === 'string' ? result.instructions : '';
      return true;
    }
  }
  private legacyFrom(supported: unknown[]): false {
    const legacy = LEGACY_VERSIONS.find(item => supported.includes(item));
    if (!legacy) throw new Error(`no mutually supported MCP version (server supports ${supported.map(String).join(', ') || 'none'})`);
    this.preferredLegacy = legacy;
    return false;
  }

  private async handshake(signal: AbortSignal): Promise<void> {
    const response = await this.send('initialize', { protocolVersion: this.preferredLegacy, capabilities: {}, clientInfo: CLIENT_INFO }, signal);
    if (response.error) throw new McpError(response.error);
    const result = response.result!, version = String(result.protocolVersion);
    if (!LEGACY_VERSIONS.includes(version)) throw new Error(`server chose unsupported MCP version '${version}'`);
    this.era = 'legacy'; this.version = version;
    this.capabilities = isObject(result.capabilities) ? result.capabilities : {};
    this.serverInfo = isObject(result.serverInfo) ? result.serverInfo : undefined;
    this.instructions = typeof result.instructions === 'string' ? result.instructions : '';
    this.channel.negotiated?.(version);
    const initialized: RpcNotification = { jsonrpc: '2.0', method: 'notifications/initialized' };
    this.note('sent', initialized);
    await this.channel.notify(initialized);
  }

  private async send(method: string, params: JsonObject, signal: AbortSignal, modern?: string, headers?: Record<string, string>): Promise<RpcResponse> {
    return (await this.exchange(method, params, signal, modern, headers)).response;
  }
  private async exchange(method: string, params: JsonObject, signal: AbortSignal, modern?: string, headers?: Record<string, string>): Promise<{ request: RpcRequest; response: RpcResponse }> {
    const message: RpcRequest = { jsonrpc: '2.0', id: ++this.nextId, method, params: modern ? { ...params, _meta: requestMeta(modern) } : params };
    this.note('sent', message);
    try {
      const response = await this.channel.request(message, { signal, ...(headers ? { headers } : {}) });
      this.note('received', response);
      return { request: message, response };
    } catch (error) {
      this.note('note', `${method} failed: ${(error as Error).message}`);
      // Modern Streamable HTTP cancels by closing the stream; every other combination uses a notification.
      if (signal.aborted && this.era && !(this.era === 'modern' && this.channel.transport === 'http')) {
        const cancelled: RpcNotification = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: message.id, reason: 'stopped by the user' } };
        this.note('sent', cancelled);
        await this.channel.notify(cancelled).catch(() => undefined);
      }
      throw error;
    }
  }

  /** A post-connection request. Errors and interim input requests become exceptions. */
  async request(method: string, params: JsonObject, signal: AbortSignal, headers?: Record<string, string>): Promise<Exchange> {
    if (!this.era) throw new Error('MCP server is not connected');
    const modern = this.era === 'modern' ? this.version : undefined;
    let exchange: { request: RpcRequest; response: RpcResponse };
    try { exchange = await this.exchange(method, params, signal, modern, headers); }
    catch (error) {
      // Legacy Streamable HTTP: 404 on a session request means the session expired.
      if (!(this.era === 'legacy' && error instanceof HttpStatusError && error.status === 404 && this.channel.transport === 'http')) throw error;
      await this.handshake(signal);
      exchange = await this.exchange(method, params, signal, undefined, headers);
    }
    const { request, response } = exchange;
    if (response.error) throw new McpError(response.error);
    const result = response.result!;
    if (result.resultType === 'input_required') {
      const asked = isObject(result.inputRequests) ? Object.values(result.inputRequests).map(item => isObject(item) ? String(item.method) : 'input').join(', ') : 'input';
      throw new Error(`the server asked for ${asked}, which this harness does not provide`);
    }
    return { result, request, response };
  }

  /** Follows nextCursor pagination (at most 100 pages). */
  async list(method: string, key: string, signal: AbortSignal): Promise<JsonObject[]> {
    const items: JsonObject[] = [];
    let cursor: unknown;
    for (let page = 0; page < 100; page++) {
      const { result } = await this.request(method, cursor === undefined ? {} : { cursor }, signal);
      if (Array.isArray(result[key])) items.push(...(result[key] as unknown[]).filter(isObject));
      cursor = result.nextCursor;
      if (!cursor || typeof cursor !== 'string') break;
    }
    return items;
  }

  async close(): Promise<void> { await this.channel.close(); }
}

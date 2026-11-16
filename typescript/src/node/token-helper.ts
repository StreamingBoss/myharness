import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { ManagedTokenizer, TokenizerSetupError, type ManagedTokenizerOptions } from './managed-tokenizer.js';
import { OllamaAdapter, type FetchLike } from '../ollama.js';
import { tokenizerBindings, type TokenizerBinding, type PromptTokenizer } from '../llama-tokenizer.js';
import { savedModelRequest, unavailable, type TokenizationStage } from '../tokenization.js';
import { HelperError, object, text, type HelperInfo, type HelperRequest } from '../helper-protocol.js';

export interface TokenHelperOptions {
  /** Exact website origins that may use the helper. Other pages are refused. */
  origins: string[];
  ollamaUrl?: string;
  /** Operator-run llama.cpp tokenizer services, keyed by exact Ollama model ID. */
  tokenizers?: Record<string, TokenizerBinding>;
  /** Starts the vocabulary-only tokenizer for a model on demand. */
  managedTokenizer?: ManagedTokenizerOptions;
  inspectionFetch?: FetchLike;
  maxConnections?: number;
}
interface Connection { stage?: TokenizationStage; operations: Map<string, AbortController>; queue: Promise<void> }

/**
 * Tokenizer-only capability host. It renders a saved request with its own Ollama and tokenizes the
 * result with the matching vocabulary. It reads no project files, runs no commands, holds no
 * conversation and accepts no upstream address from the browser.
 */
export class TokenHelper {
  readonly origins: ReadonlySet<string>;
  private readonly connections = new Map<string, Connection>();
  private readonly tokenizers: Record<string, TokenizerBinding>;
  private readonly ollamaUrl: string;
  private readonly managedTokenizer: ManagedTokenizer | undefined;
  constructor(private readonly options: TokenHelperOptions) {
    this.tokenizers = tokenizerBindings(JSON.stringify(options.tokenizers ?? {}));
    const ollama = new URL(options.ollamaUrl ?? 'http://localhost:11434');
    if (!['http:', 'https:'].includes(ollama.protocol) || ollama.username || ollama.password || ollama.search || ollama.hash) throw new HelperError('Use an HTTP(S) Ollama URL without credentials, query or fragment');
    this.ollamaUrl = ollama.href.replace(/\/$/, '');
    if (!options.origins.length) throw new HelperError('Allow at least one website origin');
    for (const value of options.origins) {
      const origin = new URL(value);
      if (origin.origin !== value || !['https:', 'http:'].includes(origin.protocol)) throw new HelperError('Use exact HTTP(S) website origins such as https://harnessarium.com');
    }
    this.origins = new Set(options.origins);
    this.managedTokenizer = options.managedTokenizer ? new ManagedTokenizer(options.managedTokenizer, this.ollamaUrl, this.inspectionFetch) : undefined;
  }
  private readonly inspectionFetch: FetchLike = (url, init) => { const fetch_ = this.options.inspectionFetch ?? fetch; return fetch_(url, { ...init, redirect: 'error' }); };
  get info(): HelperInfo { return { ollamaUrl: this.ollamaUrl, models: Object.keys(this.tokenizers), automatic: this.managedTokenizer !== undefined }; }
  /** The transport has already checked the page origin. The token only separates page sessions. */
  connect(): { token: string } & HelperInfo {
    // Pages reconnect on every visit; the oldest session gives way so the table cannot grow without bound.
    if (this.connections.size >= (this.options.maxConnections ?? 32)) this.release(this.connections.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    this.connections.set(token, { operations: new Map(), queue: Promise.resolve() });
    return { token, ...this.info };
  }
  release(token: string): void {
    const connection = this.connections.get(token);
    if (!connection) return;
    for (const controller of connection.operations.values()) controller.abort();
    this.connections.delete(token);
    if (!this.connections.size) this.managedTokenizer?.close();
  }
  close(): void { for (const token of [...this.connections.keys()]) this.release(token); this.managedTokenizer?.close(); }
  async call(token: string, request: HelperRequest): Promise<unknown> {
    const connection = this.connections.get(token);
    if (!connection) throw new HelperError('Tokenizer helper connection is unavailable; connect again', 401);
    const { id, operation, args } = request;
    if (typeof id !== 'string' || !id || connection.operations.has(id) || typeof operation !== 'string') throw new HelperError('Use a unique request ID and operation');
    object(args);
    if (operation === 'inspectionProgress') return { stage: connection.stage ?? null };
    if (operation === 'release') { this.release(token); return { ok: true }; }
    if (operation === 'cancel') { connection.operations.get(text(args, 'id'))?.abort(); return { ok: true }; }
    if (operation !== 'inspectTokens') throw new HelperError('Unknown tokenizer helper operation');
    const controller = new AbortController(); connection.operations.set(id, controller);
    // One inspection at a time per page: they share the tokenizer process and the progress stage.
    const previous = connection.queue;
    let done!: () => void;
    connection.queue = new Promise<void>(resolve => { done = resolve; });
    try {
      await previous;
      if (controller.signal.aborted) throw new HelperError('Tokenizer helper operation cancelled');
      return await this.inspect(connection, args, controller.signal);
    } finally { connection.operations.delete(id); done(); }
  }
  private async inspect(connection: Connection, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const payload = savedModelRequest(args.payload);
    if (payload.provider && payload.provider !== 'ollama') throw new HelperError('The tokenizer helper supports Ollama requests only');
    if (text(args, 'ollamaUrl') !== this.ollamaUrl) throw new HelperError('Browser and tokenizer helper Ollama URLs must match');
    const progress = (stage: TokenizationStage) => { connection.stage = stage; };
    try {
      const local: Record<string, PromptTokenizer> = {};
      if (!Object.hasOwn(this.tokenizers, payload.model)) {
        if (!this.managedTokenizer) throw new HelperError('No tokenizer configured for this exact Ollama model');
        try { local[payload.model] = await this.managedTokenizer.binding(payload.model, signal, progress); }
        catch (error) {
          if (error instanceof TokenizerSetupError) return unavailable(payload.model, 'ollama', error.message);
          throw error;
        }
      }
      return await new OllamaAdapter(this.inspectionFetch, this.ollamaUrl, this.tokenizers, local).inspectTokens(payload, signal, progress);
    } finally { delete connection.stage; }
  }
}

/** Loopback transport. The Host and Origin checks are enforced here, not only advertised as CORS. */
export function createTokenHelperServer(helper: TokenHelper): Server {
  const server = createServer(async (request, response) => {
    try {
      const origin = request.headers.origin;
      if (request.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}` || !origin || !helper.origins.has(origin)) throw new HelperError('This website is not allowed to use the tokenizer helper', 403);
      response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      if (request.method !== 'POST' || !['/v1/connect', '/v1/call'].includes(request.url!)) throw new HelperError('Tokenizer helper route not found', 404);
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 12 * 1024 * 1024) throw new HelperError('Tokenizer helper request is too large', 413); }
      const value = object(JSON.parse(body));
      const result = request.url === '/v1/connect' ? helper.connect() : await helper.call(request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '', value as unknown as HelperRequest);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value: result }));
    } catch (error) {
      response.writeHead(error instanceof HelperError ? error.status : 400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof HelperError ? error.message : 'Tokenizer helper operation failed. Check the saved request.' }));
    }
  });
  server.on('close', () => helper.close());
  return server;
}

import { ManagedTokenizer, TokenizerSetupError, type ManagedTokenizerOptions } from './managed-tokenizer.js';
import { OllamaAdapter, type FetchLike } from '../ollama.js';
import { tokenizerBindings, type TokenizerBinding, type PromptTokenizer } from '../llama-tokenizer.js';
import { savedModelRequest, unavailable, type TokenizationStage } from '../tokenization.js';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WorkspaceAdapter } from './workspace.js';
import { branchName } from '../git.js';
import { NodeGit } from './git.js';
import { executeCommand } from './commands.js';
import { webSearch } from '../websearch.js';
import { BridgeError, object, text, type BridgeGrants, type BridgeRequest, type BridgeSnapshot } from '../bridge/protocol.js';
import type { McpFetch } from '../mcp/http.js';
import { projectFromFiles } from '../browser/workspace.js';

export interface BridgeOptions {
  workspace: string; origin: string; grants: BridgeGrants;
  managedTokenizer?: ManagedTokenizerOptions; inspectionFetch?: FetchLike; tokenizers?: Record<string, TokenizerBinding>; ollamaUrl?: string;
  maxMetadataEntries?: number; now?: () => number; fetch?: McpFetch; commandTimeoutMs?: number;
}
interface Connection { inspectionStage?: TokenizationStage; expires: number; operations: Map<string, AbortController>; effects: Promise<void>; workspaces: Map<string, WorkspaceAdapter> }
/** Capability host with fixed upstreams; no conversation or agent loop lives here. */
export class NativeBridge {
  readonly code = randomBytes(24).toString('hex');
  readonly workspace: WorkspaceAdapter;
  readonly origin: string;
  private readonly connections = new Map<string, Connection>();
  private readonly now: () => number;
  private readonly pairingExpiry: number;
  private paired = false;
  private readonly tokenizers: Record<string, TokenizerBinding>;
  private readonly ollamaUrl: string;
  private readonly managedTokenizer: ManagedTokenizer | undefined;
  constructor(private readonly options: BridgeOptions) {
    this.tokenizers = tokenizerBindings(JSON.stringify(options.tokenizers ?? {}));
    const ollama = new URL(options.ollamaUrl ?? 'http://localhost:11434');
    if (!['http:', 'https:'].includes(ollama.protocol) || ollama.username || ollama.password || ollama.search || ollama.hash) throw new BridgeError('Use an HTTP(S) Ollama URL without credentials, query or fragment');
    this.ollamaUrl = ollama.href.replace(/\/$/, '');
    const origin = new URL(options.origin);
    if (origin.origin !== options.origin || !['https:', 'http:'].includes(origin.protocol)) throw new BridgeError('Use an exact HTTP(S) website origin');
    this.origin = origin.origin; this.now = options.now ?? Date.now; this.pairingExpiry = this.now() + 300_000;
    this.workspace = new WorkspaceAdapter(options.workspace);
    if (!this.workspace.exists(this.workspace.root) || !this.workspace.isDirectory(this.workspace.root)) throw new BridgeError('Workspace must be an existing directory');
    this.managedTokenizer = options.managedTokenizer ? new ManagedTokenizer(options.managedTokenizer, this.ollamaUrl, this.inspectionFetch) : undefined;
  }
  private readonly inspectionFetch: FetchLike = (url, init) => { const fetch_ = this.options.inspectionFetch ?? fetch; return fetch_(url, { ...init, redirect: 'error' }); };
  pair(code: string, persistent = false): { token: string } {
    if (code !== this.code || this.paired || this.now() >= this.pairingExpiry) throw new BridgeError('Pairing code is invalid, expired, or already used', 403);
    this.paired = true;
    const token = randomBytes(32).toString('hex');
    this.connections.set(token, { expires: persistent ? Infinity : this.now() + 15_000, operations: new Map(), effects: Promise.resolve(), workspaces: new Map([['/bridge-workspace', this.workspace]]) });
    return { token };
  }
  private connection(token: string): Connection {
    this.sweep(); const connection = this.connections.get(token);
    if (!connection) throw new BridgeError('Bridge connection is unavailable; pair again', 401);
    return connection;
  }
  sweep(): void { for (const [token, connection] of this.connections) if (connection.expires <= this.now()) this.release(token); }
  release(token: string): void {
    const connection = this.connections.get(token);
    if (connection) { for (const controller of connection.operations.values()) controller.abort(); this.connections.delete(token); this.managedTokenizer?.close(); }
  }
  close(): void { for (const token of this.connections.keys()) this.release(token); this.managedTokenizer?.close(); }
  async call(token: string, request: BridgeRequest): Promise<unknown> {
    const connection = this.connection(token), { id, operation, args } = request;
    if (typeof id !== 'string' || !id || connection.operations.has(id) || typeof operation !== 'string') throw new BridgeError('Use a unique request ID and operation');
    object(args);
    if (operation === 'inspectionProgress') return { stage: connection.inspectionStage ?? null };
    if (operation === 'heartbeat') { connection.expires = connection.expires === Infinity ? Infinity : this.now() + 15_000; return { ok: true }; }
    if (operation === 'release') { this.release(token); return { ok: true }; }
    if (operation === 'cancel') { connection.operations.get(text(args, 'id'))?.abort(); return { ok: true }; }
    const mutations = ['write', 'remove', 'move', 'git_commit', 'git_createBranch', 'git_checkout'];
    const effect = mutations.includes(operation) || operation === 'command' || operation === 'inspectTokens';
    if (['write', 'remove', 'move'].includes(operation) && !this.options.grants.writes) throw new BridgeError('Local file writes are not granted', 403);
    if (operation.startsWith('git_') && mutations.includes(operation) && !this.options.grants.gitWrites) throw new BridgeError('Local Git mutations are not granted', 403);
    if (operation === 'command' && !this.options.grants.commands) throw new BridgeError('Local command execution is not granted', 403);
    const controller = new AbortController(); connection.operations.set(id, controller);
    const previous = connection.effects;
    let release!: () => void;
    if (effect) connection.effects = new Promise<void>(resolve => { release = resolve; });
    try {
      if (effect) await previous;
      if (controller.signal.aborted) throw new BridgeError('Bridge operation cancelled');
      return await this.execute(connection, operation, args, controller.signal);
    } finally { connection.operations.delete(id); if (effect) release(); }
  }
  async snapshot(workspace = this.workspace, root = '/bridge-workspace'): Promise<BridgeSnapshot> {
    let entries = 0;
    const files: Record<string, string> = Object.create(null), directories = [''];
    const visit = async (folder: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const name = prefix + entry.name;
        if (entry.isDirectory()) {
          directories.push(name);
          if (!['.git', '.venv', 'node_modules', '__pycache__', '.mypy_cache'].includes(entry.name)) await visit(path.join(folder, entry.name), name + '/');
        } else if (entry.isFile()) {
          // Catalog files need their bodies; ordinary files remain metadata-only.
          const instruction = /^agents\/[^/]+\.md$|^skills\/[^/]+\/SKILL\.md$/.test(name);
          files[name] = name === 'AGENTS.md' ? (await workspace.readText(workspace.pathFor(name))).slice(0, 10_000)
            : instruction ? await workspace.readText(workspace.pathFor(name)) : '';
        }
        if (++entries > (this.options.maxMetadataEntries ?? 50_000)) throw new BridgeError('Workspace metadata exceeds 50,000 entries');
      }
    };
    await visit(workspace.root, '');
    return { project: { ...projectFromFiles(root, files), directories }, workspace: workspace.root, git: existsSync(path.join(workspace.root, '.git')), grants: this.options.grants, tokenization: { models: Object.keys(this.tokenizers), ollamaUrl: this.ollamaUrl, ...(this.managedTokenizer ? { automatic: true } : {}) } };
  }
  private async expected(workspace: WorkspaceAdapter, args: Record<string, unknown>, file: string): Promise<void> {
    if (args.expected !== null && typeof args.expected !== 'string') throw new BridgeError('An approved expected file value is required');
    const current = workspace.exists(file) ? await workspace.readText(file) : null;
    if (current !== args.expected) throw new BridgeError('The file changed after the proposal; read it again and propose a new change', 409);
  }
  private async execute(connection: Connection, operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (operation === 'selectProject' || operation === 'browse') {
      const raw = text(args, 'path');
      const folder = raw || this.workspace.root;
      if (!path.isAbsolute(folder)) throw new BridgeError('Choose an absolute native directory path');
      const selected = new WorkspaceAdapter(folder);
      if (!selected.exists(selected.root) || !selected.isDirectory(selected.root)) throw new BridgeError('Choose an existing native directory');
      if (operation === 'browse') {
        const entries = await readdir(selected.root, { withFileTypes: true });
        return { path: selected.root, parent: path.dirname(selected.root) === selected.root ? null : path.dirname(selected.root), folders: entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort() };
      }
      const snapshot = await this.snapshot(selected, selected.root);
      signal.throwIfAborted();
      connection.workspaces.set(selected.root, selected);
      return snapshot;
    }
    const root = args.workspace === undefined ? '/bridge-workspace' : text(args, 'workspace');
    const workspace = connection.workspaces.get(root);
    if (!workspace) throw new BridgeError('Select this native workspace explicitly before using its tools', 403);
    if (operation === 'inspectTokens') {
      const payload = savedModelRequest(args.payload);
      if (payload.provider && payload.provider !== 'ollama') throw new BridgeError('Bridge token inspection supports Ollama requests only');
      if (text(args, 'ollamaUrl') !== this.ollamaUrl) throw new BridgeError('Browser and bridge Ollama URLs must match');
      const progress = (stage: TokenizationStage) => { connection.inspectionStage = stage; };
      try {
        const bindings = this.tokenizers;
        const local: Record<string, PromptTokenizer> = {};
        if (!Object.hasOwn(bindings, payload.model)) {
          if (!this.managedTokenizer) throw new BridgeError('No tokenizer configured for this exact Ollama model');
          try { local[payload.model] = await this.managedTokenizer.binding(payload.model, signal, progress); }
          catch (error) {
            if (error instanceof TokenizerSetupError) return unavailable(payload.model, 'ollama', error.message);
            throw error;
          }
        }
        return await new OllamaAdapter(this.inspectionFetch, this.ollamaUrl, bindings, local).inspectTokens(payload, signal, progress);
      } finally { delete connection.inspectionStage; }
    }
    if (operation === 'snapshot') return this.snapshot(workspace, root);
    if (operation === 'read') return workspace.readText(workspace.pathFor(text(args, 'path')));
    if (operation === 'write' || operation === 'remove' || operation === 'move') {
      const file = workspace.pathFor(text(args, 'path'));
      await this.expected(workspace, args, file);
      signal.throwIfAborted();
      if (operation === 'write') await workspace.writeText(file, text(args, 'content'));
      else if (operation === 'remove') await workspace.remove(file);
      else await workspace.move(file, workspace.pathFor(text(args, 'to')));
      return { ok: true };
    }
    if (operation === 'list') return workspace.listFiles(text(args, 'path'));
    if (operation === 'numbered') return workspace.readNumbered(text(args, 'path'), Number(args.start), Number(args.end));
    if (operation === 'find') return workspace.findFiles(text(args, 'pattern'));
    if (operation === 'search') return workspace.search(text(args, 'pattern'), text(args, 'path'), text(args, 'glob'));
    if (operation === 'command') return executeCommand(text(args, 'command'), workspace.root, signal, this.options.commandTimeoutMs);
    if (operation === 'webSearch') return webSearch(this.options.fetch ?? fetch, text(args, 'query'), signal);
    if (!existsSync(path.join(workspace.root, '.git'))) throw new BridgeError('Unknown operation or workspace has no Git repository');
    const git = new NodeGit(workspace.root, signal);
    const paths = args.paths === undefined ? undefined : (args.paths as unknown[]).map(value => workspace.relative(workspace.pathFor(String(value))));
    switch (operation) {
      case 'git_status': return git.status();
      case 'git_diff': return git.diff({ staged: args.staged === true, ...(paths ? { paths } : {}) });
      case 'git_log': return git.log({ limit: Number(args.limit), ...(args.path === undefined ? {} : { path: workspace.relative(workspace.pathFor(text(args, 'path'))) }) });
      case 'git_branches': return git.branches();
      case 'git_commit': return git.commit(text(args, 'message'), paths);
      case 'git_createBranch': return git.createBranch(branchName(text(args, 'name')));
      case 'git_checkout': return git.checkout(branchName(text(args, 'name')));
      default: throw new BridgeError('Unknown bridge operation');
    }
  }
}

/** Versioned loopback transport; origin validation is enforced, not only advertised as CORS. */
export function createBridgeServer(bridge: NativeBridge): Server {
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      if (host !== `127.0.0.1:${(server.address() as { port: number }).port}` || request.headers.origin !== bridge.origin) throw new BridgeError('Bridge Host or Origin is not allowed', 403);
      response.setHeader('Access-Control-Allow-Origin', bridge.origin); response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      if (request.method !== 'POST' || !['/v1/pair', '/v1/call'].includes(request.url!)) throw new BridgeError('Bridge route not found', 404);
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 12 * 1024 * 1024) throw new BridgeError('Bridge request is too large', 413); }
      const value = object(JSON.parse(body));
      const result = request.url === '/v1/pair' ? bridge.pair(text(value, 'code'), value.persistent === true) : await bridge.call(request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '', value as unknown as BridgeRequest);
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); response.end(JSON.stringify({ value: result ?? null }) + '\n');
    } catch (error) {
      response.writeHead(error instanceof BridgeError ? error.status : 400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof BridgeError ? error.message : 'Bridge operation failed. Check the arguments and local workspace.' }));
    }
  });
  const timer = setInterval(() => bridge.sweep(), 1000); timer.unref();
  server.on('close', () => { clearInterval(timer); bridge.close(); });
  return server;
}

import type { ToolDefinition, ToolResult } from '../core.js';
import { McpClient, withDeadline, type McpChannel, type WireEntry } from './client.js';
import { LegacySseChannel, StreamableHttpChannel, type McpFetch } from './http.js';
import { searchRegistry, type RegistryServer, type RegistrySource } from './registry.js';
import { HttpStatusError, contentText, headerAnnotations, isObject, limitText, mirroredHeaders, resourceText, toolResultText, type HeaderAnnotation, type JsonObject, type RpcRequest, type RpcResponse } from './protocol.js';

export type StdioConfig = { kind: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string };
export type HttpConfig = { kind: 'http' | 'sse'; url: string; headers: Record<string, string> };
export type ServerConfig = StdioConfig | HttpConfig;

/** Runtime capabilities for MCP. Missing capabilities are reported, never silently skipped. */
export interface McpRuntime {
  /** Where the configuration comes from, for display. */
  readonly source: string;
  loadConfig(): Promise<unknown>;
  /** Persists harness-owned configuration; never writes into the project workspace. */
  saveConfig?(value: JsonObject): Promise<void>;
  fetch?: McpFetch;
  stdio?(config: StdioConfig): McpChannel;
  /** Why stdio servers cannot run in this runtime. */
  readonly stdioUnsupported?: string;
  /** Variables for ${NAME} expansion; without it, values are used literally. */
  readonly environment?: Record<string, string | undefined>;
  /** Added to network failures, e.g. a CORS reminder in browsers. */
  readonly networkHint?: string;
}
export interface McpToolCall { name: string; server: string; tool: string; arguments: JsonObject; annotations: unknown }
export interface McpOutcome { text: string; isError: boolean; version: string; transport: string; request?: RpcRequest; response?: RpcResponse }

interface McpTool { name: string; qualified: string; description: string; inputSchema: JsonObject; annotations: unknown; headers: HeaderAnnotation[] }
interface McpPrompt { name: string; qualified: string; description: string; arguments: { name: string; description: string; required: boolean }[] }
interface ServerState {
  name: string; transport: string; status: 'connecting' | 'connected' | 'error' | 'unsupported' | 'disabled'; error?: string;
  client?: McpClient; tools: McpTool[]; resources: JsonObject[]; templates: JsonObject[]; prompts: McpPrompt[]; warnings: string[];
}

export const RESOURCE_TOOLS: ToolDefinition[] = [
  { type: 'function', function: { name: 'list_mcp_resources', description: 'List the resources (data such as files, records or documents) that connected MCP servers offer. Read one with read_mcp_resource.', parameters: { type: 'object', properties: { server: { type: 'string', description: 'Only this MCP server (default: all)' } } } } },
  { type: 'function', function: { name: 'read_mcp_resource', description: 'Read a resource from an MCP server by its URI, as listed by list_mcp_resources.', parameters: { type: 'object', properties: { server: { type: 'string', description: 'The MCP server name' }, uri: { type: 'string', description: 'The resource URI' } }, required: ['server', 'uri'] } } },
];
const RESOURCE_NAMES = RESOURCE_TOOLS.map(tool => tool.function.name);
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const strings = (value: unknown, field: string): Record<string, string> => {
  if (value === undefined) return {};
  if (!isObject(value) || !Object.values(value).every(item => typeof item === 'string')) throw new Error(`${field} must be an object of strings`);
  return value as Record<string, string>;
};

/** Validates the standard {"mcpServers": {...}} configuration. Invalid entries become per-server errors. */
export function parseConfig(value: unknown): Record<string, ServerConfig | Error | null> {
  if (value === undefined) return {};
  if (!isObject(value) || (value.mcpServers !== undefined && !isObject(value.mcpServers))) throw new Error('MCP configuration must be a JSON object with an "mcpServers" object');
  const servers: Record<string, ServerConfig | Error | null> = {};
  for (const [name, raw] of Object.entries((value.mcpServers ?? {}) as JsonObject)) {
    try {
      if (!SERVER_NAME.test(name)) throw new Error('server names may use letters, digits, _ and - (at most 32)');
      if (!isObject(raw)) throw new Error('the entry must be an object');
      if (raw.disabled === true) { servers[name] = null; continue; }
      if (raw.command !== undefined) {
        if (typeof raw.command !== 'string' || !raw.command.trim()) throw new Error('command must be a non-empty string');
        if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every(item => typeof item === 'string'))) throw new Error('args must be an array of strings');
        if (raw.cwd !== undefined && typeof raw.cwd !== 'string') throw new Error('cwd must be a string');
        servers[name] = { kind: 'stdio', command: raw.command, args: (raw.args ?? []) as string[], env: strings(raw.env, 'env'), ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}) };
        continue;
      }
      const kind = raw.type === 'sse' ? 'sse' : raw.type === undefined || raw.type === 'http' || raw.type === 'streamable-http' ? 'http' : undefined;
      if (!kind) throw new Error('type must be "http" or "sse", or give a command for stdio');
      if (typeof raw.url !== 'string') throw new Error('url must be a string');
      servers[name] = { kind, url: raw.url, headers: strings(raw.headers, 'headers') };
    } catch (error) { servers[name] = new Error(`${name}: ${(error as Error).message}`); }
  }
  return servers;
}

/** ${NAME} and ${NAME:-default} expansion. Unknown names without a default are errors. */
export function expand(text: string, environment: Record<string, string | undefined>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const value = environment[name] ?? fallback;
    if (value === undefined) throw new Error(`environment variable ${name} is not set`);
    return value;
  });
}

function expanded(config: ServerConfig, environment: Record<string, string | undefined> | undefined): ServerConfig {
  if (!environment) return config;
  const map = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(value, environment)]));
  return config.kind === 'stdio'
    ? { ...config, command: expand(config.command, environment), args: config.args.map(arg => expand(arg, environment)), env: map(config.env), ...(config.cwd ? { cwd: expand(config.cwd, environment) } : {}) }
    : { ...config, url: expand(config.url, environment), headers: map(config.headers) };
}

const sanitize = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_');

function describe(state: ServerState): JsonObject {
  return {
    name: state.name, transport: state.transport, status: state.status, ...(state.error ? { error: state.error } : {}),
    era: state.client?.era ?? null, protocol_version: state.client?.version || null, server_info: state.client?.serverInfo ?? null,
    instructions: state.client?.instructions ?? '', capabilities: state.client?.capabilities ?? {},
    tools: state.tools.map(tool => ({ name: tool.name, qualified: tool.qualified, description: tool.description, annotations: tool.annotations })),
    resources: state.resources.length + state.templates.length,
    prompts: state.prompts.map(prompt => ({ name: prompt.name, qualified: prompt.qualified, description: prompt.description, arguments: prompt.arguments })),
    warnings: state.warnings, log: (state.client?.log ?? []) as WireEntry[], stderr: state.client?.stderr() ?? [],
  };
}

/** Owns MCP connections for one harness. Turns servers into tools, instructions, resources and prompts. */
export class McpManager {
  private servers: ServerState[] = [];
  private configError = '';
  constructor(private readonly runtime: McpRuntime | undefined, private readonly options: { connectTimeoutMs?: number; probeTimeoutMs?: number } = {}) {}

  get supported(): boolean { return this.runtime !== undefined; }

  /** Closes existing connections, re-reads the configuration and connects every server in parallel. */
  async load(signal: AbortSignal = new AbortController().signal): Promise<void> {
    await this.close();
    this.configError = '';
    if (!this.runtime) return;
    let configs: Record<string, ServerConfig | Error | null>;
    try { configs = parseConfig(await this.runtime.loadConfig()); }
    catch (error) { this.configError = (error as Error).message; return; }
    this.servers = Object.entries(configs).map(([name, config]) => ({ name, transport: config instanceof Error || config === null ? '' : config.kind, status: 'connecting', tools: [], resources: [], templates: [], prompts: [], warnings: [] }));
    await Promise.all(this.servers.map((state, index) => this.connect(state, Object.values(configs)[index]!, signal)));
  }

  private channel(config: ServerConfig): McpChannel | string {
    const runtime = this.runtime!;
    if (config.kind === 'stdio') return runtime.stdio ? runtime.stdio(config) : runtime.stdioUnsupported ?? 'stdio servers are unavailable in this runtime';
    if (!runtime.fetch) return 'HTTP servers are unavailable in this runtime';
    const url = URL.canParse(config.url) ? new URL(config.url) : undefined;
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('use an HTTP(S) URL without credentials; put tokens in headers');
    return config.kind === 'sse' ? new LegacySseChannel(runtime.fetch, url.href, config.headers) : new StreamableHttpChannel(runtime.fetch, url.href, config.headers);
  }

  private async connect(state: ServerState, raw: ServerConfig | Error | null, outer: AbortSignal): Promise<void> {
    if (raw === null) { state.status = 'disabled'; return; }
    try {
      if (raw instanceof Error) throw raw;
      const config = expanded(raw, this.runtime!.environment), channel = this.channel(config);
      if (typeof channel === 'string') { state.status = 'unsupported'; state.error = channel; return; }
      const fetch_ = this.runtime!.fetch!;
      state.client = new McpClient(channel, { ...(config.kind === 'http' ? { fallback: () => new LegacySseChannel(fetch_, config.url, config.headers) } : {}), ...(this.options.probeTimeoutMs ? { probeTimeoutMs: this.options.probeTimeoutMs } : {}) });
      const client = state.client;
      await withDeadline(outer, this.options.connectTimeoutMs ?? 15_000, async signal => {
        await client.connect(signal);
        state.transport = client.transport;
        if (client.capabilities.tools) for (const tool of await client.list('tools/list', 'tools', signal)) this.addTool(state, tool);
        if (client.capabilities.resources) {
          state.resources = await client.list('resources/list', 'resources', signal);
          state.templates = await client.list('resources/templates/list', 'resourceTemplates', signal).catch(() => []);
        }
        if (client.capabilities.prompts) for (const prompt of await client.list('prompts/list', 'prompts', signal)) this.addPrompt(state, prompt);
      });
      state.status = 'connected';
    } catch (error) {
      state.status = 'error';
      const hint = error instanceof HttpStatusError && error.status === 401 ? ' Authorization required: add an Authorization header to this server\'s configuration (OAuth sign-in is not supported).'
        : error instanceof TypeError && this.runtime!.networkHint ? ` ${this.runtime!.networkHint}` : '';
      state.error = (error as Error).message + hint;
      await state.client?.close().catch(() => undefined);
    }
  }

  private qualified(state: ServerState, name: string, kind: string): string | undefined {
    const qualified = `mcp__${state.name}__${sanitize(name)}`;
    if (qualified.length > 64) { state.warnings.push(`${kind} '${name}' skipped: its qualified name is longer than 64 characters`); return undefined; }
    if (state.tools.some(item => item.qualified === qualified) || state.prompts.some(item => item.qualified === qualified)) { state.warnings.push(`${kind} '${name}' skipped: its name collides with another after sanitizing`); return undefined; }
    return qualified;
  }
  private addTool(state: ServerState, tool: JsonObject): void {
    if (typeof tool.name !== 'string' || !tool.name) { state.warnings.push('a tool without a name was skipped'); return; }
    const headers = state.client!.transport === 'http' ? headerAnnotations(tool.inputSchema) : [];
    if (typeof headers === 'string') { state.warnings.push(`tool '${tool.name}' skipped: ${headers}`); return; }
    const qualified = this.qualified(state, tool.name, 'tool');
    if (!qualified) return;
    const { $schema: _schema, ...schema } = isObject(tool.inputSchema) ? tool.inputSchema : {};
    state.tools.push({ name: tool.name, qualified, description: String(tool.description ?? tool.title ?? ''), inputSchema: { type: 'object', properties: {}, ...schema }, annotations: tool.annotations ?? null, headers });
  }
  private addPrompt(state: ServerState, prompt: JsonObject): void {
    if (typeof prompt.name !== 'string' || !prompt.name) { state.warnings.push('a prompt without a name was skipped'); return; }
    const qualified = this.qualified(state, prompt.name, 'prompt');
    if (!qualified) return;
    const args = (Array.isArray(prompt.arguments) ? prompt.arguments : []).filter(isObject).map(arg => ({ name: String(arg.name), description: String(arg.description ?? ''), required: arg.required === true }));
    state.prompts.push({ name: prompt.name, qualified, description: String(prompt.description ?? ''), arguments: args });
  }

  private connected(): ServerState[] { return this.servers.filter(state => state.status === 'connected'); }
  private hasResources(): boolean { return this.connected().some(state => state.client!.capabilities.resources); }

  /** Tool definitions exactly as they are sent to the model. */
  definitions(): ToolDefinition[] {
    const tools = this.connected().flatMap(state => state.tools.map(tool => ({ type: 'function' as const, function: { name: tool.qualified, description: `[MCP server ${state.name}] ${tool.description}`.trim(), parameters: tool.inputSchema } })));
    return [...tools, ...(this.hasResources() ? RESOURCE_TOOLS : [])];
  }
  /** Names this manager answers for, connected or not. */
  owns(name: string): boolean { return name.startsWith('mcp__') || RESOURCE_NAMES.includes(name); }

  /** Resource tools run here (read-only). Tool calls return an effect that needs approval. */
  async prepare(name: string, args: JsonObject, signal: AbortSignal): Promise<ToolResult> {
    if (RESOURCE_NAMES.includes(name)) return { kind: 'text', text: await this.resourceTool(name, args, signal) };
    for (const state of this.servers) {
      const tool = state.tools.find(item => item.qualified === name);
      if (!tool) continue;
      if (state.status !== 'connected') break;
      const call: McpToolCall = { name, server: state.name, tool: tool.name, arguments: args, annotations: tool.annotations };
      return { kind: 'mcp', call };
    }
    const server = this.servers.find(state => name.startsWith(`mcp__${state.name}__`));
    return { kind: 'text', text: server && server.status !== 'connected' ? `error: MCP server '${server.name}' is not connected (${server.status}${server.error ? `: ${server.error}` : ''})` : `error: unknown tool '${name}'` };
  }

  private async resourceTool(name: string, args: JsonObject, signal: AbortSignal): Promise<string> {
    try {
      if (args.server !== undefined && typeof args.server !== 'string') throw new Error("bad arguments for 'server'");
      const servers = this.connected().filter(state => state.client!.capabilities.resources && (args.server === undefined || state.name === args.server));
      if (!servers.length) throw new Error(`no connected MCP server${args.server === undefined ? ' offers resources' : ` '${String(args.server)}' offers resources`}`);
      if (name === 'list_mcp_resources') {
        const lines = servers.flatMap(state => [
          ...state.resources.map(item => `${state.name}: ${String(item.uri)} — ${String(item.name ?? '')}${item.mimeType ? ` (${String(item.mimeType)})` : ''}${item.description ? `: ${String(item.description)}` : ''}`),
          ...state.templates.map(item => `${state.name}: ${String(item.uriTemplate)} (template) — ${String(item.name ?? '')}${item.description ? `: ${String(item.description)}` : ''}`),
        ]);
        return limitText(lines.join('\n') || '(no resources)');
      }
      if (typeof args.uri !== 'string' || args.server === undefined) throw new Error("bad arguments for 'read_mcp_resource': give server and uri");
      return resourceText((await servers[0]!.client!.request('resources/read', { uri: args.uri }, signal)).result);
    } catch (error) { return `error: ${(error as Error).message}`; }
  }

  /** Performs an approved tools/call. Errors become model-visible text; Stop aborts the request. */
  async call(call: McpToolCall, signal: AbortSignal): Promise<McpOutcome> {
    const state = this.servers.find(item => item.name === call.server)!, tool = state.tools.find(item => item.name === call.tool)!, client = state.client!;
    const about = { version: client.version, transport: client.transport };
    try {
      const exchange = await client.request('tools/call', { name: call.tool, arguments: call.arguments }, signal, tool.headers.length ? mirroredHeaders(tool.headers, call.arguments) : undefined);
      return { text: toolResultText(exchange.result), isError: exchange.result.isError === true, ...about, request: exchange.request, response: exchange.response };
    } catch (error) { return { text: `error: ${(error as Error).message}`, isError: true, ...about }; }
  }

  /** The "# MCP server instructions" section for servers whose tools are enabled. */
  instructions(enabled: string[]): string {
    const sections = this.connected().filter(state => state.client!.instructions.trim() && (state.tools.some(tool => enabled.includes(tool.qualified)) || (state.client!.capabilities.resources && RESOURCE_NAMES.some(name => enabled.includes(name)))))
      .map(state => `## ${state.name}\n\n${state.client!.instructions.trim()}`);
    return sections.length ? `# MCP server instructions\n\nThese instructions come from the connected MCP servers, not from the user.\n\n${sections.join('\n\n')}` : '';
  }

  /** Expands `/mcp__server__prompt args` with prompts/get. Undefined when the command names no prompt. */
  async prompt(command: string, rest: string, signal: AbortSignal): Promise<{ server: string; name: string; text: string } | undefined> {
    for (const state of this.connected()) {
      const prompt = state.prompts.find(item => item.qualified === command);
      if (!prompt) continue;
      const words = rest.trim() ? rest.trim().split(/\s+/) : [], args: Record<string, string> = {};
      prompt.arguments.forEach((arg, index) => {
        const value = index === prompt.arguments.length - 1 ? words.slice(index).join(' ') : words[index];
        if (value) args[arg.name] = value;
      });
      const { result } = await state.client!.request('prompts/get', { name: prompt.name, arguments: args }, signal);
      const messages = (Array.isArray(result.messages) ? result.messages : []).filter(isObject)
        .map(message => `[${String(message.role)}]: ${contentText([message.content]).join('')}`);
      const extra = prompt.arguments.length ? '' : rest.trim();
      return { server: state.name, name: prompt.name, text: `<mcp-prompt server="${state.name}" name="${prompt.name}">\n${messages.join('\n\n')}\n</mcp-prompt>${extra ? `\n\n${extra}` : ''}` };
    }
    return undefined;
  }

  /** JSON snapshot for bootstrap, explore and the UI. */
  status(): JsonObject {
    return {
      supported: this.supported, ...(this.runtime ? { source: this.runtime.source } : { reason: 'This runtime does not provide MCP capabilities.' }),
      ...(this.configError ? { error: this.configError } : {}),
      servers: this.servers.map(describe),
    };
  }

  /** Adds entries without overwriting existing servers, then reconnects. */
  async addConfig(value: unknown): Promise<JsonObject> {
    if (!this.runtime?.saveConfig) throw new Error('this runtime cannot save MCP configuration');
    const added = parseConfig(value);
    if (!Object.keys(added).length) throw new Error('Choose at least one MCP server to add');
    for (const config of Object.values(added)) if (config instanceof Error) throw config;
    const existing = await this.runtime.loadConfig();
    parseConfig(existing);
    const current = (existing ?? {}) as JsonObject;
    const servers = (current.mcpServers ?? {}) as JsonObject;
    for (const name of Object.keys(added)) if (Object.hasOwn(servers, name)) throw new Error(`MCP server '${name}' already exists; edit its configuration to replace it`);
    await this.runtime.saveConfig({ ...current, mcpServers: { ...servers, ...(value as JsonObject).mcpServers as JsonObject } });
    await this.load();
    return this.status();
  }

  /** Searches an MCP registry through the runtime's fetch. */
  async searchRegistry(query: { search?: string; cursor?: string; source?: RegistrySource }, signal?: AbortSignal): Promise<{ servers: RegistryServer[]; nextCursor: string }> {
    if (!this.runtime?.fetch) throw new Error('this runtime cannot reach the MCP registry');
    return searchRegistry(this.runtime.fetch, query, signal);
  }

  /** Connects to a remote server once, lists what it offers, and disconnects. Nothing is called or added. */
  async preview(target: { type: 'http' | 'sse'; url: string; headers?: unknown }, signal: AbortSignal = new AbortController().signal): Promise<JsonObject> {
    if (!this.runtime) throw new Error('this runtime does not provide MCP capabilities');
    const state: ServerState = { name: 'preview', transport: target.type, status: 'connecting', tools: [], resources: [], templates: [], prompts: [], warnings: [] };
    await this.connect(state, { kind: target.type, url: target.url, headers: strings(target.headers, 'headers') }, signal);
    await state.client?.close().catch(() => undefined);
    return describe(state);
  }
  /** Bootstrap entries for the UI's tool list. */
  toolList(): JsonObject[] {
    return this.definitions().map(({ function: tool }) => ({ name: tool.name, description: tool.description, supported: true, source: 'mcp', server: this.connected().find(state => state.tools.some(item => item.qualified === tool.name))?.name ?? '' }));
  }

  async close(): Promise<void> {
    const servers = this.servers; this.servers = [];
    await Promise.all(servers.map(state => state.client?.close().catch(() => undefined)));
  }
}

import type { ModelRequest } from '../core.js';
import { unavailable, type TokenInspection, type TokenizationProgress, type TokenizationStage, type InspectionProgress, TOKENIZATION_PROGRESS } from '../tokenization.js';
import type { OrchestrationLimits } from '../orchestration-limits.js';
import { CloudAdapter } from '../cloud.js';
import type { ModelOption } from '../model.js';
import { ProviderRouter, modelConfiguration, providerName, type ModelConfiguration } from '../providers.js';
import { DemoModel } from './demo.js';
import { Harness, BackendError, type ModelPort } from '../harness.js';
import { GIT_TOOLS, TOOL_NAMES } from '../tools.js';
import { BrowserGit } from './git.js';
import { BridgeClient, BridgeWorkspace } from './bridge.js';
import type { RuntimePort } from '../runtime.js';
import type { StoragePort } from './storage.js';
import { BrowserSessions } from './sessions.js';
import { BrowserWorkspace, absolutePath, projectFromFiles, type Project } from './workspace.js';
import { BrowserCatalog, type Library } from './catalog.js';
import { BrowserModel } from './model.js';
import { DEMO_MODEL } from './demo.js';
import { OllamaAdapter } from '../ollama.js';
import { LocalWorkspace, type LocalDirectory, type StoredProject } from './local.js';
import { parseConfig } from '../mcp/manager.js';
import { isObject } from '../mcp/protocol.js';

export interface BrowserOptions {
  storage: StoragePort; library: Library; seed: Record<string, string>;
  modelPort?: ModelPort; model?: string; contextLength?: number; approvalTimeoutMs?: number;
  mcpTimeouts?: { connectTimeoutMs?: number; probeTimeoutMs?: number };
  allowSubagents?: boolean;
  orchestrationLimits?: Partial<OrchestrationLimits>;
  runtime?: Partial<RuntimePort>;
  childTools?: string[];
  childRoutes?: { provider: import('../model.js').Provider; model: string }[];
}
/** MCP configuration with header values; header values live only in Worker memory. */
interface McpConfigHolder { value?: unknown }
type ResolvedBrowserOptions = BrowserOptions & Required<Pick<BrowserOptions, 'allowSubagents' | 'childTools' | 'childRoutes'>>;

/** Complete browser backend. It runs directly or in a Worker, without a page. */
export class BrowserHarness extends Harness {
  private runtime!: RuntimePort;
  private bridge: BridgeClient | undefined;
  private bridgeInspection = false;
  private bridgeRestore: { runtime: RuntimePort; workspace: string } | undefined;
  private bridgeGeneration = 0;
  private readonly bridgeWorkspaces = new Map<string, BridgeWorkspace>();
  private constructor(private readonly browser: ResolvedBrowserOptions, private readonly projects: Map<string, StoredProject>, workspace: string, private readonly router: ProviderRouter, private readonly mcpConfig: McpConfigHolder = {}) {
    const runtime: RuntimePort = {
        name: 'browser', supportedTools: TOOL_NAMES.filter(name => name !== 'run_command' && name !== 'web_search'),
        unavailable: { run_command: 'a browser page cannot start processes', web_search: 'DuckDuckGo does not accept requests from web pages',
          ...Object.fromEntries(GIT_TOOLS.map(name => [name, 'git tools need a repository: open a local folder that contains a .git directory (virtual projects have none)'])) },
        git: workspace => workspace instanceof LocalWorkspace && workspace.isDirectory('.git') ? new BrowserGit(workspace.handle) : undefined,
        capabilities: { workspace: 'virtual text files or user-granted local folder', commands: false, web_search: false, persistence: 'IndexedDB', inference: 'external model provider' },
        workspace(folder) {
          const project: StoredProject = projects.get(folder) ?? projectFromFiles(folder, {});
          const adapter = project.handle ? new LocalWorkspace(project, project.handle) : new BrowserWorkspace(project, value => browser.storage.put('projects', value.root, value));
          // A fabricated adapter for an imported session must not invent a missing workspace.
          if (!projects.has(folder)) adapter.exists = () => false;
          return adapter;
        },
        catalog: workspace => new BrowserCatalog(browser.library, workspace as BrowserWorkspace),
        resolveProject: absolutePath,
        saveProject: folder => browser.storage.put('settings', 'workspace', folder),
        async executeCommand() { throw new BackendError('Bash commands are unavailable in the browser. Use the Node runtime for run_command.'); },
        mcp: {
          source: 'imported MCP configuration (browser storage)', fetch,
          stdioUnsupported: 'stdio servers start local processes, which a browser cannot do. Use the Node runtime.',
          networkHint: 'Check that the MCP server allows this page origin and the MCP request headers (CORS).',
          loadConfig: async () => mcpConfig.value ?? await browser.storage.get('settings', 'mcp-config'),
          async saveConfig(value) {
            const stored = structuredClone(value);
            for (const server of Object.values(stored.mcpServers as Record<string, unknown>)) if (isObject(server)) delete server.headers;
            await browser.storage.put('settings', 'mcp-config', stored);
            mcpConfig.value = value;
          },
        },
        ...browser.runtime,
      };
    super({ ...(browser.orchestrationLimits ? { orchestrationLimits: browser.orchestrationLimits } : {}), workspace, model: browser.model ?? 'qwen3:8b', contextLength: browser.contextLength ?? 8192,
      ...(browser.modelPort ? { ollama: browser.modelPort } : { modelAdapter: router }), sessions: new BrowserSessions(browser.storage),
      ...(browser.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: browser.approvalTimeoutMs }), ...(browser.mcpTimeouts ? { mcpTimeouts: browser.mcpTimeouts } : {}), allowSubagents: browser.allowSubagents, childTools: browser.childTools, childRoutes: browser.childRoutes, saveHarnessSettings: async settings => { await browser.storage.put('settings', 'harness-settings', settings); }, runtime });
    this.runtime = runtime;
  }

  static async open(options: BrowserOptions): Promise<BrowserHarness> {
    const projects = new Map((await options.storage.all<StoredProject>('projects')).map(project => [project.root, project]));
    if (!projects.size) { const project = projectFromFiles('/workspace', options.seed); await options.storage.put('projects', project.root, project); projects.set(project.root, project); }
    const saved = await options.storage.get<string>('settings', 'workspace');
    const workspace = saved && projects.has(saved) ? saved : projects.keys().next().value!;
    const url = await options.storage.get<string>('settings', 'ollama-url');
    const router = new ProviderRouter(fetch, { demo: new DemoModel(), ollama: new OllamaAdapter(fetch, url ?? 'http://localhost:11434') }, options.model === DEMO_MODEL ? 'demo' : 'ollama');
    const settings = await options.storage.get<{ allowSubagents: boolean; childTools: string[]; childRoutes: { provider: import('../model.js').Provider; model: string }[] }>('settings', 'harness-settings');
    const harness = new BrowserHarness({ ...options, allowSubagents: settings?.allowSubagents ?? options.allowSubagents ?? false, childTools: settings?.childTools ?? options.childTools ?? [], childRoutes: settings?.childRoutes ?? options.childRoutes ?? [] }, projects, workspace, router);
    await harness.initialize();
    return harness;
  }

  protected override async inspectModelTokens(payload: ModelRequest, signal: AbortSignal, progress?: InspectionProgress): Promise<TokenInspection> {
    const bridge = this.bridge;
    if (this.router.selected !== 'ollama' || payload.provider && payload.provider !== 'ollama' || !bridge?.connected || !(bridge.snapshot().tokenization?.automatic || bridge.snapshot().tokenization?.models.length)) return super.inspectModelTokens(payload, signal, progress);
    const config = bridge.snapshot().tokenization!;
    if (!config.automatic && !config.models.includes(payload.model)) return unavailable(payload.model, 'ollama', 'The bridge has no tokenizer configured for this exact Ollama model. Set MYHARNESS_TOKENIZERS on the bridge and pair again.');
    const endpoint = await this.browser.storage.get<string>('settings', 'ollama-url') ?? 'http://localhost:11434';
    if (endpoint !== config.ollamaUrl) return unavailable(payload.model, 'ollama', 'The browser and bridge Ollama URLs differ. Connect the same Ollama server in both before inspecting tokens.');
    this.bridgeInspection = true;
    try { return await bridge.call<TokenInspection>('inspectTokens', { payload, ollamaUrl: endpoint }, signal); }
    finally { this.bridgeInspection = false; }
  }

  override async tokenizationProgress(): Promise<TokenizationProgress | null> {
    const current = await super.tokenizationProgress();
    if (!current || !this.bridgeInspection || !this.bridge?.connected) return current;
    try {
      const { stage } = await this.bridge.call<{ stage: TokenizationStage | null }>('inspectionProgress');
      return stage && Object.hasOwn(TOKENIZATION_PROGRESS, stage) ? { ...current, stage, message: TOKENIZATION_PROGRESS[stage] } : current;
    } catch { return current; }
  }

  async attachBridge(endpoint: string, code: string, persistent = false): Promise<void> {
    this.idle('connecting a bridge');
    if (this.bridge?.connected) throw new BackendError('Lock or end this experiment before pairing a replacement bridge.');
    const generation = this.bridgeGeneration;
    const bridge = new BridgeClient(endpoint);
    await bridge.pair(code, persistent);
    try {
      this.idle('connecting a bridge');
      if (generation !== this.bridgeGeneration) throw new BackendError('Bridge pairing cancelled by unpairing.');
    } catch (error) { await bridge.close(); throw error; }
    const workspace = new BridgeWorkspace(bridge), snapshot = bridge.snapshot();
    this.bridgeRestore ??= { runtime: { ...this.runtime, capabilities: { ...this.runtime.capabilities } }, workspace: this.state.workspace };
    this.projects.set(workspace.root, workspace.project);
    this.bridgeWorkspaces.clear(); this.bridgeWorkspaces.set(workspace.root, workspace);
    const local = this.runtime.workspace, localGit = this.runtime.git!;
    this.runtime.workspace = folder => this.bridgeWorkspaces.get(folder) ?? local(folder);
    this.runtime.git = (folder, signal) => folder instanceof BridgeWorkspace ? (bridge.connected && bridge.snapshot(folder.root).git ? bridge.git(signal, folder.root) : undefined) : localGit(folder, signal);
    this.runtime.executeCommand = (command, folder, signal) => { if (!this.bridgeWorkspaces.has(folder)) throw new BackendError('Select a bridge folder before running commands.'); return bridge.call('command', { command, workspace: folder }, signal); };
    this.runtime.webSearch = (query, signal) => bridge.call('webSearch', { query }, signal);
    Object.defineProperty(this.runtime, 'supportedTools', { configurable: true, get: () => TOOL_NAMES.filter(name => name !== 'web_search' && name !== 'run_command' || bridge.connected && (name === 'web_search' || this.bridgeWorkspaces.has(this.state.workspace) && snapshot.grants.commands)) });
    Object.assign(this.runtime.capabilities, { commands: snapshot.grants.commands, web_search: true, workspace: 'paired local workspace' });
    this.bridge = bridge;
    await this.setProject(workspace.root);
  }
  bridgeStatus() { return this.bridge?.connected ? { connected: true, workspace: '/bridge-workspace', grants: this.bridge.snapshot().grants } : { connected: false }; }
  override async setProject(raw: string): Promise<Record<string, unknown>> {
    const folder = raw.trim();
    if (this.bridge?.connected && !this.projects.has(folder)) return this.selectBridgeProject(folder);
    return super.setProject(raw);
  }
  async selectBridgeProject(raw: string): Promise<Record<string, unknown>> {
    if (!this.bridge?.connected) throw new BackendError('Pair a bridge before choosing a native folder.');
    const folder = raw.trim();
    this.idle('changing projects');
    const bridge = this.bridge, generation = this.bridgeGeneration;
    let snapshot;
    try { snapshot = await bridge.selectProject(folder); }
    catch { throw new BackendError(`'${folder}' does not exist or could not be opened through the bridge. Choose an absolute native directory path.`); }
    this.idle('changing projects');
    if (generation !== this.bridgeGeneration || !bridge.connected) throw new BackendError('Folder selection cancelled by bridge disconnection.');
    const workspace = new BridgeWorkspace(bridge, snapshot.project.root);
    this.bridgeWorkspaces.set(workspace.root, workspace); this.projects.set(workspace.root, workspace.project);
    return super.setProject(workspace.root);
  }
  async browseProject(raw: string, native = false): Promise<{ path: string; parent: string | null; folders: string[] }> {
    if (native || this.bridgeWorkspaces.has(this.state.workspace)) {
      if (!this.bridge?.connected) throw new BackendError('Pair a bridge before choosing a native folder.');
      const path = this.bridgeWorkspaces.has(raw) ? this.bridge.snapshot(raw).workspace ?? '' : native && this.projects.has(raw) ? '' : raw;
      return this.bridge.call('browse', { path });
    }
    return this.browse(raw);
  }
  async detachBridge(): Promise<void> {
    this.idle('unpairing a bridge');
    this.bridgeGeneration++;
    if (!this.bridgeRestore) return;
    const previous = this.bridgeRestore, bridge = this.bridge!;
    Object.defineProperty(this.runtime, 'supportedTools', { configurable: true, enumerable: true, writable: true, value: previous.runtime.supportedTools });
    Object.assign(this.runtime, previous.runtime);
    if (!previous.runtime.webSearch) delete this.runtime.webSearch;
    this.bridge = undefined; this.bridgeRestore = undefined;
    const selected = this.bridgeWorkspaces.has(this.state.workspace);
    for (const root of this.bridgeWorkspaces.keys()) this.projects.delete(root);
    this.bridgeWorkspaces.clear();
    try { if (selected) await this.setProject(previous.workspace); }
    finally { await bridge.close(); }
  }
  async bridgeHeartbeat(): Promise<void> { await this.bridge?.heartbeat(); }
  override async lockCredentials(): Promise<void> {
    await super.lockCredentials();
    this.mcpConfig.value = undefined;
    await this.bridge?.close();
    this.router.clearKeys();
  }
  override async close(): Promise<void> {
    await this.lockCredentials(); await super.close();
  }

  /** Managed experiment owns its storage; ordinary SDK callers retain their injected store. */
  closeStorage(): void { this.browser.storage.close(); }

  /** Validates and stores an MCP configuration, then reconnects. Header values are not persisted. */
  override async configureMcp(value: unknown): Promise<Record<string, unknown>> {
    this.idle('configuring MCP servers');
    try { parseConfig(value); } catch (error) { throw new BackendError((error as Error).message); }
    const stored = structuredClone(value) as { mcpServers?: Record<string, unknown> };
    for (const server of Object.values(stored.mcpServers ?? {})) if (isObject(server)) delete server.headers;
    await this.browser.storage.put('settings', 'mcp-config', stored);
    this.mcpConfig.value = value;
    return this.reloadMcp();
  }

  override async bootstrap(): Promise<Record<string, unknown>> {
    return { ...await super.bootstrap(), bridge: this.bridgeStatus(), workspace_kind: this.bridgeWorkspaces.has(this.state.workspace) ? 'paired local workspace' : this.projects.get(this.state.workspace)?.handle ? 'local folder (direct disk access)' : 'virtual workspace (browser storage)', ollama_url: await this.browser.storage.get<string>('settings', 'ollama-url') ?? 'http://localhost:11434' };
  }

  async listModels(raw: ModelConfiguration): Promise<ModelOption[]> {
    const value = modelConfiguration(raw as Record<string, unknown>), provider = providerName(value.provider ?? value.mode!);
    if (provider === 'ollama') {
      const url = new URL(value.url ?? await this.browser.storage.get<string>('settings', 'ollama-url') ?? 'http://localhost:11434');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BackendError('Use an HTTP(S) Ollama URL without credentials.');
      return new OllamaAdapter(fetch, url.href.replace(/\/$/, '')).listModels();
    }
    const adapter = this.router.adapter(provider, value.apiKey);
    if (adapter instanceof CloudAdapter) return adapter.listModels();
    throw new BackendError('Choose a real model provider to list models.');
  }

  async importProject(value: unknown): Promise<Record<string, unknown>> {
    this.idle('importing a project');
    const data = value as Partial<Project> | null;
    if (!data || data.format !== 'myharness-project' || data.version !== 1 || typeof data.root !== 'string' || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) throw new BackendError('Choose a valid myharness project JSON export.');
    const project = projectFromFiles(data.root, data.files);
    if (project.root === '/') throw new BackendError('Choose a project name below /, such as /my-project.');
    const store = new BrowserSessions(this.browser.storage);
    if (data.sessions !== undefined && !Array.isArray(data.sessions)) throw new BackendError('Project sessions must be an array.');
    const records = (data.sessions ?? []).map(value => structuredClone(store.validate(value)));
    if (records.some(record => record.workspace !== project.root) || new Set(records.map(record => record.id)).size !== records.length) throw new BackendError('Project sessions must have unique IDs and belong to this project.');
    if (data.active_session_id !== undefined && !records.some(record => record.id === data.active_session_id)) throw new BackendError('The active session must belong to this project.');
    await this.browser.storage.put('projects', project.root, project); this.projects.set(project.root, project);
    const result = await this.setProject(project.root);
    let activeId: string | undefined;
    for (const record of records) {
      const imported = await this.importSession(record);
      if (record.id === data.active_session_id) activeId = imported.id;
    }
    if (activeId) await this.activateSession(activeId);
    return result;
  }
  async attachLocalFolder(handle: LocalDirectory): Promise<Record<string, unknown>> {
    this.idle('opening a local folder');
    if (handle.kind !== 'directory' || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new BackendError('Choose a local directory and grant read/write access.');
    const project: StoredProject = { ...projectFromFiles('/local-' + handle.name, {}), handle };
    await new LocalWorkspace(project, handle).refresh();
    await this.browser.storage.put('projects', project.root, project); this.projects.set(project.root, project);
    return this.setProject(project.root);
  }
  async exportProject(): Promise<Project> {
    const stored = this.projects.get(this.state.workspace);
    if (!stored) throw new BackendError('Choose a replacement project before exporting.');
    const { handle, ...project } = stored;
    if (handle || this.bridgeWorkspaces.has(project.root)) {
      const workspace = handle ? new LocalWorkspace(project, handle) : new BridgeWorkspace(this.bridge!, project.root); await workspace.refresh();
      for (const name of Object.keys(project.files)) project.files[name] = await workspace.readText(name);
    }
    const active = this.activeSessionRecord();
    return structuredClone({ ...project,
      sessions: (await this.listSessions()).map(record => record.id === active.id ? active : record).filter(record => record.workspace === project.root),
      active_session_id: active.id,
    });
  }
  browse(raw: string): { path: string; parent: string | null; folders: string[] } {
    const folder = absolutePath(raw);
    if (folder === '/') return { path: '/', parent: null, folders: [...this.projects.keys()].map(root => root.slice(1)).sort() };
    const project = [...this.projects.values()].find(project => folder === project.root || folder.startsWith(project.root + '/'));
    if (!project) throw new BackendError(`'${raw}' is not a virtual folder`);
    const workspace = new BrowserWorkspace(project, async () => {});
    if (!workspace.isDirectory(folder)) throw new BackendError(`'${raw}' is not a virtual folder`);
    const prefix = workspace.relative(folder);
    const folders = workspace.project.directories.filter(name => name !== prefix && name.startsWith(prefix ? prefix + '/' : '')).map(name => name.slice(prefix ? prefix.length + 1 : 0)).filter(name => !name.includes('/')).sort();
    return { path: folder, parent: folder === project.root ? '/' : folder.slice(0, folder.lastIndexOf('/')), folders };
  }
  protected override async saveModelEndpoint(url: string): Promise<void> { await this.browser.storage.put('settings', 'ollama-url', url); }
}

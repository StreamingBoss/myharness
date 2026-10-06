import { CloudAdapter } from '../cloud.js';
import type { ModelOption } from '../model.js';
import { ProviderRouter, modelConfiguration, providerName, type ModelConfiguration } from '../providers.js';
import { DemoModel } from './demo.js';
import { Harness, BackendError, type ModelPort } from '../harness.js';
import { TOOL_NAMES } from '../tools.js';
import { BrowserStorage } from './storage.js';
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
  storage: BrowserStorage; library: Library; seed: Record<string, string>;
  modelPort?: ModelPort; model?: string; contextLength?: number; approvalTimeoutMs?: number;
  mcpTimeouts?: { connectTimeoutMs?: number; probeTimeoutMs?: number };
}
/** MCP configuration with header values; header values live only in Worker memory. */
interface McpConfigHolder { value?: unknown }

/** Complete browser backend. It runs directly or in a Worker, without a page. */
export class BrowserHarness extends Harness {
  private constructor(private readonly browser: BrowserOptions, private readonly projects: Map<string, StoredProject>, workspace: string, private readonly router: ProviderRouter, private readonly mcpConfig: McpConfigHolder = {}) {
    super({ workspace, model: browser.model ?? 'qwen3:8b', contextLength: browser.contextLength ?? 8192,
      ...(browser.modelPort ? { ollama: browser.modelPort } : { modelAdapter: router }), sessions: new BrowserSessions(browser.storage),
      ...(browser.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: browser.approvalTimeoutMs }), ...(browser.mcpTimeouts ? { mcpTimeouts: browser.mcpTimeouts } : {}), runtime: {
        name: 'browser', supportedTools: TOOL_NAMES.filter(name => name !== 'run_command' && name !== 'web_search'),
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
        },
      } });
  }

  static async open(options: BrowserOptions): Promise<BrowserHarness> {
    const projects = new Map((await options.storage.all<StoredProject>('projects')).map(project => [project.root, project]));
    if (!projects.size) { const project = projectFromFiles('/workspace', options.seed); await options.storage.put('projects', project.root, project); projects.set(project.root, project); }
    const saved = await options.storage.get<string>('settings', 'workspace');
    const workspace = saved && projects.has(saved) ? saved : projects.keys().next().value!;
    const url = await options.storage.get<string>('settings', 'ollama-url');
    const router = new ProviderRouter(fetch, { demo: new DemoModel(), ollama: new OllamaAdapter(fetch, url ?? 'http://localhost:11434') }, options.model === DEMO_MODEL ? 'demo' : 'ollama');
    const harness = new BrowserHarness(options, projects, workspace, router);
    await harness.initialize();
    return harness;
  }

  /** Validates and stores an MCP configuration, then reconnects. Header values are not persisted. */
  async configureMcp(value: unknown): Promise<Record<string, unknown>> {
    this.idle('configuring MCP servers');
    try { parseConfig(value); } catch (error) { throw new BackendError((error as Error).message); }
    const stored = structuredClone(value) as { mcpServers?: Record<string, unknown> };
    for (const server of Object.values(stored.mcpServers ?? {})) if (isObject(server)) delete server.headers;
    await this.browser.storage.put('settings', 'mcp-config', stored);
    this.mcpConfig.value = value;
    return this.reloadMcp();
  }

  override async bootstrap(): Promise<Record<string, unknown>> {
    return { ...await super.bootstrap(), workspace_kind: this.projects.get(this.state.workspace)?.handle ? 'local folder (direct disk access)' : 'virtual workspace (browser storage)', ollama_url: await this.browser.storage.get<string>('settings', 'ollama-url') ?? 'http://localhost:11434' };
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
    if (handle) {
      const workspace = new LocalWorkspace(project, handle); await workspace.refresh();
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

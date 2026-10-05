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

export interface BrowserOptions {
  storage: BrowserStorage; library: Library; seed: Record<string, string>;
  modelPort?: ModelPort; model?: string; contextLength?: number; approvalTimeoutMs?: number;
}

/** Complete browser backend. It runs directly or in a Worker, without a page. */
export class BrowserHarness extends Harness {
  private constructor(private readonly browser: BrowserOptions, private readonly projects: Map<string, StoredProject>, workspace: string, private readonly router: BrowserModel) {
    super({ workspace, model: browser.model ?? DEMO_MODEL, contextLength: browser.contextLength ?? 4096,
      ollama: browser.modelPort ?? router, sessions: new BrowserSessions(browser.storage),
      ...(browser.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: browser.approvalTimeoutMs }), runtime: {
        name: 'browser', supportedTools: TOOL_NAMES.filter(name => name !== 'run_command'),
        capabilities: { workspace: 'virtual text files or user-granted local folder', commands: false, persistence: 'IndexedDB', inference: 'scripted demo or external Ollama' },
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
      } });
  }

  static async open(options: BrowserOptions): Promise<BrowserHarness> {
    const projects = new Map((await options.storage.all<StoredProject>('projects')).map(project => [project.root, project]));
    if (!projects.size) { const project = projectFromFiles('/workspace', options.seed); await options.storage.put('projects', project.root, project); projects.set(project.root, project); }
    const saved = await options.storage.get<string>('settings', 'workspace');
    const workspace = saved && projects.has(saved) ? saved : projects.keys().next().value!;
    const url = await options.storage.get<string>('settings', 'ollama-url');
    const router = new BrowserModel(new OllamaAdapter(fetch, url ?? 'http://localhost:11434'));
    const harness = new BrowserHarness(options, projects, workspace, router);
    await harness.initialize();
    return harness;
  }

  override async bootstrap(): Promise<Record<string, unknown>> {
    return { ...await super.bootstrap(), workspace_kind: this.projects.get(this.state.workspace)?.handle ? 'local folder (direct disk access)' : 'virtual workspace (browser storage)', ollama_url: await this.browser.storage.get<string>('settings', 'ollama-url') ?? 'http://localhost:11434' };
  }

  async importProject(value: unknown): Promise<Record<string, unknown>> {
    this.idle('importing a project');
    const data = value as Partial<Project> | null;
    if (!data || data.format !== 'myharness-project' || data.version !== 1 || typeof data.root !== 'string' || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) throw new BackendError('Choose a valid myharness project JSON export.');
    const project = projectFromFiles(data.root, data.files);
    if (project.root === '/') throw new BackendError('Choose a project name below /, such as /my-project.');
    await this.browser.storage.put('projects', project.root, project); this.projects.set(project.root, project);
    return this.setProject(project.root);
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
    return structuredClone(project);
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
  async configureModel(value: { mode: string; model?: string; url?: string }): Promise<void> {
    this.idle('changing models');
    let model = DEMO_MODEL, context = 4096;
    if (value.mode === 'ollama') {
      const url = new URL(value.url ?? 'http://localhost:11434');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BackendError('Use an HTTP(S) Ollama URL without credentials.');
      model = value.model?.trim() || 'qwen3:8b';
      const endpoint = url.href.replace(/\/$/, ''), adapter = new OllamaAdapter(fetch, endpoint);
      try { context = await adapter.contextLength(model); }
      catch (error) { throw new BackendError(`Could not connect to Ollama: ${(error as Error).message}. Check the URL, model and OLLAMA_ORIGINS for this page's origin.`); }
      this.idle('changing models');
      await this.browser.storage.put('settings', 'ollama-url', endpoint); this.router.ollama = adapter;
    } else if (value.mode !== 'demo') throw new BackendError('Choose demo or ollama.');
    this.idle('changing models');
    this.state.model = model; this.state.contextLength = context;
    await this.newSession();
  }
}

import path from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Harness, BackendError, type HarnessOptions as SharedOptions } from '../harness.js';
import { Catalog } from './catalog.js';
import { WorkspaceAdapter } from './workspace.js';
import { OllamaAdapter } from './ollama.js';
import { executeCommand } from './commands.js';
import { StdioChannel } from './mcp-stdio.js';
import { NodeGit } from './git.js';
import { GIT_TOOLS, TOOL_NAMES } from './tools.js';
import { ProviderRouter } from '../providers.js';
import { json } from '../format.js';
import { webSearch } from '../websearch.js';
export { BackendError } from '../harness.js';
export type { TurnAction, HarnessState, ModelPort } from '../harness.js';
export type HarnessOptions = Omit<SharedOptions, 'runtime' | 'saveHarnessSettings'> & { /** MCP configuration file; never read from the project folder. */ mcpConfigFile?: string };

/** Node capabilities for the shared backend; no UI or Worker dependencies. */
export class NodeHarness extends Harness {
  constructor(options: HarnessOptions) {
    super({ ...options, ...(!options.ollama && !options.modelAdapter ? { modelAdapter: new ProviderRouter(fetch, { ollama: new OllamaAdapter(fetch, 'http://localhost:11434') }) } : {}), runtime: {
      name: 'Node', supportedTools: TOOL_NAMES,
      capabilities: { workspace: 'local filesystem', commands: true, web_search: 'DuckDuckGo (no key)', persistence: 'session JSON files' },
      workspace: folder => new WorkspaceAdapter(folder),
      catalog: workspace => new Catalog(options.projectRoot ?? process.cwd(), workspace as WorkspaceAdapter),
      resolveProject(raw) {
        if (/^.:/.test(raw)) throw new BackendError('use a WSL path: C:\\code\\x is /mnt/c/code/x');
        return path.resolve(raw.replace(/^~(?=\/|$)/, homedir()));
      },
      async saveProject(folder) { if (options.settingsFile) await writeSettings(options.settingsFile, { project: folder }); },
      executeCommand: (command, workspace, signal) => executeCommand(command, workspace, signal, options.commandTimeoutMs),
      webSearch: (query, signal) => webSearch(fetch, query, signal),
      unavailable: Object.fromEntries(GIT_TOOLS.map(name => [name, 'the project folder has no .git directory'])),
      git: (workspace, signal) => existsSync(path.join(workspace.root, '.git')) ? new NodeGit(workspace.root, signal) : undefined,
      mcp: {
        source: options.mcpConfigFile ?? '(no MCP configuration file)', fetch, environment: process.env,
        stdio: config => new StdioChannel(config, options.projectRoot ?? process.cwd()),
        async saveConfig(value) {
          const file = options.mcpConfigFile;
          if (!file) throw new Error('No MCP configuration file is configured');
          const temporary = `${file}.${crypto.randomUUID()}.tmp`;
          try {
            await writeFile(temporary, json(value, 2) + '\n', { mode: 0o600 });
            await rename(temporary, file);
          } finally { await rm(temporary, { force: true }); }
        },
        async loadConfig() {
          const file = options.mcpConfigFile;
          if (!file || !existsSync(file)) return undefined;
          try { return JSON.parse(await readFile(file, 'utf8')); }
          catch (error) { throw new Error(`${file}: ${(error as Error).message}`); }
        },
      },
    }, saveHarnessSettings: async settings => { if (options.settingsFile) await writeSettings(options.settingsFile, settings); } });
  }
}

async function writeSettings(file: string, change: Record<string, unknown>): Promise<void> {
  const persist = async () => {
    const existing = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> : {};
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await writeFile(temporary, json({ ...existing, ...change }, 2) + '\n', { mode: 0o600 }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  };
  const next = (settingsWrites.get(file) ?? Promise.resolve()).then(persist, persist);
  settingsWrites.set(file, next); await next;
}
const settingsWrites = new Map<string, Promise<void>>();

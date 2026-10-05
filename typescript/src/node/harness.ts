import path from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Harness, BackendError, type HarnessOptions as SharedOptions } from '../harness.js';
import { Catalog } from './catalog.js';
import { WorkspaceAdapter } from './workspace.js';
import { OllamaAdapter } from './ollama.js';
import { executeCommand } from './commands.js';
import { StdioChannel } from './mcp-stdio.js';
import { TOOL_NAMES } from './tools.js';
import { ProviderRouter } from '../providers.js';
import { json } from '../format.js';
export { BackendError } from '../harness.js';
export type { TurnAction, HarnessState, ModelPort } from '../harness.js';
export type HarnessOptions = Omit<SharedOptions, 'runtime'> & { /** MCP configuration file; never read from the project folder. */ mcpConfigFile?: string };

/** Node capabilities for the shared backend; no UI or Worker dependencies. */
export class NodeHarness extends Harness {
  constructor(options: HarnessOptions) {
    super({ ...options, ...(!options.ollama && !options.modelAdapter ? { modelAdapter: new ProviderRouter(fetch, { ollama: new OllamaAdapter(fetch, 'http://localhost:11434') }) } : {}), runtime: {
      name: 'Node', supportedTools: TOOL_NAMES,
      capabilities: { workspace: 'local filesystem', commands: true, persistence: 'session JSON files' },
      workspace: folder => new WorkspaceAdapter(folder),
      catalog: workspace => new Catalog(options.projectRoot ?? process.cwd(), workspace as WorkspaceAdapter),
      resolveProject(raw) {
        if (/^.:/.test(raw)) throw new BackendError('use a WSL path: C:\\code\\x is /mnt/c/code/x');
        return path.resolve(raw.replace(/^~(?=\/|$)/, homedir()));
      },
      async saveProject(folder) { if (options.settingsFile) await writeFile(options.settingsFile, json({ project: folder }, 2) + '\n'); },
      executeCommand: (command, workspace, signal) => executeCommand(command, workspace, signal, options.commandTimeoutMs),
      mcp: {
        source: options.mcpConfigFile ?? '(no MCP configuration file)', fetch, environment: process.env,
        stdio: config => new StdioChannel(config, options.projectRoot ?? process.cwd()),
        async loadConfig() {
          const file = options.mcpConfigFile;
          if (!file || !existsSync(file)) return undefined;
          try { return JSON.parse(await readFile(file, 'utf8')); }
          catch (error) { throw new Error(`${file}: ${(error as Error).message}`); }
        },
      },
    } });
  }
}

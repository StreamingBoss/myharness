import type { Agent, Skill } from './catalog.js';
import type { McpRuntime } from './mcp/manager.js';
import type { GitPort } from './git.js';

/** Runtime capabilities; the shared backend never imports OS or browser APIs. */
export interface WorkspacePort {
  readonly root: string;
  refresh(): Promise<void>;
  pathFor(input: string): string;
  relative(path: string): string;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  listFiles(input?: string): Promise<string>;
  readNumbered(input: string, start?: number, end?: number): Promise<string>;
  findFiles(pattern: string): Promise<string>;
  search(pattern: string, input?: string, glob?: string): Promise<string>;
  edit(input: string, oldText: string, newText: string): Promise<{ path: string; content: string; note?: string }>;
  /** Deletes one file. */
  remove(path: string): Promise<void>;
  /** Moves one file to a path that does not exist yet, creating folders as needed. */
  move(from: string, to: string): Promise<void>;
}
export interface CatalogPort {
  agents(): Record<string, Agent>;
  prompts(): Record<string, string>;
  skills(): Record<string, Skill>;
  projectInstructions(): [string, string] | null;
}
export interface RuntimePort {
  readonly name: string;
  readonly supportedTools: string[];
  readonly capabilities: Record<string, unknown>;
  workspace(folder: string): WorkspacePort;
  catalog(workspace: WorkspacePort): CatalogPort;
  resolveProject(raw: string): string;
  saveProject(folder: string): Promise<void>;
  executeCommand(command: string, workspace: string, signal: AbortSignal): Promise<{ output: string; status: string }>;
  /** Git for the project folder, or undefined when this runtime or folder has none. The git tools are offered only with it. */
  git?(workspace: WorkspacePort, signal: AbortSignal): GitPort | undefined;
  /** Why a built-in tool is not offered, for clients that want to explain it. */
  readonly unavailable?: Record<string, string>;
  /** Web search for the `web_search` tool, returning text for the model. Without it the tool is unsupported. */
  webSearch?(query: string, signal: AbortSignal): Promise<string>;
  /** MCP transports and configuration. Without it, MCP is reported as unsupported. */
  readonly mcp?: McpRuntime;
}

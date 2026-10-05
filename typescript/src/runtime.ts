import type { Agent, Skill } from './catalog.js';
import type { McpRuntime } from './mcp/manager.js';

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
  /** MCP transports and configuration. Without it, MCP is reported as unsupported. */
  readonly mcp?: McpRuntime;
}

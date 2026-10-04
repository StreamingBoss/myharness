import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { HarnessCore, type ChatMessage, type CoreEvent, type ModelRequest, type ToolDefinition, type ToolResult, type Turn, type TurnHost } from "../core.js";
import { OllamaAdapter } from "./ollama.js";
import { WorkspaceAdapter } from "./workspace.js";

export interface TurnAction {
  message: string;
  useMemory: boolean;
  tools: string[];
  askApproval: boolean;
  agent: string;
  prompt: string;
}

export interface HarnessState {
  model: string;
  contextLength: number;
  lastPromptTokens: number;
  memory: ChatMessage[];
  workspace: string;
  stopped: boolean;
}

export interface ModelPort {
  streamChat(payload: ModelRequest): AsyncIterable<string>;
}

const TOOL_NAMES = ["get_current_time", "pwd", "list_files", "read_file", "write_file"];
const tools: ToolDefinition[] = TOOL_NAMES.map((name) => ({
  type: "function", function: { name, description: name, parameters: {} },
}));

/** Node host for the shared core. HTTP and CLI adapters call this public API. */
export class NodeHarness implements TurnHost {
  readonly maxSteps = 20;
  readonly state: HarnessState;
  private readonly workspace: WorkspaceAdapter;
  private readonly modelPort: ModelPort;
  private readonly approvals = new Map<string, (approved: boolean) => void>();
  private currentAskApproval = true;
  private running = false;

  constructor(options: { workspace: string; model: string; contextLength: number; ollama?: ModelPort }) {
    this.workspace = new WorkspaceAdapter(options.workspace);
    this.modelPort = options.ollama ?? new OllamaAdapter(fetch, "http://localhost:11434");
    this.state = { model: options.model, contextLength: options.contextLength, lastPromptTokens: 0,
      memory: [], workspace: this.workspace.root, stopped: false };
  }

  inspect(): HarnessState { return { ...this.state, memory: structuredClone(this.state.memory) }; }
  reset(): void { this.state.memory.length = 0; this.state.lastPromptTokens = 0; }
  stop(): void { this.state.stopped = true; }
  approve(id: string, approved: boolean): boolean {
    const resolve = this.approvals.get(id);
    if (!resolve) return false;
    this.approvals.delete(id);
    resolve(approved);
    return true;
  }

  async *submit(action: TurnAction): AsyncGenerator<CoreEvent> {
    if (this.running) throw new Error("A turn is already running.");
    this.running = true;
    this.state.stopped = false;
    this.currentAskApproval = action.askApproval;
    const userMessage: ChatMessage = { role: "user", content: action.message };
    const conversation = action.useMemory ? this.state.memory : [userMessage];
    if (action.useMemory) conversation.push(userMessage);
    const turn: Turn = { userMessage, conversation, setup: { agent: action.agent, prompt: action.prompt },
      enabledTools: action.tools.filter((name) => TOOL_NAMES.includes(name)),
      selectedTools: tools.filter((tool) => action.tools.includes(tool.function.name)), useMemory: action.useMemory };
    try {
      for await (const event of new HarnessCore(this).runTurn(turn)) yield event;
    } finally {
      this.running = false;
    }
  }

  stopped(): boolean { return this.state.stopped; }
  model(): string { return this.state.model; }
  contextLength(): number { return this.state.contextLength; }
  lastPromptTokens(): number { return this.state.lastPromptTokens; }
  setLastPromptTokens(value: number): void { this.state.lastPromptTokens = value; }
  memoryText(): string { return JSON.stringify(this.state.memory); }
  systemMessages(setup: Turn["setup"]): ChatMessage[] { return setup.prompt ? [{ role: "system", content: setup.prompt }] : []; }
  estimateTokens(system: ChatMessage[], conversation: ChatMessage[], definitions: ToolDefinition[]): number {
    return Math.ceil(JSON.stringify([...system, ...conversation, ...definitions]).length / 4);
  }
  trimContext(): CoreEvent | undefined { return undefined; }
  async *compactContext(): AsyncGenerator<CoreEvent> { return; }
  streamChat(payload: ModelRequest): AsyncIterable<string> { return this.modelPort.streamChat(payload); }
  splitJson(shown: unknown, highlighted: unknown): string[] { return [JSON.stringify(shown), JSON.stringify(highlighted), ""]; }
  skillContext(): Record<string, unknown> { return {}; }
  recordEvent(_event: CoreEvent): void {}

  async runTool(name: string, arguments_: Record<string, unknown>, enabled: string[]): Promise<ToolResult> {
    if (!enabled.includes(name)) return { kind: "text", text: `error: unknown tool '${name}'` };
    if (name === "get_current_time") return { kind: "text", text: new Date().toISOString() };
    if (name === "pwd") return { kind: "text", text: this.workspace.root };
    if (name === "list_files") return { kind: "text", text: await this.workspace.listFiles(this.stringArgument(arguments_, "path", ".")) };
    if (name === "read_file") return { kind: "text", text: await this.workspace.readNumbered(this.stringArgument(arguments_, "path"), this.numberArgument(arguments_, "start_line", 1), this.optionalNumber(arguments_, "end_line")) };
    if (name === "write_file") return { kind: "change", change: { path: this.stringArgument(arguments_, "path"), content: this.stringArgument(arguments_, "content") } };
    return { kind: "text", text: `error: unknown tool '${name}'` };
  }

  async *applyChange(_name: string, change: unknown): AsyncGenerator<CoreEvent, string, void> {
    const value = change as { path: string; content: string };
    const target = this.workspace.pathFor(value.path);
    const relative = path.relative(this.workspace.root, target);
    const apply = async (): Promise<string> => {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, value.content, "utf8");
      return `ok: updated '${relative}'`;
    };
    if (!this.currentAskApproval) {
      const result = await apply();
      yield { type: "change", path: relative, approved: true, diff: "", note: "" };
      return result;
    }
    const id = crypto.randomUUID();
    const approved = await new Promise<boolean>((resolve) => this.approvals.set(id, resolve));
    yield { type: "change", path: relative, approved, diff: "", note: "" };
    if (this.state.stopped) return "stopped: the user stopped the turn before this tool ran";
    if (!approved) return "refused: the user did not approve this change. Ask them what to do instead.";
    return apply();
  }

  async *executeCommand(): AsyncGenerator<CoreEvent, string, void> {
    yield { type: "command", approved: false, output: "", status: "unsupported by this Node-host increment" };
    return "error: run_command is not yet available in the Node host";
  }

  private stringArgument(arguments_: Record<string, unknown>, name: string, fallback?: string): string {
    const value = arguments_[name] ?? fallback;
    if (typeof value !== "string") throw new Error(`error: bad arguments for '${name}'`);
    return value;
  }
  private numberArgument(arguments_: Record<string, unknown>, name: string, fallback: number): number {
    const value = arguments_[name] ?? fallback;
    if (!Number.isInteger(value)) throw new Error(`error: bad arguments for '${name}'`);
    return value as number;
  }
  private optionalNumber(arguments_: Record<string, unknown>, name: string): number | undefined {
    const value = arguments_[name];
    if (value === undefined) return undefined;
    if (!Number.isInteger(value)) throw new Error(`error: bad arguments for '${name}'`);
    return value as number;
  }
}

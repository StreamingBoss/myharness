/** Transport-free agent loop shared by Node and a future browser host. */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  function: { name: string; arguments?: Record<string, unknown> };
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  tool_name?: string;
  tool_calls?: ToolCall[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelChunk {
  message: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: ToolCall[];
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  stream: true;
  options: { num_ctx: number };
}

export interface CoreEvent {
  type: string;
  [field: string]: unknown;
}

export interface Turn {
  userMessage: ChatMessage;
  conversation: ChatMessage[];
  setup: { agent: string; prompt: string };
  enabledTools: string[];
  selectedTools: ToolDefinition[];
  useMemory: boolean;
  manualSkill?: string;
}

export type ToolResult =
  | { kind: "text"; text: string }
  | { kind: "change"; change: unknown }
  | { kind: "command"; command: string };

/** Runtime boundary. No Node, browser, HTTP, or UI types appear in this API. */
export interface TurnHost {
  readonly maxSteps: number;
  stopped(): boolean;
  model(): string;
  contextLength(): number;
  lastPromptTokens(): number;
  setLastPromptTokens(value: number): void;
  memoryText(): string;
  systemMessages(setup: Turn["setup"], withSkills: boolean): ChatMessage[];
  estimateTokens(system: ChatMessage[], conversation: ChatMessage[], tools: ToolDefinition[]): number;
  trimContext(system: ChatMessage[], conversation: ChatMessage[], tools: ToolDefinition[]): CoreEvent | undefined;
  compactContext(conversation: ChatMessage[]): AsyncIterable<CoreEvent>;
  streamChat(payload: ModelRequest): AsyncIterable<string>;
  splitJson(shown: unknown, highlighted: unknown): string[];
  skillContext(context: ChatMessage[]): Record<string, unknown>;
  runTool(name: string, toolArguments: Record<string, unknown>, enabled: string[]): Promise<ToolResult>;
  applyChange(name: string, change: unknown): AsyncGenerator<CoreEvent, string, void>;
  executeCommand(command: string): AsyncGenerator<CoreEvent, string, void>;
  recordEvent(event: CoreEvent): void;
}

export const STOPPED_RESULT = "stopped: the user stopped the turn before this tool ran";
const MARKER = "@@HIGHLIGHT@@";

export class HarnessCore {
  constructor(private readonly host: TurnHost) {}

  async *runTurn(turn: Turn): AsyncGenerator<CoreEvent> {
    if (turn.manualSkill) {
      yield this.emit({ type: "skill", name: turn.manualSkill });
    }

    let compactAttempted = false;
    for (let step = 0; step < this.host.maxSteps; step += 1) {
      const system = this.host.systemMessages(turn.setup, turn.enabledTools.includes("use_skill"));
      if (turn.useMemory) {
        const estimated = this.host.estimateTokens(system, turn.conversation, turn.selectedTools);
        const pressure = Math.max(this.host.lastPromptTokens(), estimated);
        if (pressure >= this.host.contextLength() * 0.75) {
          const trimmed = this.host.trimContext(system, turn.conversation, turn.selectedTools);
          if (trimmed) yield this.emit(trimmed);
        }
        if (pressure >= this.host.contextLength() * 0.9 && !compactAttempted) {
          compactAttempted = true;
          for await (const event of this.host.compactContext(turn.conversation)) {
            yield this.emit({ ...event, skill_context: this.host.skillContext([...system, ...turn.conversation]) });
          }
        }
        if (this.host.stopped()) {
          yield this.emit(this.stoppedEvent());
          return;
        }
        if (this.host.estimateTokens(system, turn.conversation, turn.selectedTools) >= this.host.contextLength()) {
          yield this.emit({ type: "stopped", reason: "context full: use Compact or Reset memory", memory: this.host.memoryText() });
          return;
        }
      }

      const payload: ModelRequest = {
        model: this.host.model(), messages: [...system, ...turn.conversation], stream: true,
        options: { num_ctx: this.host.contextLength() },
        ...(turn.selectedTools.length ? { tools: turn.selectedTools } : {}),
      };
      const shown = {
        ...payload,
        messages: payload.messages.map((message) => message === turn.userMessage ? MARKER : message),
      };
      yield this.emit({
        type: "request", parts: this.host.splitJson(shown, turn.userMessage), memory: this.host.memoryText(),
        skill_context: this.host.skillContext([...system, ...turn.conversation]),
      });

      const reply: string[] = [];
      const thinking: string[] = [];
      const toolCalls: ToolCall[] = [];
      let finalChunk: ModelChunk = { message: {} };
      for await (const raw of this.host.streamChat(payload)) {
        if (this.host.stopped()) break;
        const chunk = JSON.parse(raw) as ModelChunk;
        finalChunk = chunk;
        const content = chunk.message.content ?? "";
        const thought = chunk.message.thinking ?? "";
        reply.push(content);
        thinking.push(thought);
        toolCalls.push(...(chunk.message.tool_calls ?? []));
        if (thought) yield this.emit({ type: "thinking", content: thought });
        if (!chunk.done) yield this.emit({ type: "chunk", content });
      }

      const answer = reply.join("");
      if (this.host.stopped()) {
        if (answer) turn.conversation.push({ role: "assistant", content: answer });
        yield this.emit(this.stoppedEvent());
        return;
      }
      const assistant: ChatMessage = { role: "assistant", content: answer, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
      turn.conversation.push(assistant);
      const received: ChatMessage & { thinking?: string } = {
        ...assistant,
        ...(thinking.join("") ? { thinking: thinking.join("") } : {}),
      };
      const tokensIn = finalChunk.prompt_eval_count ?? 0;
      if (turn.useMemory) this.host.setLastPromptTokens(tokensIn);
      const tokensOut = finalChunk.eval_count ?? 0;
      const used = tokensIn + tokensOut;
      yield this.emit({
        type: "response", parts: this.host.splitJson({ ...finalChunk, message: MARKER }, received),
        tokens: `[${tokensIn} in + ${tokensOut} out = ${used} |${used} / ${this.host.contextLength()} ]`,
        tokens_in: tokensIn, context_length: this.host.contextLength(), memory: this.host.memoryText(), content: answer,
      });
      if (!toolCalls.length) return;

      for (const call of toolCalls) {
        const name = call.function.name;
        const arguments_ = call.function.arguments ?? {};
        const result = this.host.stopped()
          ? { kind: "text", text: STOPPED_RESULT } as ToolResult
          : await this.host.runTool(name, arguments_, turn.enabledTools);
        const text = yield* this.resolveToolResult(name, result);
        turn.conversation.push({ role: "tool", tool_name: name, content: text });
        yield this.emit({
          type: "tool", name, arguments: JSON.stringify(arguments_), result: text, memory: this.host.memoryText(),
          skill_context: this.host.skillContext([...system, ...turn.conversation]),
        });
      }
      if (this.host.stopped()) {
        yield this.emit(this.stoppedEvent());
        return;
      }
    }
    yield this.emit({ type: "stopped", reason: `stopped after ${this.host.maxSteps} calls to the model` });
  }

  private emit(event: CoreEvent): CoreEvent {
    this.host.recordEvent(event);
    return event;
  }

  private stoppedEvent(): CoreEvent {
    return { type: "stopped", reason: "stopped by the user", memory: this.host.memoryText() };
  }

  private async *resolveToolResult(name: string, result: ToolResult): AsyncGenerator<CoreEvent, string, void> {
    if (result.kind === "text") return result.text;
    const action = result.kind === "change"
      ? this.host.applyChange(name, result.change)
      : this.host.executeCommand(result.command);
    return yield* this.forwardAction(action);
  }

  private async *forwardAction(action: AsyncGenerator<CoreEvent, string, void>): AsyncGenerator<CoreEvent, string, void> {
    while (true) {
      const next = await action.next();
      if (next.done) return next.value;
      yield this.emit(next.value);
    }
  }
}

import { DiagnosticError, failureDetails, type FailureDetails } from './failure.js';
import { legacyEvents, validateToolBatch, type ModelEvent, type ModelResult } from './model.js';
import { RepeatGuard, type RepeatReminder } from './guard.js';
import { prefixReuse, prefixText, timingSummary, timingText, turnTimelineText, turnTotals, type MeasuredTiming, type RoundTiming } from './timing.js';
/** Transport-free agent loop shared by Node and a future browser host. */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id?: string;
  function: { name: string; arguments?: Record<string, unknown> };
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  tool_name?: string;
  tool_call_id?: string;
  continuation?: { provider: string; items: Record<string, unknown>[] };
  tool_calls?: ToolCall[];
  provider_parts?: Record<string, unknown>[];
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
    provider_parts?: Record<string, unknown>[];
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  /** Ollama durations in nanoseconds. */
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  total_duration?: number;
  /** Prompt tokens Ollama reused from its KV cache instead of computing them again. */
  prompt_eval_cached_count?: number;
  /** Input tokens served from a provider prompt cache, and output tokens spent thinking. */
  cached_count?: number;
  reasoning_count?: number;
}

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  stream: boolean;
  provider?: string;
  options: { num_ctx: number; num_predict?: number };
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

/**
 * How an approval request ended. Only `allowed-once` lets the action run; a refusal, a withdrawn
 * request and a request nobody answered are all denials, but the model is told which one happened.
 */
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export type ToolResult =
  | { kind: "text"; text: string; failure?: FailureDetails }
  | { kind: "change"; change: unknown }
  | { kind: "command"; command: string }
  | { kind: "mcp"; call: unknown }
  /** An effect that is shown and approved first: a file deletion or move, a git change. */
  | { kind: "action"; action: unknown };

/** Runtime boundary. No Node, browser, HTTP, or UI types appear in this API. */
export interface TurnHost {
  readonly maxSteps: number;
  stopped(): boolean;
  stopReason?(): string;
  stoppedToolResult?(): string;
  modelProvider?(): string | undefined;
  maxOutputTokens?(): number | undefined;
  streamModel?(payload: ModelRequest): AsyncIterable<ModelEvent>;
  prepareModel?(payload: ModelRequest): Record<string, unknown> | undefined;
  model(): string;
  contextLength(): number;
  lastPromptTokens(): number;
  setLastPromptTokens(value: number): void;
  memoryText(): string;
  systemMessages(setup: Turn["setup"], withSkills: boolean, enabledTools?: string[]): ChatMessage[];
  estimateTokens(system: ChatMessage[], conversation: ChatMessage[], tools: ToolDefinition[]): number;
  trimContext(system: ChatMessage[], conversation: ChatMessage[], tools: ToolDefinition[]): CoreEvent | undefined;
  compactContext(conversation: ChatMessage[]): AsyncIterable<CoreEvent>;
  streamChat(payload: ModelRequest): AsyncIterable<string>;
  splitJson(shown: unknown, highlighted: unknown): string[];
  skillContext(context: ChatMessage[]): Record<string, unknown>;
  runTool(name: string, toolArguments: Record<string, unknown>, enabled: string[]): Promise<ToolResult>;
  applyChange(name: string, change: unknown): AsyncGenerator<CoreEvent, string, void>;
  executeCommand(command: string): AsyncGenerator<CoreEvent, string, void>;
  /** Asks approval for, then performs, an MCP tool call. */
  executeMcp?(call: unknown): AsyncGenerator<CoreEvent, string, void>;
  /** Asks approval for, then performs, a prepared action. */
  executeAction?(action: unknown): AsyncGenerator<CoreEvent, string, void>;
  recordEvent(event: CoreEvent): void;
  requestMetadata?(payload: ModelRequest): Record<string, unknown>;
  /** Admission/budget boundary before a model request, including runtime-owned autonomous work. */
  beforeModelRequest?(): Promise<void>;
  /** Terminal goal updates close tool admission after the balanced batch. */
  concludesTurn?(): boolean;
  takeContext?(): ChatMessage[];
  /** Monotonic milliseconds, for timing model calls and tools. Without it only provider-reported timing is shown. */
  now?(): number;
  /** The last request sent to the model, kept by the host across turns to show what a prompt cache could reuse. */
  previousRequest?(): ModelRequest | undefined;
  setPreviousRequest?(payload: ModelRequest): void;
}

export type TurnOutcome = 'completed' | 'cancelled' | 'step-limit' | 'context-limit' | 'output-limit' | 'error';

export const STOPPED_RESULT = "stopped: the user stopped the turn before this tool ran";
const MARKER = "@@HIGHLIGHT@@";

export class HarnessCore {
  constructor(private readonly host: TurnHost) {}

  async *runTurn(turn: Turn): AsyncGenerator<CoreEvent, TurnOutcome> {
    const rounds: RoundTiming[] = [];
    const outcome = yield* this.runSteps(turn, rounds);
    // One round is already covered by its TIMING block; the timeline shows how an agent loop's cost grows.
    if (rounds.length > 1) yield this.emit({ type: "turn_timing", rounds, totals: turnTotals(rounds), timeline_text: turnTimelineText(rounds) });
    return outcome;
  }

  private async *runSteps(turn: Turn, rounds: RoundTiming[]): AsyncGenerator<CoreEvent, TurnOutcome> {
    if (turn.manualSkill) {
      yield this.emit({ type: "skill", name: turn.manualSkill });
    }

    let compactAttempted = false;
    const repeats = new RepeatGuard();
    for (let step = 0; step < this.host.maxSteps; step += 1) {
      turn.conversation.push(...(this.host.takeContext?.() ?? []));
      const system = this.host.systemMessages(turn.setup, turn.enabledTools.includes("use_skill"), turn.enabledTools);
      if (turn.useMemory) {
        const estimated = this.host.estimateTokens(system, turn.conversation, turn.selectedTools) + (this.host.maxOutputTokens?.() ?? 0);
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
          return 'cancelled';
        }
        if (this.host.estimateTokens(system, turn.conversation, turn.selectedTools) + (this.host.maxOutputTokens?.() ?? 0) >= this.host.contextLength()) {
          yield this.emit({ type: "stopped", reason: "context full: use Compact or Reset memory", memory: this.host.memoryText() });
          return 'context-limit';
        }
      }

      await this.host.beforeModelRequest?.();
      const payload: ModelRequest = {
        model: this.host.model(), messages: [...system, ...turn.conversation], stream: true,
        options: { num_ctx: this.host.contextLength(), ...(this.host.maxOutputTokens?.() ? { num_predict: this.host.maxOutputTokens()! } : {}) },
        ...(this.host.modelProvider?.() ? { provider: this.host.modelProvider()! } : {}),
        ...(turn.selectedTools.length ? { tools: turn.selectedTools } : {}),
      };
      const shown = {
        ...payload,
        messages: payload.messages.map((message) => message === turn.userMessage ? MARKER : message),
      };
      const prefix = this.host.setPreviousRequest
        ? prefixReuse(this.host.previousRequest?.(), payload, (messages, tools) => this.host.estimateTokens([], messages, tools))
        : undefined;
      this.host.setPreviousRequest?.(payload);
      yield this.emit({
        ...this.host.requestMetadata?.(payload), ...(prefix ? { prefix, prefix_text: prefixText(prefix) } : {}),
        ...(payload.provider ? { model_request: payload } : {}),
        type: "request", parts: this.host.splitJson(this.host.prepareModel?.(payload) ?? shown, turn.userMessage), memory: this.host.memoryText(),
        skill_context: this.host.skillContext([...system, ...turn.conversation]),
      });

      const reply: string[] = [], thoughts: string[] = [];
      const started = this.host.now?.();
      let firstDelta: number | undefined, streamed = false;
      let completed: ModelResult | undefined;
      const stream = this.host.streamModel ? this.host.streamModel(payload) : legacyEvents(this.host.streamChat(payload), () => this.host.stopped());
      for await (const event of stream) {
        if (this.host.stopped()) break;
        if (event.type === 'completed') completed = event.result;
        else {
          if (firstDelta === undefined && started !== undefined) { firstDelta = this.host.now!(); streamed = !event.terminal; }
          reply.push(event.content); thoughts.push(event.thinking);
          if (event.thinking) yield this.emit({ type: 'thinking', content: event.thinking });
          if (!event.terminal) yield this.emit({ type: 'chunk', content: event.content });
        }
      }
      const answer = reply.join("");
      if (this.host.stopped()) {
        if (answer) turn.conversation.push({ role: "assistant", content: answer });
        yield this.emit(this.stoppedEvent());
        return 'cancelled';
      }
      if (!completed) throw new DiagnosticError(failureDetails('Model stream ended without a completed response; no tools were executed.', 'model', this.host.model(), 'Check the provider connection and retry; no tools were executed.'));
      const assistant = completed.message, toolCalls = assistant.tool_calls ?? [];
      if (completed.status !== 'completed') {
        if (assistant.content) turn.conversation.push({ role: 'assistant', content: assistant.content });
        yield this.emit({ type: 'stopped', reason: `Model response ${completed.status}; no tools were executed.`, failure: failureDetails(`Model response ${completed.status}; no tools were executed.`, 'model', this.host.model(), 'Check the provider response and output limit, then retry.'), memory: this.host.memoryText() });
        return completed.status === 'length' ? 'output-limit' : 'error';
      }
      if (payload.provider && !['demo', 'ollama', 'vertex'].includes(payload.provider)) {
        try { validateToolBatch(toolCalls, turn.selectedTools); }
        catch (error) { throw new DiagnosticError(failureDetails(error, 'model', `${payload.provider} / ${this.host.model()}`, 'Retry the request. The model returned an invalid tool proposal; no tools were executed.')); }
      }
      turn.conversation.push(assistant);
      const received = { ...assistant, ...(completed.thinking ? { thinking: completed.thinking } : {}) };
      // A KV cache also holds the tokens just generated, thinking included, so the next request is compared with the reply as generated.
      this.host.setPreviousRequest?.({ ...payload, messages: [...payload.messages, received] });
      const tokensIn = completed.usage.input, tokensOut = completed.usage.output;
      if (turn.useMemory && tokensIn !== undefined) this.host.setLastPromptTokens(tokensIn);
      const used = tokensIn !== undefined && tokensOut !== undefined ? tokensIn + tokensOut : 'unknown';
      const measured: MeasuredTiming | undefined = started === undefined ? undefined : { started, completed: this.host.now!(), streamed, ...(firstDelta === undefined ? {} : { firstDelta }) };
      const timing = timingSummary(completed.usage, completed.timing, measured, completed.thinking || thoughts.join(''), assistant.content + (toolCalls.length ? JSON.stringify(toolCalls) : ''));
      const round: RoundTiming = { round: rounds.length + 1, ...(tokensIn === undefined ? {} : { tokens_in: tokensIn }), ...(tokensOut === undefined ? {} : { tokens_out: tokensOut }),
        ...(timing.wall_ms === undefined ? {} : { wall_ms: timing.wall_ms }), ...(timing.prefill_ms === undefined ? {} : { prefill_ms: timing.prefill_ms }), ...(timing.decode_ms === undefined ? {} : { decode_ms: timing.decode_ms }) };
      rounds.push(round);
      yield this.emit({
        type: 'response', parts: this.host.splitJson({ ...completed.raw, message: MARKER }, received),
        tokens: `[${tokensIn ?? 'unknown'} in + ${tokensOut ?? 'unknown'} out = ${used} |${used} / ${this.host.contextLength()} ]`,
        tokens_in: tokensIn, ...(payload.provider ? { usage: completed.usage } : {}), context_length: this.host.contextLength(), memory: this.host.memoryText(), content: assistant.content,
        round: round.round, timing, timing_text: timingText(timing, prefix),
      });
      if (!toolCalls.length) {
        if (!assistant.content) yield this.emit({ type: 'stopped', reason: 'The model returned an empty reply. Send another message to try again.', failure: failureDetails('The model returned an empty reply.', 'model', this.host.model(), 'Send another message to try again.'), memory: this.host.memoryText() });
        return assistant.content ? 'completed' : 'error';
      }

      const reminders: RepeatReminder[] = [];
      const toolsStarted = this.host.now?.();
      for (const call of toolCalls) {
        const name = call.function.name;
        const arguments_ = call.function.arguments ?? {};
        if (!this.host.stopped()) {
          const reminder = repeats.observe(name, arguments_);
          if (reminder) reminders.push(reminder);
        }
        const result = this.host.stopped()
          ? { kind: "text", text: this.host.stoppedToolResult?.() ?? STOPPED_RESULT } as ToolResult
          : await this.host.runTool(name, arguments_, turn.enabledTools);
        const text = yield* this.resolveToolResult(name, result);
        turn.conversation.push({ role: "tool", tool_name: name, content: text, ...(call.id ? { tool_call_id: call.id } : {}) });
        yield this.emit({
          type: "tool", name, arguments: JSON.stringify(arguments_), result: text, ...(result.kind === "text" && result.failure ? { failure: result.failure } : {}), memory: this.host.memoryText(),
          skill_context: this.host.skillContext([...system, ...turn.conversation]),
        });
      }
      if (toolsStarted !== undefined) round.tool_ms = this.host.now!() - toolsStarted;
      if (this.host.stopped()) {
        yield this.emit(this.stoppedEvent());
        return 'cancelled';
      }
      // Reminders follow the whole tool batch so every tool result stays next to its call.
      for (const reminder of reminders) {
        const content = `[harness reminder] ${reminder.message}`;
        turn.conversation.push({ role: "user", content });
        yield this.emit({ type: "guard", name: "repeat_tool_call", tool: reminder.tool, count: reminder.count, level: reminder.level, content, memory: this.host.memoryText() });
      }
      if (this.host.concludesTurn?.()) return 'completed';
    }
    yield this.emit({ type: "stopped", reason: `stopped after ${this.host.maxSteps} calls to the model` });
    return 'step-limit';
  }

  private emit(event: CoreEvent): CoreEvent {
    this.host.recordEvent(event);
    return event;
  }

  private stoppedEvent(): CoreEvent {
    return { type: "stopped", reason: this.host.stopReason?.() ?? "turn cancelled", memory: this.host.memoryText() };
  }

  private async *resolveToolResult(name: string, result: ToolResult): AsyncGenerator<CoreEvent, string, void> {
    if (result.kind === "text") return result.text;
    const action = result.kind === "change" ? this.host.applyChange(name, result.change)
      : result.kind === "command" ? this.host.executeCommand(result.command)
      : result.kind === "action" ? this.host.executeAction!(result.action)
      : this.host.executeMcp!(result.call);
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

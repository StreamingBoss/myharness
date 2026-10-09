import assert from "node:assert/strict";
import test from "node:test";

import { HarnessCore, type ChatMessage, type CoreEvent, type ModelRequest, type ToolResult, type TurnHost } from "../src/core.js";

class FakeHost implements TurnHost {
  maxSteps = 1;
  readonly events: CoreEvent[] = [];
  readonly memory: ChatMessage[] = [];
  tokenCount = 0;
  context = 100;
  estimate = 1;
  trimmed: CoreEvent | undefined;
  compacted: CoreEvent[] = [];
  chunks: unknown[] = [{ message: { content: "answer" }, done: true, prompt_eval_count: 4, eval_count: 2 }];
  stoppedValue = false;
  stopAfterFirstChunk = false;
  stopAfterTool = false;
  result: ToolResult = { kind: "text", text: "tool output" };

  stopped(): boolean { return this.stoppedValue; }
  model(): string { return "fake"; }
  contextLength(): number { return this.context; }
  lastPromptTokens(): number { return this.tokenCount; }
  setLastPromptTokens(value: number): void { this.tokenCount = value; }
  memoryText(): string { return JSON.stringify(this.memory); }
  systemMessages(): ChatMessage[] { return []; }
  estimateTokens(): number { return this.estimate; }
  trimContext(): CoreEvent | undefined { return this.trimmed; }
  async *compactContext(): AsyncGenerator<CoreEvent> { for (const event of this.compacted) yield event; }
  async *streamChat(_payload: ModelRequest): AsyncGenerator<string> {
    for (const chunk of this.chunks) {
      yield JSON.stringify(chunk);
      if (this.stopAfterFirstChunk) this.stoppedValue = true;
    }
  }
  splitJson(): string[] { return ["", "", ""]; }
  skillContext(): Record<string, unknown> { return {}; }
  async runTool(): Promise<ToolResult> {
    if (this.stopAfterTool) this.stoppedValue = true;
    return this.result;
  }
  async *applyChange(): AsyncGenerator<CoreEvent, string, void> { yield { type: "change" }; return "changed"; }
  async *executeCommand(): AsyncGenerator<CoreEvent, string, void> { yield { type: "command" }; return "ran"; }
  recordEvent(event: CoreEvent): void { this.events.push(event); }
}

test("core streams a text response without any HTTP or UI dependency", async () => {
  const host = new FakeHost();
  const message: ChatMessage = { role: "user", content: "hello" };
  host.memory.push(message);
  const events: CoreEvent[] = [];
  for await (const event of new HarnessCore(host).runTurn({
    userMessage: message, conversation: host.memory, setup: { agent: "", prompt: "" },
    enabledTools: [], selectedTools: [], useMemory: true,
  })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["request", "response"]);
  assert.equal(host.tokenCount, 4);
  assert.equal(host.memory.at(-1)?.content, "answer");
});

test("core emits skill, context, streamed thinking, and a change action", async () => {
  const host = new FakeHost();
  host.estimate = 95;
  host.trimmed = { type: "context", action: "trim" };
  host.compacted = [{ type: "context", action: "compact" }];
  host.result = { kind: "change", change: { path: "note.txt" } };
  host.chunks = [
    { message: { content: "part", thinking: "reason" }, done: false },
    { message: { content: "", tool_calls: [{ function: { name: "write_file", arguments: {} } }] }, done: true },
  ];
  const message: ChatMessage = { role: "user", content: "write" };
  const events = [];
  for await (const event of new HarnessCore(host).runTurn({
    userMessage: message, conversation: [message], setup: { agent: "", prompt: "" }, manualSkill: "skill",
    enabledTools: ["use_skill", "write_file"], selectedTools: [{ type: "function", function: { name: "write_file", description: "", parameters: {} } }], useMemory: true,
  })) events.push(event.type);
  assert.deepEqual(events, ["skill", "context", "context", "request", "thinking", "chunk", "response", "change", "tool", "stopped"]);
});

test("core stops before a memory request, at a full context, and after a partial stream", async () => {
  const stopped = new FakeHost();
  stopped.stoppedValue = true;
  const message: ChatMessage = { role: "user", content: "stop" };
  const stoppedEvents = [];
  for await (const event of new HarnessCore(stopped).runTurn({ userMessage: message, conversation: [message], setup: { agent: "", prompt: "" }, enabledTools: [], selectedTools: [], useMemory: true })) stoppedEvents.push(event.type);
  assert.deepEqual(stoppedEvents, ["stopped"]);

  const full = new FakeHost();
  full.estimate = 100;
  const fullEvents = [];
  for await (const event of new HarnessCore(full).runTurn({ userMessage: message, conversation: [message], setup: { agent: "", prompt: "" }, enabledTools: [], selectedTools: [], useMemory: true })) fullEvents.push(event.type);
  assert.deepEqual(fullEvents, ["stopped"]);

  const partial = new FakeHost();
  partial.chunks = [{ message: { content: "partial" }, done: false }];
  partial.stopAfterFirstChunk = true;
  const partialConversation = [message];
  const partialEvents = [];
  for await (const event of new HarnessCore(partial).runTurn({ userMessage: message, conversation: partialConversation, setup: { agent: "", prompt: "" }, enabledTools: [], selectedTools: [], useMemory: false })) partialEvents.push(event.type);
  assert.deepEqual(partialEvents, ["request", "chunk", "stopped"]);
  assert.equal(partialConversation.at(-1)?.content, "partial");
});

test("core forwards command actions and reports the max-step limit", async () => {
  const host = new FakeHost();
  host.result = { kind: "command", command: "echo ok" };
  host.chunks = [{ message: { tool_calls: [{ function: { name: "run_command" } }] }, done: true }];
  const message: ChatMessage = { role: "user", content: "run" };
  const events = [];
  for await (const event of new HarnessCore(host).runTurn({ userMessage: message, conversation: [message], setup: { agent: "", prompt: "" }, enabledTools: ["run_command"], selectedTools: [], useMemory: false })) events.push(event.type);
  assert.deepEqual(events, ["request", "response", "command", "tool", "stopped"]);
});

test("core emits a final stop when cancellation follows a tool batch", async () => {
  const host = new FakeHost();
  host.stopAfterTool = true;
  host.chunks = [{ message: { tool_calls: [{ function: { name: "pwd" } }, { function: { name: "pwd" } }] }, done: true }];
  const message: ChatMessage = { role: "user", content: "stop after tool" };
  const events = [];
  for await (const event of new HarnessCore(host).runTurn({ userMessage: message, conversation: [message], setup: { agent: "", prompt: "" }, enabledTools: ["pwd"], selectedTools: [], useMemory: false })) events.push(event.type);
  assert.deepEqual(events, ["request", "response", "tool", "tool", "stopped"]);
  assert.match(String(host.events.filter(event => event.type === 'tool')[1]!.result), /stopped/);
});

test('core carries the runtime cancellation cause through the remaining tool batch', async () => {
  const host = Object.assign(new FakeHost(), {
    stopReason: () => 'Bridge pairing expired.',
    stoppedToolResult: () => 'stopped: Bridge pairing expired. This tool did not run.',
  });
  host.stopAfterTool = true;
  host.chunks = [{ message: { tool_calls: [{ function: { name: 'pwd' } }, { function: { name: 'pwd' } }] }, done: true }];
  const message: ChatMessage = { role: 'user', content: 'two tools' };
  for await (const _event of new HarnessCore(host).runTurn({ userMessage: message, conversation: [message], setup: { agent: '', prompt: '' }, enabledTools: ['pwd'], selectedTools: [], useMemory: false })) { /* Consume the backend without UI. */ }
  assert.equal(host.events.filter(event => event.type === 'tool')[1]!.result, host.stoppedToolResult());
  assert.equal(host.events.at(-1)!.reason, host.stopReason());
});

/** A host with a clock and a remembered previous request, scripted one model call at a time. */
class TimedHost extends FakeHost {
  time = 0;
  previous: ModelRequest | undefined;
  turns: unknown[][] = [];
  streamModel?: TurnHost["streamModel"];
  now(): number { this.time += 10; return this.time; }
  previousRequest(): ModelRequest | undefined { return this.previous; }
  setPreviousRequest(payload: ModelRequest): void { this.previous = payload; }
  override async *streamChat(): AsyncGenerator<string> { for (const chunk of this.turns.shift() ?? []) yield JSON.stringify(chunk); }
}
const timedTurn = async (host: FakeHost, content: string): Promise<CoreEvent[]> => {
  const message: ChatMessage = { role: "user", content };
  host.memory.push(message);
  const events: CoreEvent[] = [];
  for await (const event of new HarnessCore(host).runTurn({ userMessage: message, conversation: host.memory, setup: { agent: "", prompt: "" }, enabledTools: ["read_file"], selectedTools: [], useMemory: true })) events.push(event);
  return events;
};

test("core reports Ollama's own prefill and decode times and what the previous request shares", async () => {
  const host = new TimedHost();
  host.turns = [
    [{ message: { content: "he", thinking: "hmm" }, done: false }, { message: { content: "llo" }, done: true, prompt_eval_count: 900, eval_count: 4, load_duration: 9e6, prompt_eval_duration: 16e6, eval_duration: 100e6, total_duration: 130e6 }],
    [{ message: { content: "again" }, done: true, prompt_eval_count: 920, eval_count: 2, prompt_eval_duration: 2e6, eval_duration: 20e6 }],
  ];
  const first = await timedTurn(host, "hello");
  assert.deepEqual(first.map(event => event.type), ["request", "thinking", "chunk", "response"]);
  assert.equal((first[0]!.prefix as { change: string }).change, "first request");
  assert.match(String(first[0]!.prefix_text), /^First request/);
  const timing = first.at(-1)!.timing as Record<string, unknown>;
  assert.deepEqual({ ...timing }, { source: "provider", streamed: true, wall_ms: 20, ttft_ms: 10, input: 900, output: 4, thinking_tokens: 2, thinking_exact: false, load_ms: 9, prefill_ms: 16, prefill_tps: 56250, decode_ms: 100, decode_tps: 40, tpot_ms: 25 });
  assert.equal(first.at(-1)!.round, 1);
  assert.match(String(first.at(-1)!.timing_text), /^load {6}9 ms {2}the model was already in memory/);
  const second = await timedTurn(host, "more");
  // The first reply was generated with thinking that is not sent back, so the cache can only match up to it.
  assert.deepEqual(second[0]!.prefix, { change: "thinking dropped", changed_index: 1, reused_messages: 1, total_messages: 3, reused_tokens_est: 1, new_tokens_est: 0 });
  assert.match(String(second.at(-1)!.timing_text), /≈920 of these tokens matched the previous request\. Ollama keeps their KV cache, so only about 0 had to be computed/);
  assert.equal(second.some(event => event.type === "turn_timing"), false);
});

test("a tool-using turn ends with a timeline of its rounds", async () => {
  const host = new TimedHost();
  host.maxSteps = 3;
  host.turns = [
    [{ message: { content: "", tool_calls: [{ function: { name: "read_file", arguments: {} } }] }, done: true, prompt_eval_count: 100, eval_count: 9 }],
    [{ message: { content: "done" }, done: true, prompt_eval_count: 150, eval_count: 3 }],
  ];
  const events = await timedTurn(host, "read");
  assert.deepEqual(events.map(event => event.type), ["request", "response", "tool", "request", "response", "turn_timing"]);
  const timeline = events.at(-1)!;
  // Clock readings: request 10, single final chunk 20, response 30, tools 40-50, then 60-80 for the second call.
  assert.deepEqual(timeline.rounds, [{ round: 1, tokens_in: 100, tokens_out: 9, wall_ms: 20, tool_ms: 10 }, { round: 2, tokens_in: 150, tokens_out: 3, wall_ms: 20 }]);
  assert.deepEqual(timeline.totals, { rounds: 2, tokens_in: 250, tokens_out: 12, wall_ms: 40, tool_ms: 10 });
  assert.match(String(timeline.timeline_text), /^round {5}input/);
  assert.equal((events[3]!.prefix as { change: string }).change, "appended");
});

test("a reply that streams nothing still gets a measured total", async () => {
  const host = new TimedHost();
  host.streamModel = async function* () { yield { type: "completed" as const, result: { message: { role: "assistant" as const, content: "whole" }, thinking: "", usage: {}, status: "completed" as const, raw: {} } }; };
  const events = await timedTurn(host, "hi");
  assert.deepEqual({ ...(events.at(-1)!.timing as object) }, { source: "harness", streamed: false, wall_ms: 10 });
  assert.match(String(events.at(-1)!.timing_text), /^not streamed/);
});

test("without a clock or request memory only provider timing is reported", async () => {
  const host = new FakeHost();
  const events = await timedTurn(host, "hi");
  assert.equal(events[0]!.prefix, undefined);
  assert.deepEqual({ ...(events.at(-1)!.timing as object) }, { source: "none", streamed: false, input: 4, output: 2 });
});

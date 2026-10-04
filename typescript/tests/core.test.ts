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
  host.chunks = [{ message: { tool_calls: [{ function: { name: "pwd" } }] }, done: true }];
  const message: ChatMessage = { role: "user", content: "stop after tool" };
  const events = [];
  for await (const event of new HarnessCore(host).runTurn({ userMessage: message, conversation: [message], setup: { agent: "", prompt: "" }, enabledTools: ["pwd"], selectedTools: [], useMemory: false })) events.push(event.type);
  assert.deepEqual(events, ["request", "response", "tool", "stopped"]);
});

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { HarnessCore, type ChatMessage, type CoreEvent, type ModelChunk, type ToolDefinition, type ToolResult, type TurnHost } from "../src/core.js";

interface Scenario {
  name: string;
  request: { message: string; use_memory: boolean; tools: string[]; ask_approval: boolean; agent: string; prompt: string };
  approval?: "deny";
  model_turns: ModelChunk[][];
  expect: { event_types: string[]; memory_roles: string[]; last_content?: string; absent_files?: string[] };
}

class ScenarioHost implements TurnHost {
  readonly maxSteps = 20;
  readonly memory: ChatMessage[] = [];
  readonly events: CoreEvent[] = [];
  readonly files = new Set<string>();
  private tokenCount = 0;
  private readonly turns: ModelChunk[][];
  private approval = false;

  constructor(turns: ModelChunk[][]) { this.turns = structuredClone(turns); }
  setApproval(denied: boolean): void { this.approval = denied; }
  stopped(): boolean { return false; }
  model(): string { return "scripted"; }
  contextLength(): number { return 3_000; }
  lastPromptTokens(): number { return this.tokenCount; }
  setLastPromptTokens(value: number): void { this.tokenCount = value; }
  memoryText(): string { return JSON.stringify(this.memory); }
  systemMessages(): ChatMessage[] { return []; }
  estimateTokens(): number { return 1; }
  trimContext(): CoreEvent | undefined { return undefined; }
  async *compactContext(): AsyncGenerator<CoreEvent> { return; }
  async *streamChat(): AsyncGenerator<string> {
    for (const chunk of this.turns.shift() ?? []) yield JSON.stringify(chunk);
  }
  splitJson(): string[] { return ["", "", ""]; }
  skillContext(): Record<string, unknown> { return {}; }
  async runTool(name: string, arguments_: Record<string, unknown>): Promise<ToolResult> {
    if (name === "write_file") return { kind: "change", change: arguments_ };
    return { kind: "text", text: `error: unknown tool '${name}'` };
  }
  async *applyChange(_name: string, change: unknown): AsyncGenerator<CoreEvent, string, void> {
    const values = change as { path?: string };
    const path_ = values.path ?? "";
    if (this.approval) {
      yield { type: "approval", id: "approval", name: "write_file", path: path_, diff: "", note: "" };
      yield { type: "change", path: path_, diff: "", approved: false, note: "" };
      return "refused: the user did not approve this change. Ask them what to do instead.";
    }
    this.files.add(path_);
    yield { type: "change", path: path_, diff: "", approved: true, note: "" };
    return `ok: created '${path_}'`;
  }
  async *executeCommand(command: string): AsyncGenerator<CoreEvent, string, void> {
    yield { type: "command", command, approved: true, output: "", status: "exit code 0" };
    return "exit code 0\n(no output)";
  }
  recordEvent(event: CoreEvent): void { this.events.push(event); }
}

const definitions = (names: string[]): ToolDefinition[] => names.map((name) => ({
  type: "function", function: { name, description: name, parameters: {} },
}));

for (const file of readdirSync("tests/scenarios").filter((entry) => entry.endsWith(".json")).sort()) {
  test(`shared scenario: ${file}`, async () => {
    const scenario = JSON.parse(readFileSync(path.join("tests/scenarios", file), "utf8")) as Scenario;
    const host = new ScenarioHost(scenario.model_turns);
    host.setApproval(scenario.approval === "deny");
    const userMessage: ChatMessage = { role: "user", content: scenario.request.message };
    const conversation = scenario.request.use_memory ? host.memory : [userMessage];
    if (scenario.request.use_memory) conversation.push(userMessage);
    const events: CoreEvent[] = [];
    for await (const event of new HarnessCore(host).runTurn({
      userMessage, conversation, setup: { agent: scenario.request.agent, prompt: scenario.request.prompt },
      enabledTools: scenario.request.tools, selectedTools: definitions(scenario.request.tools),
      useMemory: scenario.request.use_memory,
    })) events.push(event);
    assert.deepEqual(events.map((event) => event.type), scenario.expect.event_types);
    assert.deepEqual(host.memory.map((message) => message.role), scenario.expect.memory_roles);
    if (scenario.expect.last_content) assert.equal((host.memory.at(-1) ?? userMessage).content, scenario.expect.last_content);
    for (const absent of scenario.expect.absent_files ?? []) assert.equal(host.files.has(absent), false);
  });
}

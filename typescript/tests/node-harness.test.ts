import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeHarness } from "../src/node/harness.js";
import type { ModelRequest } from "../src/core.js";
import { SessionStore } from "../src/node/sessions.js";

class ScriptedModel {
  constructor(private readonly turns: unknown[][]) {}
  async *streamChat(_payload: ModelRequest): AsyncGenerator<string> {
    for (const chunk of this.turns.shift() ?? []) yield JSON.stringify(chunk);
  }
}

test("Node harness runs the TypeScript core with remembered state and a workspace write", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "myharness-node-"));
  const harness = new NodeHarness({ workspace: root, model: "scripted", contextLength: 3000, ollama: new ScriptedModel([
    [{ message: { tool_calls: [{ function: { name: "write_file", arguments: { path: "note.txt", content: "draft" } } }] }, done: true }],
    [{ message: { content: "done" }, done: true, prompt_eval_count: 8, eval_count: 1 }],
  ]) });
  const events = [];
  for await (const event of harness.submit({ message: "write", useMemory: true, tools: ["write_file"], askApproval: false, agent: "", prompt: "" })) events.push(event.type);
  assert.deepEqual(events, ["request", "response", "change", "tool", "request", "response", "turn_timing"]);
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "draft");
  assert.equal(harness.inspect().memory.length, 4);
  harness.reset();
  assert.equal(harness.inspect().memory.length, 0);
});

test("Node harness executes an approved-by-policy command in the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "myharness-command-"));
  const harness = new NodeHarness({ workspace: root, model: "scripted", contextLength: 3000, ollama: new ScriptedModel([
    [{ message: { tool_calls: [{ function: { name: "run_command", arguments: { command: "printf done" } } }] }, done: true }],
    [{ message: { content: "done" }, done: true }],
  ]) });
  const events = [];
  for await (const event of harness.submit({ message: "run", useMemory: false, tools: ["run_command"], askApproval: false, agent: "", prompt: "" })) events.push(event);
  const command = events.find((event) => event.type === "command");
  assert.equal(command?.approved, true);
  assert.equal(command?.output, "done");
});

test("Node harness creates, persists, and activates a saved session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "myharness-session-host-"));
  const sessions = new SessionStore(path.join(root, "sessions"));
  const harness = new NodeHarness({ workspace: root, model: "scripted", contextLength: 3000, ollama: new ScriptedModel([
    [{ message: { content: "saved" }, done: true, prompt_eval_count: 1 }],
  ]), sessions });
  for await (const _event of harness.submit({ message: "remember", useMemory: true, tools: [], askApproval: false, agent: "", prompt: "" })) {}
  const active = harness.activeSessionRecord();
  assert.ok(active);
  assert.equal((await harness.listSessions()).length, 1);
  await harness.activateSession(active.id);
  assert.equal(harness.inspect().memory[0]?.content, "remember");
});

test("Node harness shows what each request shares with the previous one, and forgets it when a session is loaded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "myharness-prefix-"));
  const harness = new NodeHarness({ workspace: root, model: "scripted", contextLength: 3000, sessions: new SessionStore(path.join(root, "sessions")), ollama: new ScriptedModel([
    [{ message: { content: "one" }, done: true, prompt_eval_count: 5, eval_count: 1, prompt_eval_duration: 4e6, eval_duration: 2e6 }],
    [{ message: { content: "two" }, done: true, prompt_eval_count: 9, eval_count: 1 }],
    [{ message: { content: "three" }, done: true, prompt_eval_count: 12, eval_count: 1 }],
  ]) });
  const prefixes: { change: string }[] = [], timings: Record<string, unknown>[] = [];
  const send = async (message: string) => {
    for await (const event of harness.submit({ message, useMemory: true, tools: [], askApproval: false, agent: "", prompt: "" })) {
      if (event.type === "request") prefixes.push(event.prefix as { change: string });
      if (event.type === "response") timings.push(event.timing as Record<string, unknown>);
    }
  };
  await send("first");
  await send("second");
  assert.deepEqual(prefixes.map(prefix => prefix.change), ["first request", "appended"]);
  assert.equal(timings[0]!.prefill_ms, 4);
  assert.equal(typeof timings[1]!.wall_ms, "number");
  await harness.activateSession(harness.activeSessionRecord().id);
  await send("third");
  assert.equal(prefixes[2]!.change, "first request");
});

test("Node harness explore estimates the KV cache from the sizes the model reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "myharness-kv-"));
  let show: Record<string, unknown> = { template: "T", parameters: "P", model_info: { "general.architecture": "qwen2", "qwen2.attention.head_count": 28, "qwen2.attention.head_count_kv": 4, "qwen2.block_count": 28, "qwen2.context_length": 32768, "qwen2.embedding_length": 3584 } };
  const harness = new NodeHarness({ workspace: root, model: "qwen2.5:7b", contextLength: 4096, ollama: { async *streamChat() {}, async request() { return show; } } });
  const action = { useMemory: true, tools: [], agent: "", prompt: "" };
  const details = await harness.explore(action);
  assert.equal((details.kv_cache as { working_bytes: number }).working_bytes, 234_881_024);
  assert.match(String(details.kv_text), /working context 4,096 tokens → 224 MiB/);
  for (const info of [undefined, "broken"]) {
    show = { template: "T", parameters: "P", ...(info ? { model_info: info } : {}) };
    assert.match(String((await harness.explore(action)).kv_text), /does not publish the model’s layer and attention-head sizes/);
  }
  assert.equal((await harness.explore(action, false)).kv_cache, undefined);
});

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
  assert.deepEqual(events, ["request", "response", "change", "tool", "request", "response"]);
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

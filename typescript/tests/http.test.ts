import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ModelRequest } from "../src/core.js";
import { NodeHarness } from "../src/node/harness.js";
import { createHarnessServer } from "../src/node/http.js";

class Model {
  async *streamChat(_payload: ModelRequest): AsyncGenerator<string> {
    yield JSON.stringify({ message: { content: "hello" }, done: true, prompt_eval_count: 2, eval_count: 1 });
  }
}

test("Node HTTP adapter exposes bootstrap, NDJSON chat, reset, stop, and 404", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "myharness-http-"));
  const harness = new NodeHarness({ workspace: root, model: "scripted", contextLength: 4000, ollama: new Model() });
  const server = createHarnessServer(harness);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/bootstrap`)).status, 200);
  const chat = await fetch(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi", useMemory: true, tools: [], askApproval: false, agent: "", prompt: "" }) });
  assert.equal(chat.headers.get("content-type"), "application/x-ndjson");
  assert.deepEqual((await chat.text()).trim().split("\n").map((line) => JSON.parse(line).type), ["request", "response"]);
  assert.equal((await fetch(`${base}/reset`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${base}/stop`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});

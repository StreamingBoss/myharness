import assert from "node:assert/strict";
import test from "node:test";

import { OllamaAdapter, type FetchResponse } from "../src/node/ollama.js";

const encoder = new TextEncoder();

function stream(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

function response(overrides: Partial<FetchResponse> = {}): FetchResponse {
  return { ok: true, status: 200, body: stream(), json: async () => ({}), ...overrides };
}

async function collect(stream_: AsyncIterable<string>): Promise<string[]> {
  const values: string[] = [];
  for await (const value of stream_) values.push(value);
  return values;
}

test("Ollama adapter forwards complete NDJSON lines across chunks", async () => {
  const requests: { input: string; body: string }[] = [];
  const adapter = new OllamaAdapter(async (input, init) => {
    requests.push({ input, body: init.body ?? "" });
    return response({ body: stream('{"one":', '1}\n\n{"two":2}') });
  }, "http://ollama");
  const lines = [];
  for await (const line of adapter.streamChat({ model: "qwen", messages: [], stream: true, options: { num_ctx: 10 } })) lines.push(line);
  assert.deepEqual(lines, ['{"one":1}', '{"two":2}']);
  assert.equal(requests[0]?.input, "http://ollama/api/chat");
  assert.equal(JSON.parse(requests[0]?.body ?? "{}").model, "qwen");
});

test("Ollama adapter rejects failed or body-less streamed responses", async () => {
  const failed = new OllamaAdapter(async () => response({ ok: false, status: 503 }), "http://ollama");
  await assert.rejects(() => collect(failed.streamChat({ model: "q", messages: [], stream: true, options: { num_ctx: 1 } })), /503/);
  const empty = new OllamaAdapter(async () => response({ body: null }), "http://ollama");
  await assert.rejects(() => collect(empty.streamChat({ model: "q", messages: [], stream: true, options: { num_ctx: 1 } })), /no response body/);
});

test("Ollama adapter validates model context metadata", async () => {
  const adapter = new OllamaAdapter(async () => response({ json: async () => ({ models: [{ name: "qwen", details: { context_length: 4096 } }] }) }), "http://ollama");
  assert.equal(await adapter.contextLength("qwen"), 4096);
  const failed = new OllamaAdapter(async () => response({ ok: false, status: 404 }), "http://ollama");
  await assert.rejects(() => failed.contextLength("missing"), /404/);
  const invalid = new OllamaAdapter(async () => response({ json: async () => ({ models: [{ name: "qwen", details: { context_length: 0 } }] }) }), "http://ollama");
  await assert.rejects(() => invalid.contextLength("qwen"), /did not report/);
  const missing = new OllamaAdapter(async () => response({ json: async () => ({ models: {} }) }), "http://ollama");
  await assert.rejects(() => missing.contextLength("qwen"), /did not report/);
});

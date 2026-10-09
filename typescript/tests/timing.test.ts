import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage, ModelRequest } from "../src/core.js";
import { legacyEvents } from "../src/model.js";
import { kvCacheEstimate, kvText, prefixReuse, prefixText, timingSummary, timingText, turnTimelineText, turnTotals, type PrefixReuse } from "../src/timing.js";

// Measured against Ollama 0.40.1 with qwen2.5:7b: the same 917-token prompt, cold and then warm.
const cold = { load_ms: 14735.3419, prefill_ms: 12215.968, decode_ms: 8319.419, total_ms: 35279.714 };
const warm = { load_ms: 9.6977, prefill_ms: 15.832, decode_ms: 107.864, total_ms: 142.6548 };

test("provider timing splits prefill from decode and derives rates", () => {
  const summary = timingSummary({ input: 917, output: 8 }, cold, { started: 0, firstDelta: 27_000, completed: 35_300, streamed: true });
  assert.equal(summary.source, "provider");
  assert.equal(summary.wall_ms, 35_300);
  assert.equal(summary.ttft_ms, 27_000);
  assert.equal(Math.round(summary.prefill_tps!), 75);
  assert.equal(Math.round(summary.tpot_ms!), 1040);
  assert.equal(summary.thinking_tokens, undefined);
  const text = timingText(summary);
  assert.match(text, /load {6}14\.7 s {2}the model was loaded into memory first \(cold start/);
  assert.match(text, /prefill {3}917 prompt tokens in 12\.2 s = 75 tokens\/s {2}reads the whole prompt in parallel \(compute-bound\)$/m);
  assert.match(text, /first token after 27 s {2}\(time to first token: load \+ prefill \+ one decode step\)/);
  assert.match(text, /decode {4}8 output tokens in 8\.32 s = 1 tokens\/s, 1\.04 s per token {2}writes one token at a time \(memory-bandwidth-bound\)$/m);
  assert.match(text, /total {5}35\.3 s/);
});

test("a warm Ollama prefill names the reused prefix that made it fast", () => {
  const prefix: PrefixReuse = { change: "appended", changed_index: 2, reused_messages: 2, total_messages: 3, reused_tokens_est: 900, new_tokens_est: 17 };
  const summary = timingSummary({ input: 917, output: 8 }, warm, undefined);
  assert.equal(summary.wall_ms, warm.total_ms);
  assert.equal(summary.streamed, false);
  const text = timingText(summary, prefix);
  assert.match(text, /load {6}9\.7 ms {2}the model was already in memory/);
  assert.match(text, /prefill {3}917 prompt tokens in 16 ms = 57,921 tokens\/s/);
  assert.match(text, /≈900 of these tokens matched the previous request\. Ollama keeps their KV cache, so only about 17 had to be computed/);
  assert.match(text, /decode {4}8 output tokens in 108 ms = 74 tokens\/s, 13 ms per token/);
  assert.doesNotMatch(text, /not streamed/);
  assert.doesNotMatch(timingText(summary, { ...prefix, reused_tokens_est: 0 }), /matched the previous request/);
  // The harness estimate is scaled to the measured prompt, so it never exceeds it.
  assert.match(timingText(summary, { ...prefix, reused_tokens_est: 1769, new_tokens_est: 52 }), /≈891 of these tokens matched the previous request\. Ollama keeps their KV cache, so only about 26 had to be computed/);
  assert.match(timingText(timingSummary({}, { prefill_ms: 5 }, undefined), prefix), /^prefill {3}5 ms {2}reads.*\n {10}≈900 of these tokens matched .* only about 17 had to be computed/);
  assert.doesNotMatch(timingText(summary, { ...prefix, reused_tokens_est: 0, new_tokens_est: 0 }), /matched the previous request/);
  // Ollama 0.40 reports the reused count itself (prompt_eval_cached_count); that beats the estimate.
  const measured = timingText(timingSummary({ input: 917, output: 8, cached: 900 }, warm, undefined), prefix);
  assert.match(measured, /\n {10}900 of these tokens were reused from the KV cache \(reported by Ollama\), so only 17 had to be computed/);
  assert.doesNotMatch(measured, /matched the previous request|^cache/m);
  assert.match(timingText(timingSummary({ cached: 5 }, { prefill_ms: 1 }, undefined)), /\n {10}5 of these tokens were reused from the KV cache \(reported by Ollama\)\. The tokens\/s above counts all prompt tokens/);
  assert.match(timingText(timingSummary({ input: 9, cached: 0 }, { prefill_ms: 1 }, undefined), prefix), /Ollama reports that none of these tokens were reused from its KV cache/);
});

test("partial provider timing leaves out what cannot be derived", () => {
  const summary = timingSummary({ output: 0 }, { decode_ms: 4, prefill_ms: 0 }, undefined);
  assert.deepEqual(summary, { source: "provider", streamed: false, output: 0, prefill_ms: 0, decode_ms: 4 });
  const text = timingText(summary);
  assert.match(text, /^prefill {3}0 ms {2}reads/m);
  assert.match(text, /^decode {4}0 output tokens in 4 ms {2}writes/m);
  assert.doesNotMatch(text, /tokens\/s|per token|total|load/);
  assert.equal(timingText(timingSummary({}, { decode_ms: 2000 }, undefined)), "decode    2 s  writes one token at a time (memory-bandwidth-bound)");
});

test("a streamed cloud reply is timed by the harness clock", () => {
  const summary = timingSummary({ input: 100, output: 11, cached: 64, reasoning: 5 }, undefined, { started: 0, firstDelta: 800, completed: 1800, streamed: true });
  assert.deepEqual(summary, { source: "harness", streamed: true, wall_ms: 1800, ttft_ms: 800, input: 100, output: 11, cached: 64, thinking_tokens: 5, thinking_exact: true, decode_ms: 1000, decode_tps: 10, tpot_ms: 100 });
  const text = timingText(summary);
  assert.match(text, /first token after 800 ms {2}\(time to first token: queueing, network and prefill on the provider/);
  assert.match(text, /decode {4}11 output tokens in 1 s = 10 tokens\/s, 100 ms per token .*; measured in the harness, includes network/);
  assert.match(text, /cache {5}64 of 100 input tokens were read from the provider's prompt cache/);
  assert.match(text, /thinking  5 of 11 output tokens were thinking \(reported by the provider\)/);
  assert.match(timingText({ ...summary, input: undefined as never, output: undefined as never, decode_tps: undefined as never, tpot_ms: undefined as never }), /^decode {4}1 s {2}writes.*\ncache {5}64 input tokens.*\nthinking  5 output tokens/m);
});

test("replies that cannot be split say why", () => {
  const single = timingSummary({ input: 5, output: 1 }, undefined, { started: 10, firstDelta: 20, completed: 30, streamed: true });
  assert.deepEqual(single, { source: "harness", streamed: true, wall_ms: 20, ttft_ms: 10, input: 5, output: 1 });
  const whole = timingSummary({ input: 5, output: 9 }, undefined, { started: 0, firstDelta: 500, completed: 500, streamed: false });
  assert.equal(whole.ttft_ms, undefined);
  assert.match(timingText(whole), /^not streamed: the reply arrived in one piece, so prefill and decode cannot be told apart here\ntotal {5}500 ms$/);
  const unmeasured = timingSummary({ output: 3 }, undefined, { started: 0, completed: 5, streamed: true });
  assert.equal(unmeasured.ttft_ms, undefined);
  const none = timingSummary({}, undefined, undefined);
  assert.deepEqual(none, { source: "none", streamed: false });
  assert.equal(timingText(none), "No timing is available for this response.");
});

test("thinking without a provider count splits the measured output by its share of the text", () => {
  const split = timingSummary({ output: 100 }, undefined, undefined, "x".repeat(300), "y".repeat(100));
  assert.equal(split.thinking_tokens, 75);
  assert.equal(split.thinking_exact, false);
  assert.match(timingText(split), /thinking  ≈75 of 100 output tokens were thinking \(estimated from the share of thinking text\)/);
  assert.equal(timingSummary({ output: 5 }, undefined, undefined, "x".repeat(40)).thinking_tokens, 5);
  assert.equal(timingSummary({}, undefined, undefined, "x".repeat(40)).thinking_tokens, 10);
});

const system: ChatMessage = { role: "system", content: "rules" }, user: ChatMessage = { role: "user", content: "hi" };
const request = (messages: ChatMessage[], extra: Partial<ModelRequest> = {}): ModelRequest => ({ model: "m", messages, stream: true, options: { num_ctx: 4096 }, ...extra });
const estimate = (messages: ChatMessage[], tools: unknown[]) => messages.length * 10 + tools.length * 100;

test("prefix reuse compares requests in rendered order", () => {
  const base = request([system, user]);
  assert.deepEqual(prefixReuse(undefined, base, estimate), { change: "first request", reused_messages: 0, total_messages: 2, reused_tokens_est: 0, new_tokens_est: 20 });
  assert.equal(prefixReuse(base, request([system, user], { model: "other" }), estimate).change, "model");
  assert.equal(prefixReuse(base, request([system, user], { provider: "openai" }), estimate).change, "model");
  assert.equal(prefixReuse(base, request([system, user], { options: { num_ctx: 8192 } }), estimate).change, "context window");
  const tool = { type: "function" as const, function: { name: "t", description: "", parameters: {} } };
  assert.deepEqual(prefixReuse(base, request([system, user], { tools: [tool] }), estimate), { change: "tools", reused_messages: 0, total_messages: 2, reused_tokens_est: 0, new_tokens_est: 120 });
  assert.deepEqual(prefixReuse(base, request([system, user]), estimate), { change: "none", reused_messages: 2, total_messages: 2, reused_tokens_est: 20, new_tokens_est: 0 });
  const reply: ChatMessage = { role: "assistant", content: "hello" }, next: ChatMessage = { role: "user", content: "more" };
  assert.deepEqual(prefixReuse(base, request([system, user, reply, next]), estimate), { change: "appended", changed_index: 2, reused_messages: 2, total_messages: 4, reused_tokens_est: 20, new_tokens_est: 20 });
  assert.deepEqual(prefixReuse(base, request([{ role: "system", content: "new rules" }, user]), estimate), { change: "system prompt", changed_index: 0, reused_messages: 0, total_messages: 2, reused_tokens_est: 0, new_tokens_est: 20 });
  const long = request([system, user, reply, next]);
  assert.deepEqual(prefixReuse(long, request([system, user, { role: "assistant", content: "[summary]" }, next]), estimate), { change: "conversation rewritten", changed_index: 2, reused_messages: 2, total_messages: 4, reused_tokens_est: 20, new_tokens_est: 20 });
  assert.equal(prefixReuse(long, base, estimate).change, "none");
  // Ollama's cache holds the reply as generated, thinking included; the harness sends it back without the thinking.
  const generated = request([system, user, { ...reply, thinking: "hmm" } as ChatMessage]);
  assert.deepEqual(prefixReuse(generated, long, estimate), { change: "thinking dropped", changed_index: 2, reused_messages: 2, total_messages: 4, reused_tokens_est: 20, new_tokens_est: 20 });
  assert.equal(prefixReuse(generated, request([system, user, { role: "assistant", content: "other" }, next]), estimate).change, "conversation rewritten");
});

test("prefix text explains each kind of change", () => {
  const prefix = (change: PrefixReuse["change"], changed_index?: number): PrefixReuse => ({ change, ...(changed_index === undefined ? {} : { changed_index }), reused_messages: 2, total_messages: 4, reused_tokens_est: 1200, new_tokens_est: 300 });
  assert.match(prefixText(prefix("first request")), /^First request since this session was loaded: the harness has no earlier request to compare with\. All ≈300 tokens need prefill, unless the provider still holds an identical start/);
  assert.match(prefixText(prefix("model")), /^The model changed/);
  assert.match(prefixText(prefix("context window")), /num_ctx\) changed\. Ollama reloads/);
  assert.match(prefixText(prefix("tools")), /^The tool definitions changed/);
  assert.match(prefixText(prefix("system prompt", 0)), /^The system prompt changed at message 1 of 4 .*≈300 tokens, needs prefill again; only ≈1,200 tokens before it can be reused\.$/);
  assert.match(prefixText(prefix("conversation rewritten", 2)), /^The harness rewrote earlier history: message 3 of 4 differs/);
  assert.match(prefixText(prefix("thinking dropped", 2)), /^The model's previous reply \(message 3 of 4\) started with thinking that the harness does not send back.*≈1,200 tokens before it can be reused; .* ≈300 tokens, need prefill again\.$/);
  assert.match(prefixText(prefix("appended", 2)), /^The first 2 of 4 messages are identical to the previous request \(≈1,200 tokens\)\..*only the ≈300 tokens added since need prefill\.$/);
  assert.equal(prefixText(prefix("none")), "Identical to the previous request (≈1,200 tokens); all of it can be reused.");
});

const qwen = { "general.architecture": "qwen2", "qwen2.attention.head_count": 28, "qwen2.attention.head_count_kv": 4, "qwen2.block_count": 28, "qwen2.context_length": 32768, "qwen2.embedding_length": 3584 };

test("KV cache estimate uses the model's own layer and head sizes", () => {
  const estimate = kvCacheEstimate(qwen, 4096);
  assert.deepEqual(estimate, { available: true, architecture: "qwen2", layers: 28, kv_heads: 4, key_length: 128, value_length: 128, sliding_window: false,
    bytes_per_token: 57_344, working_context: 4096, working_bytes: 234_881_024, model_context: 32768, model_bytes: 1_879_048_192 });
  const text = kvText(estimate);
  assert.match(text, /^qwen2: 28 layers × 4 key\/value heads × \(128 \+ 128\) values × 2 bytes\n= 56 KiB for every token kept in context/);
  assert.match(text, /working context 4,096 tokens → 224 MiB\nmodel maximum {3}32,768 tokens → 1\.75 GiB/);
  assert.match(text, /Assumes the default f16 cache: OLLAMA_KV_CACHE_TYPE=q8_0 halves it and q4_0 quarters it\.$/);
});

test("explicit key/value lengths and sliding windows are honoured", () => {
  const estimate = kvCacheEstimate({ "general.architecture": "g", "g.block_count": 1, "g.attention.head_count": 1, "g.attention.key_length": 2, "g.attention.value_length": 2, "g.attention.sliding_window": 1024 }, 3);
  assert.deepEqual(estimate, { available: true, architecture: "g", layers: 1, kv_heads: 1, key_length: 2, value_length: 2, sliding_window: true, bytes_per_token: 8, working_context: 3, working_bytes: 24 });
  const text = kvText(estimate);
  assert.match(text, /= 8 bytes for every token/);
  assert.match(text, /working context 3 tokens → 24 bytes\n\n/);
  assert.doesNotMatch(text, /model maximum/);
  assert.match(text, /sliding-window attention on some layers/);
  assert.match(kvText(kvCacheEstimate({ "general.architecture": "g", "g.block_count": 10, "g.attention.head_count": 8, "g.attention.key_length": 128 }, 10)), /working context 10 tokens → 400 KiB/);
});

test("KV cache estimate refuses to guess when sizes are missing", () => {
  const missing = { available: false, reason: "The model did not report its layer and attention-head sizes, so its KV-cache size cannot be estimated." };
  assert.deepEqual(kvCacheEstimate({ ...qwen, "general.architecture": 7 }, 4096), missing);
  assert.deepEqual(kvCacheEstimate({ ...qwen, "qwen2.block_count": 1.5 }, 4096), missing);
  assert.deepEqual(kvCacheEstimate({ ...qwen, "qwen2.block_count": 0 }, 4096), missing);
  assert.deepEqual(kvCacheEstimate({ ...qwen, "qwen2.block_count": "28" }, 4096), missing);
  assert.deepEqual(kvCacheEstimate({ "general.architecture": "qwen2", "qwen2.block_count": 28, "qwen2.embedding_length": 3584 }, 4096), missing);
  assert.deepEqual(kvCacheEstimate({ "general.architecture": "qwen2", "qwen2.block_count": 28, "qwen2.attention.head_count": 28 }, 4096), missing);
  assert.equal(kvText(missing as never), missing.reason);
});

test("the turn timeline shows input growing round by round", () => {
  const rounds = [{ round: 1, tokens_in: 1000, tokens_out: 40, wall_ms: 1500, prefill_ms: 300, decode_ms: 1100, tool_ms: 50 }, { round: 2, tokens_in: 2000, tokens_out: 5, wall_ms: 400 }];
  assert.deepEqual(turnTotals(rounds), { rounds: 2, tokens_in: 3000, tokens_out: 45, wall_ms: 1900, prefill_ms: 300, decode_ms: 1100, tool_ms: 50 });
  const text = turnTimelineText(rounds).split("\n");
  assert.equal(text[0], "round     input   output   prefill    decode      model     tools  input size");
  assert.equal(text[1], "    1     1,000       40    300 ms     1.1 s     1.5 s     50 ms  " + "█".repeat(10));
  assert.equal(text[2], "    2     2,000        5         —         —    400 ms         —  " + "█".repeat(20));
  assert.equal(text[4], "2 model calls, 3,000 input tokens sent in total, 45 output tokens; model time 1.9 s, tool time 50 ms.");
  assert.match(text[5]!, /^Every round sends the whole conversation again/);
  const bare = turnTimelineText([{ round: 1 }, { round: 2 }]).split("\n");
  assert.equal(bare[1], "    1         —        —         —         —         —         —  ");
  assert.equal(bare[4], "2 model calls.");
});

test("Ollama chunk fields become usage and provider timing in milliseconds", async () => {
  const completed = async (chunk: Record<string, unknown>) => {
    const events = [];
    for await (const event of legacyEvents((async function* () { yield JSON.stringify({ message: { content: "x" }, done: true, ...chunk }); })())) events.push(event);
    return (events.at(-1) as { result: { usage: unknown; timing?: unknown } }).result;
  };
  const result = await completed({ prompt_eval_count: 9, eval_count: 2, cached_count: 3, reasoning_count: 1, load_duration: -1, prompt_eval_duration: 5e6, eval_duration: 0, total_duration: 7.5e6 });
  assert.deepEqual(result.usage, { input: 9, output: 2, cached: 3, reasoning: 1 });
  assert.deepEqual(result.timing, { prefill_ms: 5, decode_ms: 0, total_ms: 7.5 });
  assert.equal("timing" in await completed({}), false);
  assert.deepEqual((await completed({ prompt_eval_count: 9, prompt_eval_cached_count: 8 })).usage, { input: 9, output: 0, cached: 8 });
});

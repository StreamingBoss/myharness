import assert from "node:assert/strict";
import test from "node:test";

import { LegacyModelAdapter } from "../src/model.js";
import { ProviderRouter } from "../src/providers.js";
import { NodeHarness } from "../src/node/harness.js";
import { Vocabulary } from "../src/vocabulary.js";

/** Byte-level BPE as Ollama stores it: bytes written as printable characters, with Ġ for a space. */
const tokens = ["!", "a", "Ġhello", "hello", "Hello", "ä¹Ł", "ä¹", "Ċ", "<|endoftext|>", "<|im_end|>", "<think>", "<|new_marker|>", "[PAD8]"];
const types = [1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 4, 3, 5];
const info = { "general.architecture": "qwen3", "tokenizer.ggml.model": "gpt2", "tokenizer.ggml.tokens": tokens, "tokenizer.ggml.token_type": types, "tokenizer.ggml.eos_token_id": 9, "tokenizer.ggml.bos_token_id": 8, "tokenizer.ggml.padding_token_id": 99 };
const vocabulary = Vocabulary.parse("qwen3:8b", info)!;
const page = (query = {}) => vocabulary.page(query) as Extract<ReturnType<Vocabulary["page"]>, { available: true }>;

test("byte-level pieces are decoded back to the text they stand for", () => {
  const entries = page().entries;
  assert.deepEqual(entries.slice(0, 8).map(entry => [entry.id, entry.piece, entry.hex]), [
    [0, "!", "21"], [1, "a", "61"], [2, " hello", "20 68 65 6C 6C 6F"], [3, "hello", "68 65 6C 6C 6F"], [4, "Hello", "48 65 6C 6C 6F"], [5, "也", "E4 B9 9F"], [6, "\\xE4\\xB9", "E4 B9"], [7, "\n", "0A"],
  ]);
  assert.deepEqual(entries.map(entry => entry.partial), [false, false, false, false, false, false, true, false, false, false, false, false, false]);
  assert.deepEqual(entries.slice(8).map(entry => entry.kind), ["control", "control", "user-defined", "control", "unused"]);
  assert.equal(entries[9]!.special?.label, "end of message");
  assert.equal(entries[10]!.special?.label, "start of thinking");
  assert.equal(entries[11]!.special?.label, "control token");
  assert.equal(entries[12]!.special, undefined);
  assert.equal(entries[3]!.special, undefined);
});

test("the page describes the whole vocabulary", () => {
  const result = page();
  assert.deepEqual([result.model, result.tokenizer, result.size, result.mode, result.start, result.limit], ["qwen3:8b", "gpt2", 13, "browse", 0, 100]);
  assert.deepEqual(result.counts, { normal: 8, unknown: 0, control: 3, "user-defined": 1, unused: 1, byte: 0 });
  assert.deepEqual(result.reserved, { bos: 8, eos: 9 });
  assert.match(result.tokenizer_note, /^Byte-level BPE/);
  assert.equal(vocabulary.size, 13);
});

test("browsing pages by ID and jumping to an ID centre the window on it", () => {
  assert.deepEqual(page({ start: 4, limit: 3 }).entries.map(entry => entry.id), [4, 5, 6]);
  assert.deepEqual(page({ start: 12, limit: 5 }).entries.map(entry => entry.id), [12]);
  const around = page({ around: 6, limit: 4 });
  assert.deepEqual([around.mode, around.focus, around.start, around.entries.map(entry => entry.id)], ["around", 6, 4, [4, 5, 6, 7]]);
  assert.equal(page({ around: 0, limit: 4 }).start, 0);
  assert.equal(page({ around: 12, limit: 4 }).start, 9);
  assert.equal(page({ around: 2, limit: 100 }).start, 0);
});

test("search finds pieces by text, keeping a leading space and the whole-piece choice", () => {
  const found = page({ search: "hello" });
  assert.deepEqual([found.mode, found.matches, found.entries.map(entry => entry.id)], ["search", 3, [2, 3, 4]]);
  assert.deepEqual(page({ search: " hello" }).entries.map(entry => entry.id), [2]);
  assert.deepEqual(page({ search: "hello", exact: true }).entries.map(entry => entry.id), [3]);
  assert.deepEqual(page({ search: "HELLO", exact: true }).entries.map(entry => entry.id), []);
  assert.equal(page({ search: "nothing like this" }).matches, 0);
  const capped = page({ search: "e", limit: 2 });
  // The escape text of a piece that is only part of a character (\xE4\xB9) is not searchable.
  assert.deepEqual([capped.matches, capped.entries.length], [6, 2]);
  assert.equal(page({ search: "xe4" }).matches, 0);
  assert.equal(page({ search: "\\xE4\\xB9", exact: true }).matches, 0);
  assert.deepEqual(page({ search: "" }).mode, "browse");
});

test("bad queries are rejected with the allowed range", () => {
  for (const [query, message] of [[{ limit: 0 }, /limit must be a whole number from 1 to 500/], [{ limit: "5" }, /limit/], [{ limit: 501 }, /limit/], [{ start: 13 }, /start must be a whole number from 0 to 12/], [{ start: -1 }, /start/], [{ around: 1.5 }, /around/], [{ around: 13 }, /around must be a whole number from 0 to 12/], [{ search: 5 }, /search must be text/], [{ search: "x".repeat(201) }, /at most 200/]] as const) {
    assert.throws(() => vocabulary.page(query), message);
  }
});

test("SentencePiece and unknown tokenizers are decoded or shown as stored", () => {
  const sp = Vocabulary.parse("llama", { "tokenizer.ggml.model": "llama", "tokenizer.ggml.tokens": ["<unk>", "<s>", "<0x0A>", "▁the", "<0xE4>", "<0xZZ>", "a"], "tokenizer.ggml.token_type": [2, 3, 6, 1, 6, 6, 1] })!;
  const entries = (sp.page({}) as { entries: { piece: string; kind: string; hex: string; partial: boolean }[] }).entries;
  assert.deepEqual(entries.map(entry => [entry.piece, entry.kind, entry.hex, entry.partial]), [
    ["<unk>", "unknown", "3C 75 6E 6B 3E", false], ["<s>", "control", "3C 73 3E", false], ["\n", "byte", "0A", false], [" the", "normal", "20 74 68 65", false], ["\\xE4", "byte", "E4", true], ["<0xZZ>", "byte", "3C 30 78 5A 5A 3E", false], ["a", "normal", "61", false],
  ]);
  assert.equal((sp.page({}) as { entries: { special?: { label: string } }[] }).entries[1]!.special?.label, "start of prompt");
  assert.match((sp.page({}) as { tokenizer_note: string }).tokenizer_note, /^SentencePiece/);
  const other = Vocabulary.parse("m", { "tokenizer.ggml.model": "bert", "tokenizer.ggml.tokens": ["▁x", "ü"] })!;
  assert.deepEqual((other.page({}) as { entries: { piece: string }[] }).entries.map(entry => entry.piece), ["▁x", "ü"]);
  assert.match((other.page({}) as { tokenizer_note: string }).tokenizer_note, /Tokenizer type “bert”.*as stored/);
  const bare = Vocabulary.parse("m", { "tokenizer.ggml.tokens": ["a"], "tokenizer.ggml.token_type": [9] })!;
  const result = bare.page({}) as { tokenizer: string; entries: { kind: string }[] };
  assert.deepEqual([result.tokenizer, result.entries[0]!.kind], ["unknown", "normal"]);
  // An unmapped character in a byte-level piece keeps its own UTF-8 bytes.
  assert.equal((Vocabulary.parse("m", { "tokenizer.ggml.model": "gpt2", "tokenizer.ggml.tokens": ["日"] })!.page({}) as { entries: { piece: string }[] }).entries[0]!.piece, "日");
});

test("a response without a token list is not a vocabulary", () => {
  for (const value of [undefined, null, "x", {}, { "tokenizer.ggml.tokens": [] }, { "tokenizer.ggml.tokens": [1, 2] }, { "tokenizer.ggml.tokens": "ab" }]) assert.equal(Vocabulary.parse("m", value), undefined);
});

class Port {
  asked: unknown[] = [];
  constructor(private readonly show: () => Promise<Record<string, unknown>>) {}
  async *streamChat(): AsyncGenerator<string> {}
  async request(endpoint: string, payload: unknown): Promise<Record<string, unknown>> { this.asked.push([endpoint, payload]); return this.show(); }
}
const harness = (port: unknown) => new NodeHarness({ workspace: "/tmp", model: "qwen3:8b", contextLength: 4096, ollama: port as never });

test("the harness reads the vocabulary once per model and answers queries from it", async () => {
  const port = new Port(async () => ({ model_info: info }));
  const backend = harness(port);
  const first = await backend.vocabulary({ search: "hello" });
  assert.deepEqual(port.asked, [["show", { model: "qwen3:8b", verbose: true }]]);
  assert.equal((first as { matches: number }).matches, 3);
  assert.equal(((await backend.vocabulary({ around: 9, limit: 3 })) as { focus: number }).focus, 9);
  assert.equal(port.asked.length, 1);
  backend.state.model = "other";
  await backend.vocabulary({});
  assert.equal(port.asked.length, 2);
  await assert.rejects(() => backend.vocabulary({ limit: 0 }), /limit must be/);
});

test("the harness explains why a vocabulary is unavailable instead of failing", async () => {
  const noTokens = await harness(new Port(async () => ({ model_info: { "general.architecture": "x" } }))).vocabulary({});
  assert.deepEqual(noTokens, { available: false, reason: "This model did not publish its vocabulary. Local Ollama models do; most remote providers keep their tokenizer private, and the token viewer shows only counts for them." });
  assert.equal(((await harness(new Port(async () => ({ template: "t" }))).vocabulary({})) as { available: boolean }).available, false);
  const down = await harness(new Port(async () => { throw new Error("connect ECONNREFUSED"); })).vocabulary({});
  assert.deepEqual(down, { available: false, reason: "The model service did not answer. Check that it is running, then reopen this view." });
  const noRequest = await harness({ async *streamChat() {} }).vocabulary({});
  assert.equal((noRequest as { available: boolean }).available, false);
});

test("an adapter without tokenizer details and the router both report an empty vocabulary", async () => {
  assert.deepEqual(await new LegacyModelAdapter(new Port(async () => ({ model_info: info })) as never).vocabularyInfo("m"), info);
  const router = new ProviderRouter(async () => { throw new Error("no network"); }, {});
  router.setLegacy("ollama", new Port(async () => ({ model_info: info })) as never);
  assert.deepEqual(await router.vocabularyInfo("m"), info);
  router.selected = "gemini";
  assert.deepEqual(await router.vocabularyInfo("m"), {});
});

test("the browser runtime serves the vocabulary through its worker route", async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  const { BrowserHarness } = await import("../src/browser/harness.js");
  const { BrowserStorage } = await import("../src/browser/storage.js");
  const { WorkerHost } = await import("../src/browser/worker-host.js");
  const { browserFetch } = await import("../src/browser/fetch.js");
  const storage = await BrowserStorage.open("vocabulary", new IDBFactory());
  const backend = await BrowserHarness.open({ storage, library: { agents: {}, prompts: {}, skills: {} }, seed: {}, model: "qwen3:8b", contextLength: 4096, modelPort: new Port(async () => ({ model_info: info })) as never });
  try {
    const messages: { type: string; value?: unknown }[] = [];
    await new WorkerHost(async () => backend, message => messages.push(message as never)).handle({ id: "v", action: "vocabulary", payload: { search: "hello", exact: true } });
    assert.deepEqual((messages[0]!.value as { entries: { id: number }[] }).entries.map(entry => entry.id), [3]);
    const calls: unknown[] = [];
    const response = await browserFetch({ call: async (action: string, payload: unknown) => { calls.push([action, payload]); return { available: false, reason: "r" }; } } as never)("/vocabulary", { method: "POST", body: JSON.stringify({ around: 2 }) });
    assert.deepEqual(calls, [["vocabulary", { around: 2 }]]);
    assert.deepEqual(await response.json(), { available: false, reason: "r" });
  } finally { await backend.close(); await storage.close(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { TokenHelperClient } from '../src/browser/token-helper.js';
import { WorkerHost, type RpcMessage } from '../src/browser/worker-host.js';
import { HELPER_DEFAULT_ENDPOINT, HelperError } from '../src/helper-protocol.js';
import { helperFixture } from './helper-fixture.js';
import type { ModelRequest } from '../src/core.js';

const payload: ModelRequest = { model: 'qwen3:8b', provider: 'ollama', messages: [{ role: 'user', content: 'hello' }], stream: true, options: { num_ctx: 4096 } };
const origin = 'https://harness.test';
const library = { agents: {}, skills: {}, prompts: {} };
const pieces = { identity: 'Ollama-reported GGUF sha256-fixture', tokens: [{ id: 151644, bytes: [...new TextEncoder().encode('<|im_start|>')] }, { id: 195, bytes: [195] }, { id: 188, bytes: [188] }] };
const withOrigin = (value = origin) => (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers, origin: value } });

test('the client speaks the helper protocol: info, tokenize, refusals, version mismatch and unreachable helper', async t => {
  const helper = await helperFixture({ origins: [origin], tokens: model => model === payload.model ? pieces : undefined }); t.after(() => helper.close());
  const client = new TokenHelperClient(helper.base, withOrigin());
  assert.equal(client.connected, false); assert.equal(client.info, undefined);
  await assert.rejects(client.tokenize(payload.model, 'x'), /disconnected/);
  assert.deepEqual(await client.connect(), { protocol: 2, ollamaUrl: 'http://localhost:11434', models: [], automatic: true });
  assert.equal(client.connected, true); assert.equal(client.info!.automatic, true);
  assert.deepEqual(await client.tokenize(payload.model, 'hello ü'), pieces);
  assert.deepEqual(helper.requests.at(-1), { route: '/v1/tokenize', body: { model: payload.model, content: 'hello ü' } });
  // The helper answered but has no vocabulary for this model: its own explanation is passed on, and it stays connected.
  await assert.rejects(client.tokenize('other', 'x'), (error: HelperError) => { assert.match(error.message, /did not report a usable model file/); assert.equal(error.status, 422); assert.equal(error.failure.source, 'helper'); return true; });
  assert.equal(client.connected, true);
  client.close(); assert.equal(client.connected, false);
  // Another website is refused by the helper itself.
  const foreign = new TokenHelperClient(helper.base, withOrigin('https://evil.test'));
  await assert.rejects(foreign.connect(), /denied the request \(403\)\. Start it with this website allowed\./); assert.equal(foreign.connected, false);
  // Nothing listens, or the answer is not this protocol.
  await assert.rejects(new TokenHelperClient('http://127.0.0.1:1', withOrigin()).connect(), (error: HelperError) => { assert.match(error.message, /unavailable/); assert.equal(error.failure.timeoutMs, 60_000); return true; });
  const old = await helperFixture({ origins: [origin], protocol: 1 }); t.after(() => old.close());
  const outdated = new TokenHelperClient(old.base, withOrigin());
  await assert.rejects(outdated.connect(), /different version/); assert.equal(outdated.connected, false);
  const scripted = (answers: Response[]) => new TokenHelperClient(HELPER_DEFAULT_ENDPOINT, async () => answers.shift()!);
  for (const value of [null, { protocol: 2 }, { protocol: 2, ollamaUrl: 'http://localhost:11434' }]) await assert.rejects(scripted([Response.json({ value })]).connect(), /different version/);
  const info = () => Response.json({ value: { protocol: 2, ollamaUrl: 'http://localhost:11434', models: [], automatic: true } });
  for (const value of [null, { identity: 'x' }, { tokens: [] }]) { const client = scripted([info(), Response.json({ value })]); await client.connect(); await assert.rejects(client.tokenize('m', 'x'), /returned no token pieces/); }
  for (const answer of [new Response('not json', { status: 422 }), Response.json({}, { status: 422 }), new Response('', { status: 500 })]) {
    const client = scripted([info(), answer]); await client.connect();
    await assert.rejects(client.tokenize('m', 'x'), /denied the request \((422|500)\)\.$/); assert.equal(client.connected, true);
  }
  const stop = new AbortController(), slow = new TokenHelperClient(HELPER_DEFAULT_ENDPOINT, async (url, init) => url.endsWith('/info') ? info()
    : new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  await slow.connect(); const pending = slow.tokenize('m', 'x', stop.signal); stop.abort();
  await assert.rejects(pending, /cancelled/); assert.equal(slow.connected, false);
  for (const endpoint of ['https://127.0.0.1:5002', 'http://localhost:5002', 'http://127.0.0.1:5002/x', 'http://127.0.0.1:5002/?q=1', 'http://127.0.0.1:5002/#h', 'http://u:p@127.0.0.1:5002', 'not a url'])
    assert.throws(() => new TokenHelperClient(endpoint), /on this computer/);
});

test('the browser backend gets token pieces through the helper, remembers it and reconnects without being asked', async t => {
  let helper = await helperFixture({ origins: [origin], tokens: model => model === payload.model ? pieces : undefined });
  t.after(() => helper.close());
  const rawFetch = globalThis.fetch, base = helper.base, port = helper.port; let render = true, ollamaCalls = 0, helperCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith(HELPER_DEFAULT_ENDPOINT)) throw new Error('nothing listens on the default port in this test');
    if (url.startsWith('http://127.0.0.1:')) { helperCalls++; return rawFetch(url, { ...init, headers: { ...init.headers, origin } }); }
    ollamaCalls++; assert.match(url, /\/api\/chat$/); assert.equal(JSON.parse(String(init.body))._debug_render_only, true);
    return Response.json(render ? { _debug_info: { rendered_template: 'hello ü' } } : {});
  });
  const storage = new MemoryStorage();
  const harness = await BrowserHarness.open({ storage, library, seed: {}, model: payload.model });
  async function inspect(backend: BrowserHarness, request: ModelRequest = payload) {
    const record = backend.activeSessionRecord(); record.events.push({ type: 'request', provider: 'ollama', model_request: request });
    const copy = await backend.importSession(record); await backend.activateSession(copy.id); return backend.tokenize(record.events.length - 1);
  }
  // Not enabled: the helper is never contacted, and the default address is only a suggestion.
  assert.deepEqual(harness.tokenizerStatus(), { enabled: false, connected: false, endpoint: HELPER_DEFAULT_ENDPOINT });
  assert.deepEqual((await harness.bootstrap()).tokenizer, harness.tokenizerStatus());
  assert.match((await inspect(harness)).explanation, /no matching tokenizer service/); assert.equal(helperCalls, 0);
  await assert.rejects(harness.connectTokenizer('http://example.test:5002'), /on this computer/);
  await assert.rejects(harness.connectTokenizer('http://127.0.0.1:1'), /unavailable/);
  await assert.rejects(harness.connectTokenizer(), /unavailable/);
  assert.equal(harness.tokenizerStatus().enabled, false); assert.equal(await storage.get('settings', 'tokenizer-helper'), undefined);
  assert.deepEqual(await harness.connectTokenizer(base), { enabled: true, connected: true, endpoint: base, protocol: 2, ollamaUrl: 'http://localhost:11434', models: [], automatic: true });
  assert.deepEqual(await storage.get('settings', 'tokenizer-helper'), { endpoint: base });
  // The page renders the prompt with Ollama; the helper only splits that text, and its bytes are kept as they are.
  helper.requests.length = 0; ollamaCalls = 0;
  const result = await inspect(harness);
  assert.equal(result.fidelity, 'configured-tokenizer'); assert.equal(result.count, 3); assert.equal(result.renderedPrompt, 'hello ü');
  assert.equal(result.source, 'llama.cpp tokenizer: Ollama-reported GGUF sha256-fixture');
  assert.deepEqual(result.groups[0]!.tokens.map(token => [token.id, token.bytes.length, token.special?.label !== undefined]), [['151644', 12, true], ['195', 1, false], ['188', 1, false]]);
  assert.equal(ollamaCalls, 1); assert.deepEqual(helper.requests, [{ route: '/v1/tokenize', body: { model: payload.model, content: 'hello ü' } }]);
  // The helper's own explanation reaches the viewer when it has no vocabulary for a model.
  assert.match((await inspect(harness, { ...payload, model: 'other' })).explanation, /tokenization failed: Ollama did not report a usable model file/);
  // Both sides must mean the same Ollama; without a rendered prompt there is nothing to split.
  await storage.put('settings', 'ollama-url', 'http://other'); helper.requests.length = 0;
  assert.match((await inspect(harness)).explanation, /different Ollama URLs/); assert.equal(helper.requests.length, 0);
  await storage.put('settings', 'ollama-url', undefined);
  render = false; assert.match((await inspect(harness)).explanation, /rendered prompt/); assert.equal(helper.requests.length, 0); render = true;
  // Other providers never use the helper. Locking credentials does not concern it: it holds none.
  assert.equal((await inspect(harness, { ...payload, provider: 'openai' })).fidelity, 'unavailable'); assert.equal(helper.requests.length, 0);
  await harness.lockCredentials(); assert.equal(harness.tokenizerStatus().connected, true);
  assert.equal((await harness.connectTokenizer()).connected, true);
  await harness.close();

  // A later visit: the choice is remembered, nothing is contacted at startup, and the first inspection reconnects by itself.
  helperCalls = 0;
  const later = await BrowserHarness.open({ storage, library, seed: {}, model: payload.model }); t.after(() => later.close());
  assert.deepEqual(later.tokenizerStatus(), { enabled: true, connected: false, endpoint: base }); assert.equal(helperCalls, 0);
  assert.equal((await inspect(later)).fidelity, 'configured-tokenizer'); assert.equal(later.tokenizerStatus().connected, true);
  // The helper stops: inspection continues without pieces and the choice is kept. When it runs again, pieces return unasked.
  await helper.close();
  assert.match((await inspect(later)).explanation, /tokenization failed: Tokenizer helper unavailable/); assert.deepEqual(later.tokenizerStatus(), { enabled: true, connected: false, endpoint: base });
  assert.match((await inspect(later)).explanation, /no matching tokenizer service/);
  helper = await helperFixture({ origins: [origin], tokens: () => pieces }, port);
  assert.equal((await inspect(later)).fidelity, 'configured-tokenizer');
  // Forgetting disconnects and stops reconnecting; the Worker transport exposes the same actions.
  assert.deepEqual(await later.forgetTokenizer(), { enabled: false, connected: false, endpoint: HELPER_DEFAULT_ENDPOINT });
  assert.equal(await storage.get('settings', 'tokenizer-helper'), undefined); await later.forgetTokenizer();
  helper.requests.length = 0; assert.match((await inspect(later)).explanation, /no matching tokenizer service/); assert.equal(helper.requests.length, 0);
  const messages: RpcMessage[] = [], worker = new WorkerHost(async () => later, message => messages.push(message));
  await worker.handle({ id: 'a', action: 'connectTokenizer', payload: { endpoint: base } });
  await worker.handle({ id: 'b', action: 'tokenizerStatus', payload: {} });
  await worker.handle({ id: 'c', action: 'connectTokenizer', payload: {} });
  await worker.handle({ id: 'd', action: 'forgetTokenizer', payload: {} });
  assert.deepEqual(messages.map(message => (message as { value: { enabled: boolean; connected: boolean } }).value).map(value => [value.enabled, value.connected]), [[true, true], [true, true], [true, true], [false, false]]);
});

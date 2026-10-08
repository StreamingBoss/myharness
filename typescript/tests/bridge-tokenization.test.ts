import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeBridge, createBridgeServer } from '../src/node/bridge.js';
import { bridgeMain } from '../src/node/bridge-cli.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';
import type { ModelRequest } from '../src/core.js';
import type { FetchLike } from '../src/ollama.js';

const payload: ModelRequest = { model: 'qwen3:8b', provider: 'ollama', messages: [{ role: 'user', content: 'hello' }], stream: true, options: { num_ctx: 4096 } };
const binding = { url: 'http://tokenizer.test', alias: 'qwen3:8b', identity: 'matching GGUF sha256 verified' };
const grants = { writes: false, commands: false, gitWrites: false };

test('bridge inspection validates model and endpoint, preserves bytes, and cancels local requests', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-token-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = []; let block = false;
  const inspectionFetch: FetchLike = async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'error');
    if (block) { await new Promise<void>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }
    if (url.endsWith('/api/chat')) { const request = JSON.parse(init.body!); assert.equal(request._debug_render_only, true); return Response.json({ _debug_info: { rendered_template: 'hello ü' } }); }
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: binding.alias }] });
    assert.equal(url, 'http://tokenizer.test/tokenize'); assert.equal(JSON.parse(init.body!).add_special, false);
    return Response.json({ tokens: [{ id: 4, piece: [195] }, { id: 5, piece: [188] }] });
  };
  const service = new NativeBridge({ workspace: root, origin: 'https://guide.test', grants, tokenizers: { [payload.model]: binding }, inspectionFetch });
  const { token } = service.pair(service.code); let id = 0;
  const call = (args: Record<string, unknown>) => service.call(token, { id: String(++id), operation: 'inspectTokens', args });
  assert.deepEqual((await service.snapshot()).tokenization, { models: [payload.model], ollamaUrl: 'http://localhost:11434' });
  const result = await call({ payload, ollamaUrl: 'http://localhost:11434' }) as { fidelity: string; groups: unknown; source: string };
  assert.equal(result.fidelity, 'configured-tokenizer'); assert.match(result.source, /matching GGUF/);
  assert.deepEqual(result.groups, [{ label: 'Ollama-rendered prompt', tokens: [{ id: '4', bytes: [195] }, { id: '5', bytes: [188] }] }]);
  for (const args of [{ payload: {} }, { payload: { ...payload, provider: 'openai' } }, { payload: { ...payload, provider: undefined, model: 'toString' }, ollamaUrl: 'http://localhost:11434' }, { payload, ollamaUrl: 'http://other' }, { payload }]) await assert.rejects(call(args));
  assert.equal(calls.length, 3);
  block = true; const pending = call({ payload: { ...payload, provider: undefined }, ollamaUrl: 'http://localhost:11434' });
  await service.call(token, { id: 'cancel', operation: 'cancel', args: { id: String(id) } }); await assert.rejects(pending, /cancelled/); service.close();
  for (const ollamaUrl of ['ftp://x', 'http://u:p@x', 'http://x/?q=x', 'http://x/#x']) assert.throws(() => new NativeBridge({ workspace: root, origin: 'https://guide.test', grants, ollamaUrl }));
  assert.throws(() => new NativeBridge({ workspace: root, origin: 'https://guide.test', grants, tokenizers: { model: { ...binding, alias: '' } } }));
});

test('browser backend inspects saved requests through a real bridge without direct tokenizer access', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-browser-token-')); t.after(() => rm(root, { recursive: true, force: true }));
  const rawFetch = globalThis.fetch; let fail = false, render = true; const upstream: string[] = [];
  const service = new NativeBridge({ workspace: root, origin: 'https://guide.test', grants, tokenizers: { [payload.model]: binding } });
  const host = createBridgeServer(service); await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(() => { host.closeAllConnections(); host.close(); });
  const base = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith(base)) return rawFetch(url, { ...init, headers: { ...init.headers, origin: service.origin } });
    upstream.push(url); assert.equal(init.redirect, 'error'); if (fail) throw new Error('private details');
    if (url.endsWith('/api/chat')) return Response.json(render ? { _debug_info: { rendered_template: 'hello' } } : {});
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: binding.alias }] });
    return Response.json({ tokens: [{ id: 9, piece: 'hello' }] });
  });
  const storage = new MemoryStorage();
  const harness = await BrowserHarness.open({ storage, library: { agents: {}, skills: {}, prompts: {} }, seed: {}, model: payload.model });
  t.after(() => harness.close());
  await harness.attachBridge(base, service.code);
  async function inspect(request = payload) {
    const record = harness.activeSessionRecord(); record.events.push({ type: 'request', provider: 'ollama', model_request: request });
    const copy = await harness.importSession(record); await harness.activateSession(copy.id); return harness.tokenize(record.events.length - 1);
  }
  assert.match((await inspect({ ...payload, model: 'other' })).explanation, /exact Ollama model/); assert.equal(upstream.length, 0);
  await storage.put('settings', 'ollama-url', 'http://other'); assert.match((await inspect()).explanation, /URLs differ/); assert.equal(upstream.length, 0);
  await storage.put('settings', 'ollama-url', undefined);
  const result = await inspect(); assert.equal(result.fidelity, 'configured-tokenizer'); assert.equal(result.count, 1);
  assert.deepEqual(upstream, ['http://localhost:11434/api/chat', 'http://tokenizer.test/v1/models', 'http://tokenizer.test/tokenize']);
  fail = true; assert.match((await inspect()).explanation, /failed/); fail = false; render = false;
  assert.match((await inspect()).explanation, /rendered prompt/);
  await harness.detachBridge();
});

test('CLI accepts operator tokenizer configuration without persisting or printing endpoint credentials', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-cli-token-')); t.after(() => rm(root, { recursive: true, force: true }));
  const args = ['--workspace', root, '--origin', 'https://guide.test', '--port', '0'];
  await assert.rejects(bridgeMain(args, () => undefined, 'linux', { MYHARNESS_TOKENIZERS: '{' }));
  const output: string[] = [];
  const server = await bridgeMain(args, line => output.push(line), 'linux', { MYHARNESS_TOKENIZERS: JSON.stringify({ [payload.model]: binding }), OLLAMA_URL: 'http://ollama.test' });
  assert.ok(!output.join('').includes(binding.url)); await new Promise<void>(resolve => server!.close(() => resolve()));
});

test('browser preserves ordinary and legacy-bridge inspection when no tokenizer is advertised', async t => {
  let metadata: Record<string, unknown> | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/pair')) return Response.json({ value: { token: 'fixture' } });
    if (url.endsWith('/call')) {
      const request = JSON.parse(String(init.body));
      if (request.operation === 'snapshot') return Response.json({ value: { project: { format: 'myharness-project', version: 1, root: '/bridge-workspace', files: {}, directories: [''] }, git: false, grants, ...metadata } });
      return Response.json({ value: {} });
    }
    return Response.json({});
  });
  const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library: { agents: {}, skills: {}, prompts: {} }, seed: {}, model: payload.model });
  t.after(() => harness.close());
  async function inspect(request: ModelRequest = payload) {
    const record = harness.activeSessionRecord(); record.events.push({ type: 'request', provider: 'ollama', model_request: request });
    const copy = await harness.importSession(record); await harness.activateSession(copy.id); return harness.tokenize(record.events.length - 1);
  }
  assert.match((await inspect()).explanation, /rendered prompt/);
  await harness.attachBridge('http://127.0.0.1:5002', 'code');
  assert.match((await inspect()).explanation, /rendered prompt/); await harness.detachBridge();
  metadata = { tokenization: { models: [], ollamaUrl: 'http://localhost:11434' } };
  await harness.attachBridge('http://127.0.0.1:5002', 'code');
  assert.match((await inspect({ model: payload.model, messages: payload.messages, stream: true, options: payload.options })).explanation, /rendered prompt/);
  assert.equal((await inspect({ ...payload, provider: 'openai' })).fidelity, 'unavailable');
  await harness.setProject('/workspace'); await harness.lockCredentials(); assert.match((await inspect()).explanation, /rendered prompt/);
  await harness.configureModel({ provider: 'demo' });
  const record = harness.activeSessionRecord(); record.events.push({ type: 'request', provider: 'demo', model_request: { ...payload, model: 'scripted-demo', provider: 'demo' } });
  const copy = await harness.importSession(record); await harness.activateSession(copy.id);
  assert.match((await harness.tokenize(record.events.length - 1)).explanation, /scripted demo/);
});

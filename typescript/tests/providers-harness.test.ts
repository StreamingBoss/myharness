import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { Harness, type HarnessOptions } from '../src/harness.js';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { BrowserStorage } from '../src/browser/storage.js';
import { ProviderRouter } from '../src/providers.js';
import { CloudAdapter, type CloudProvider } from '../src/cloud.js';
import { ModelControls } from '../src/browser/model-controls.js';
import { createHarnessServer } from '../src/node/http.js';
import { loadHarness } from '../src/node/startup.js';
import { response, call, completeEvent, collect, sse, request } from './cloud.test.js';
import type { ModelRequest } from '../src/core.js';

const action = { message: 'Inspect', useMemory: true, tools: ['read_file', 'write_file'], askApproval: true, agent: '', prompt: '' };
const library = { agents: {}, prompts: {}, skills: {} };
for (const provider of ['gemini', 'openai', 'anthropic'] as const) {
  test(`${provider}: full headless loop keeps approvals, IDs, cancellation and compaction in the harness`, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'provider-harness-')); t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'README.md'), 'hello');
    let round = 0, summary = response(provider, 'A short summary'), first = true;
    const bodies: Record<string, unknown>[] = [];
    const adapter = new CloudAdapter(provider, async (_url, init) => {
      if (init.method === 'GET') return Response.json({});
      const body = JSON.parse(init.body!); bodies.push(body);
      if (!body.stream) return Response.json(summary);
      round++;
      const native = first ? response(provider, '', [call(provider, 'read', 'read_file', { path: 'README.md' }), call(provider, 'write', 'write_file', { path: 'draft.txt', content: 'draft' })]) : response(provider, 'done'); first = false;
      return sse(completeEvent(provider, native));
    }, 'SECRET');
    const harness = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192, provider, maxOutputTokens: 2048, modelAdapter: adapter, sessions: new SessionStore(path.join(root, 'sessions')) }); await harness.initialize();
    const events = [];
    for await (const event of harness.submit(action)) { events.push(event); if (event.type === 'approval') harness.approve(String(event.id), false); }
    assert.equal(round, 2); assert.equal(events.filter(e => e.type === 'tool').length, 2);
    assert.equal(harness.state.memory.find(m => m.role === 'tool')!.tool_call_id, 'read');
    await assert.rejects(readFile(path.join(root, 'draft.txt')));
    const wire = events.find(e => e.type === 'request')!; assert.ok(wire.wire_request); assert.match(JSON.stringify(wire.parts), /stream/);
    assert.ok(!JSON.stringify(harness.activeSessionRecord()).includes('SECRET'));
    first = true;
    for await (const event of harness.submit(action)) if (event.type === 'approval') harness.approve(String(event.id), true);
    assert.equal(await readFile(path.join(root, 'draft.txt'), 'utf8'), 'draft');
    assert.ok((await harness.explore({ useMemory: true, tools: [], agent: '', prompt: '' })).template);
    const record = harness.activeSessionRecord(), imported = await harness.importSession(record); await harness.activateSession(imported.id);
    assert.equal(harness.inspect().provider, provider); assert.equal(harness.state.memory[1]!.continuation!.provider, provider);
    harness.state.memory.unshift({ role: 'user', content: 'old '.repeat(1000) }, { role: 'assistant', content: 'old '.repeat(1000) });
    const compact = await collect(harness.compact()); assert.ok(compact.some(e => e.action === 'compact')); assert.equal(bodies.at(-1)!.tools, undefined);
    const compactBody = bodies.at(-1)!; assert.equal(compactBody[provider === 'anthropic' ? 'max_tokens' : provider === 'gemini' ? 'generation_config' : 'max_output_tokens'] !== undefined, true);
    harness.state.memory.unshift({ role: 'user', content: 'old '.repeat(1000) }, { role: 'assistant', content: 'old '.repeat(1000) });
    summary = { ...response(provider, 'bad'), ...(provider === 'anthropic' ? { stop_reason: 'max_tokens' } : { status: 'incomplete' }) };
    const before = JSON.stringify(harness.state.memory); assert.ok((await collect(harness.compact())).some(e => e.action === 'error')); assert.equal(JSON.stringify(harness.state.memory), before);
    first = true; await rm(path.join(root, 'draft.txt'));
    for await (const event of harness.submit(action)) if (event.type === 'approval') harness.stop();
    assert.ok(harness.activeSessionRecord().events.some(e => e.type === 'stopped'));
    const lastCalls = harness.state.memory.filter(m => m.tool_calls?.length).at(-1)!;
    assert.deepEqual(lastCalls.tool_calls!.map(c => c.id), ['read', 'write']);
    assert.equal((await harness.tokenize(harness.activeSessionRecord().events.findIndex(e => e.type === 'request'))).fidelity, 'unavailable');
  });
}

test('browser configuration keeps keys in Worker memory, persists provider selection and requires reconnection after reload', async t => {
  const factory = new IDBFactory(), storage = await BrowserStorage.open('providers', factory); t.after(() => storage.close());
  const requests: string[] = [];
  let remote: (url: string, init: RequestInit) => Promise<Response> = async url => { requests.push(url); return Response.json({}); };
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => remote(url, init));
  const backend = await BrowserHarness.open({ storage, library, seed: { 'README.md': 'hi' } });
  const original = backend.activeSessionRecord().id;
  await backend.configureModel({ provider: 'gemini', apiKey: 'PRIVATE' });
  assert.notEqual(backend.activeSessionRecord().id, original); assert.equal((await backend.bootstrap()).provider, 'gemini'); assert.equal((await backend.bootstrap()).ready, true);
  assert.ok(requests.every(url => !url.includes('PRIVATE'))); assert.ok(!JSON.stringify(await storage.all('sessions')).includes('PRIVATE')); assert.ok(!JSON.stringify(await storage.all('settings')).includes('PRIVATE'));
  assert.equal(backend.state.maxOutputTokens, 2048); assert.equal(backend.state.contextLength, 8192);
  const reopened = await BrowserHarness.open({ storage, library, seed: {} }); assert.equal((await reopened.bootstrap()).ready, false); assert.equal(reopened.state.provider, 'gemini');
  await assert.rejects(collect(reopened.submit(action)), /API key/); await assert.rejects(collect(reopened.compact()), /API key/); assert.match(String((await reopened.explore({ ...action })).template), /API key/);
  const retained = backend.activeSessionRecord().id; await backend.configureModel({ provider: 'gemini', apiKey: 'PRIVATE' }); assert.equal(backend.activeSessionRecord().id, retained);
  backend.forgetApiKey(); assert.equal((await backend.bootstrap()).ready, false);
  await backend.configureModel({ provider: 'gemini', apiKey: 'key', contextLength: 9000, maxOutputTokens: 1000 });
  const saved = backend.activeSessionRecord().id;
  remote = async () => new Response('PRIVATE', { status: 401 });
  await assert.rejects(backend.configureModel({ provider: 'openai', model: 'gpt-test', apiKey: 'PRIVATE' }), /API key/); assert.equal(backend.activeSessionRecord().id, saved);
  await assert.rejects(backend.configureModel({ provider: 'openai' }), /model ID/);
  for (const value of [{ provider: 'gemini', contextLength: -1 }, { provider: 'gemini', maxOutputTokens: 1.5 }, { mode: 'demo', model: 7 }]) await assert.rejects(backend.configureModel(value as never));
  remote = async () => Response.json({});
  await assert.rejects(backend.configureModel({ provider: 'gemini', apiKey: 'key', contextLength: 100, maxOutputTokens: 100 }), /smaller/);
  let release!: () => void;
  remote = async (_url, init) => new Promise<Response>((resolve, reject) => { release = () => resolve(Response.json({})); init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  const pending = backend.configureModel({ provider: 'openai', model: 'gpt-test', apiKey: 'key' });
  await assert.rejects(backend.newSession(), /running/); assert.throws(() => backend.forgetApiKey(), /running/); backend.stop(); await assert.rejects(pending, /stopped/); assert.equal(backend.activeSessionRecord().id, saved); release();
});

test('Node startup/cloud configuration and HTTP use environment credentials and preserve legacy sessions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'provider-start-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const provider of ['openai', 'anthropic'] as const) {
    const env = { MYHARNESS_ROOT: root, MYHARNESS_WORKSPACE: root, MYHARNESS_SESSIONS: path.join(root, provider), MYHARNESS_PROVIDER: provider, MYHARNESS_MODEL: 'test', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret' };
    const harness = await loadHarness(env); assert.equal(harness.state.provider, provider); assert.equal(harness.state.maxOutputTokens, 2048);
    await loadHarness({ ...env, MYHARNESS_MAX_OUTPUT_TOKENS: '1000' });
    await assert.rejects(loadHarness({ ...env, MYHARNESS_MAX_OUTPUT_TOKENS: '9000' }), /smaller/);
  }
  const router = new ProviderRouter(async () => Response.json({}), {}, 'openai', { openai: 'secret' });
  const harness = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192, modelAdapter: router, provider: 'openai' });
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close()); const address = server.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}/model`;
  const configure = (body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await configure({ provider: 'openai', model: 'test', apiKey: 'secret' })).status, 400);
  assert.equal((await configure({ provider: 'openai', model: 'test' })).status, 200);
  assert.throws(() => new NodeHarness({ workspace: root, model: 'x', contextLength: 100, modelAdapter: router, ollama: { async *streamChat() {} } }), /not both/);
  const injected = new NodeHarness({ workspace: root, model: 'x', contextLength: 100, ollama: { async *streamChat() {} } }); await assert.rejects(injected.configureModel({ mode: 'demo' }), /injected/); injected.forgetApiKey();
});

test('model UI controller clears credentials before connecting, updates state without reload and displays failures', async () => {
  let cleared = false, calls: string[] = [], shown: unknown, status = '', error: unknown;
  const controls = new ModelControls({ async call(action, payload) { calls.push(action); if (error) throw error; if (action === 'configureModel') { assert.equal(cleared, true); assert.equal(payload!.apiKey, 'key'); } return { provider: 'gemini' }; } },
    { settings: () => ({ provider: 'gemini', apiKey: 'key' }), clearKey: () => { cleared = true; }, status: value => { status = value; }, render: value => { shown = value; } });
  await controls.connect(); assert.deepEqual(calls, ['configureModel', 'bootstrap']); assert.deepEqual(shown, { provider: 'gemini' }); assert.equal(status, '');
  calls = []; await controls.forget(); assert.deepEqual(calls, ['forgetApiKey', 'bootstrap']);
  error = new Error('invalid key'); await controls.connect(); assert.equal(status, 'invalid key');
  error = 'offline'; await controls.forget(); assert.equal(status, 'offline');
});

test('incomplete, limited, refused and unmeasured replies never execute tools', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'provider-incomplete-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const provider of ['gemini', 'openai', 'anthropic'] as const) {
    for (const reason of ['max_tokens', 'blocked', 'unknown']) {
      const native = { ...response(provider, 'partial', [call(provider, 'edit', 'write_file', { path: 'unsafe', content: 'unsafe' })]), ...(provider === 'anthropic' ? { stop_reason: reason } : { status: reason }) };
      const harness = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192, provider, modelAdapter: new CloudAdapter(provider, async () => sse(completeEvent(provider, native)), 'key') });
      const events = await collect(harness.submit(action)); assert.ok(events.some(e => e.type === 'stopped')); assert.equal(events.some(e => e.type === 'tool'), false);
    }
    const native = response(provider, 'done'); delete native.usage;
    const harness = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192, provider, modelAdapter: new CloudAdapter(provider, async () => sse(completeEvent(provider, native)), 'key') });
    assert.match(String((await collect(harness.submit(action))).find(e => e.type === 'response')!.tokens), /unknown/);
  }
  await assert.rejects(readFile(path.join(root, 'unsafe')));
  const port = { async *streamChat() { yield JSON.stringify({ message: { content: 'legacy' }, done: true }); } };
  const legacy = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192, ollama: port }); assert.equal((await collect(legacy.streamChat(request()))).length, 1);
  const broken = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192, ollama: { async *streamChat() { throw new Error('network'); } } }); await assert.rejects(collect(broken.streamChat(request())), /network/); broken.stop(); assert.deepEqual(await collect(broken.streamChat(request())), []);
  const missing = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192, modelAdapter: { prepare: () => ({}), describe: async () => ({ provider: 'test', ready: true, template: '', parameters: '' }), ready: () => true, async *stream() {}, complete: async () => { throw new Error('unused'); } } });
  assert.match(String((await collect(missing.submit(action))).find(e => e.type === 'stopped')!.reason), /completed response/);
});

test('reconnection preserves memory; recovery matches IDs and configuration cancellation rolls back', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'provider-recovery-')); t.after(() => rm(root, { recursive: true, force: true }));
  let backend: NodeHarness;
  const router = new ProviderRouter(async () => { backend.stop(); return Response.json({}); }, {}, 'openai', { openai: 'key' });
  backend = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192, provider: 'openai', modelAdapter: router, sessions: new SessionStore(path.join(root, 'sessions')) });
  const original = backend.activeSessionRecord().id;
  await assert.rejects(backend.configureModel({ provider: 'openai', model: 'test' }), /stopped/); assert.equal(backend.activeSessionRecord().id, original);
  const record = backend.activeSessionRecord(); record.memory = [{ role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'pwd' } }, { id: 'b', function: { name: 'pwd' } }] }, { role: 'tool', tool_name: 'pwd', tool_call_id: 'b', content: 'done' }];
  const imported = await backend.importSession(record); await backend.activateSession(imported.id);
  assert.deepEqual(backend.state.memory.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['b', 'a']);
  backend.state.memory = [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'pwd' } }, { function: { name: 'pwd' } }] }, { role: 'tool', tool_name: 'pwd', content: 'done' }];
  const legacy = { ...backend.activeSessionRecord(), memory: backend.state.memory }; const importedLegacy = await backend.importSession(legacy); await backend.activateSession(importedLegacy.id); assert.equal(backend.state.memory.length, 3);
  for (const env of [{}, { GOOGLE_CLOUD_PROJECT: 'p' }]) await assert.rejects(loadHarness({ MYHARNESS_ROOT: root, MYHARNESS_PROVIDER: 'vertex', MYHARNESS_MODEL: 'test', ...env }));
  const ordinary = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192 }); ordinary.forgetApiKey();
  t.mock.method(globalThis, 'fetch', async () => Response.json({})); await assert.rejects(ordinary.configureModel({ mode: 'ollama' }), /Could not connect/);
  await ordinary.configureModel({ mode: 'ollama', contextLength: 8192 });
});


test('shared adapter optional inspection and malformed summaries remain safe', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'provider-boundary-')); t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = { prepare: () => ({}), describe: async () => ({ provider: 'test', ready: true, template: undefined, parameters: undefined } as never), ready: () => true, async *stream() {}, complete: async () => ({ message: { role: 'assistant', content: undefined }, usage: {}, status: 'completed', raw: {} } as never) };
  const backend = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192, modelAdapter: adapter });
  const shared = { ...(backend as unknown as { options: HarnessOptions }).options }; delete shared.modelAdapter;
  assert.throws(() => new Harness(shared), /Supply a model adapter/);
  assert.equal((await backend.explore({ useMemory: true, tools: [], agent: '', prompt: '' })).template, '');
  backend.state.memory = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: 'old '.repeat(200) }));
  assert.match(String((await collect(backend.compact())).at(-1)!.reason), /invalid summary/);
  backend.recordEvent({ type: 'request', parts: [JSON.stringify(request('gemini'))], provider: 'gemini' });
  assert.equal((await backend.tokenize(backend.activeSessionRecord().events.length - 1)).fidelity, 'unavailable');
});

test('Gemini reads a file on the third turn using documented streamed argument fragments', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'gemini-third-turn-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'README.md'), 'third-turn file');
  let round = 0;
  const adapter = new CloudAdapter('gemini', async (_url, init) => {
    round++;
    if (round !== 3) {
      if (round === 4) assert.match(init.body!, /third-turn file/);
      return sse(completeEvent('gemini', response('gemini', 'done')));
    }
    return sse([
      { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'read-3', name: 'read_file', arguments: {} } },
      { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"path":' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '"README.md"}' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: { status: 'requires_action' } },
    ], 1);
  }, 'key');
  const harness = new NodeHarness({ workspace: root, model: 'test', provider: 'gemini', contextLength: 8192, modelAdapter: adapter });
  for (let turn = 0; turn < 2; turn++) await collect(harness.submit(action));
  const events = await collect(harness.submit({ ...action, message: 'Read README.md' }));
  assert.equal(events.some(event => String(event.reason).includes('Missing required')), false);
  assert.equal(events.filter(event => event.type === 'tool').length, 1);
  assert.equal(harness.state.memory.find(message => message.tool_call_id === 'read-3')!.content.includes('third-turn file'), true);
  assert.equal(round, 4);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { projectFromFiles } from '../src/browser/workspace.js';
import { BridgeClient } from '../src/browser/bridge.js';
import type { RuntimePort } from '../src/runtime.js';

const library = { agents: {}, skills: {}, prompts: {} };
const open = (storage = new MemoryStorage()) => BrowserHarness.open({ storage, library, seed: { 'README.md': 'browser file' } });

test('the backend reports a connected model only after a real model is chosen, and never stores its key', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => String(url).endsWith('/api/show')
    ? Response.json({ model_info: { 'general.architecture': 'q', 'q.context_length': 4096 } }) : Response.json({}));
  const storage = new MemoryStorage(), harness = await open(storage);
  let state = await harness.bootstrap();
  assert.equal(state.model_connected, false); assert.equal(state.provider, 'ollama'); assert.equal(state.ready, true);
  // A failed attempt leaves the page on its connect card.
  await assert.rejects(harness.configureModel({ provider: 'ollama', model: 'bad model' }));
  assert.equal((await harness.bootstrap()).model_connected, false);
  await harness.configureModel({ provider: 'ollama', model: 'small:4b', url: 'http://localhost:11434' });
  state = await harness.bootstrap(); assert.equal(state.model_connected, true); assert.equal(state.model, 'small:4b');
  await harness.configureModel({ provider: 'openai', model: 'gpt-test', apiKey: 'PRIVATE_KEY' });
  assert.equal((await harness.bootstrap()).model_connected, true);
  assert.doesNotMatch(JSON.stringify([await storage.all('settings'), await storage.all('sessions'), await harness.bootstrap()]), /PRIVATE_KEY/);
  // Forgetting the key, or reloading the page, leaves a cloud session that cannot be called: the card returns.
  harness.forgetApiKey(); state = await harness.bootstrap(); assert.equal(state.model_connected, false); assert.equal(state.ready, false);
  await harness.close();
  const reloaded = await open(storage); state = await reloaded.bootstrap();
  assert.equal(state.provider, 'openai'); assert.equal(state.model_connected, false);
  // A saved Ollama choice needs no credential, so it is still connected after a reload.
  await reloaded.configureModel({ provider: 'ollama', model: 'small:4b' }); await reloaded.close();
  const again = await open(storage); assert.equal((await again.bootstrap()).model_connected, true); await again.close();
  storage.close(); assert.deepEqual(await storage.all('settings'), []);
});

function bridgeFetch(counts: { releases: number; browse: unknown[] }, pair?: () => Promise<void>) {
  return async (url: string, init: RequestInit) => {
    if (String(url).startsWith('https://generativelanguage.googleapis.com/')) return Response.json({});
    if (String(url).endsWith('/pair')) { await pair?.(); return Response.json({ value: { token: 'fixture-token' } }); }
    const request = JSON.parse(String(init.body)) as { operation: string; args: { path?: string } };
    if (request.operation === 'browse') counts.browse.push(request.args.path);
    if (request.operation === 'snapshot') return Response.json({ value: { project: projectFromFiles('/bridge-workspace', {}), git: false, grants: { commands: true, writes: true, gitWrites: false } } });
    if (request.operation === 'release') counts.releases++;
    return Response.json({ value: {} });
  };
}

test('unpairing a bridge restores the browser capabilities and keeps the model credential and session, without any UI', async t => {
  const counts = { releases: 0, browse: [] as unknown[] };
  t.mock.method(globalThis, 'fetch', bridgeFetch(counts));
  for (const custom of [false, true]) {
    const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library, seed: { 'README.md': 'browser file' },
      ...(custom ? { runtime: { supportedTools: ['read_file', 'web_search'], webSearch: async () => 'custom search' } } : {}) });
    await harness.detachBridge();
    await harness.configureModel({ provider: 'gemini', apiKey: 'KEEP_MODEL_KEY' });
    const before = structuredClone(await harness.bootstrap());
    const attach = () => harness.attachBridge('http://127.0.0.1:5001', 'fixture');
    await attach();
    await assert.rejects(attach(), /replacement bridge/);
    await harness.browseProject('/bridge-workspace'); await harness.browseProject('/workspace', true); await harness.browseProject('/native/elsewhere');
    // Commands run only in a folder chosen through the bridge; web search goes through the bridge as well.
    const runtime = (harness as unknown as { runtime: RuntimePort }).runtime, signal = new AbortController().signal;
    assert.throws(() => runtime.executeCommand('true', '/workspace', signal), /Select a bridge folder/);
    assert.deepEqual(await runtime.webSearch!('query', signal), {});
    if (custom) await harness.setProject('/workspace');
    await harness.detachBridge();
    const after = await harness.bootstrap();
    assert.deepEqual(after.tools, before.tools); assert.deepEqual(after.capabilities, before.capabilities);
    assert.equal(after.project, '/workspace'); assert.equal(after.ready, true); assert.equal(after.model_connected, true);
    assert.equal(harness.activeSessionRecord().id, (before.session as { id: string }).id);
    assert.deepEqual(harness.bridgeStatus(), { connected: false });
    assert.equal((await harness.exportProject()).files['README.md'], 'browser file');
    if (custom) assert.deepEqual(await harness.runTool('web_search', { query: 'test' }, ['web_search']), { kind: 'text', text: 'custom search' });
    await attach(); await harness.detachBridge(); await harness.detachBridge();
    await harness.close();
  }
  assert.equal(counts.releases, 4);
  assert.deepEqual(counts.browse, ['', '', '/native/elsewhere', '', '', '/native/elsewhere']);
});

test('unpairing cancels a pending pairing, and a turn that starts during pairing rejects the attachment', async t => {
  const counts = { releases: 0, browse: [] as unknown[] };
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', bridgeFetch(counts, async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); }));
  const harness = await open();
  const cancelled = assert.rejects(harness.attachBridge('http://127.0.0.1:5001', 'fixture'), /cancelled by unpairing/);
  await entered; await harness.detachBridge(); finish(); await cancelled;
  assert.equal(counts.releases, 1); assert.equal((await harness.bootstrap()).project, '/workspace');
  assert.deepEqual(harness.bridgeStatus(), { connected: false });
  let stream: AsyncGenerator | undefined;
  t.mock.method(BridgeClient.prototype, 'pair', async () => { stream = harness.submit({ message: 'hello', useMemory: true, tools: [], askApproval: true, agent: '', prompt: '' }); await stream.next(); });
  await assert.rejects(harness.attachBridge('http://127.0.0.1:5001', 'fake'), /running/);
  await stream!.return(undefined); await harness.close();
});

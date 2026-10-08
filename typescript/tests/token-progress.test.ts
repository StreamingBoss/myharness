import { SessionStore } from '../src/node/sessions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OllamaAdapter } from '../src/ollama.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { NativeBridge, createBridgeServer } from '../src/node/bridge.js';
import { NodeHarness } from '../src/node/harness.js';
import { createHarnessServer } from '../src/node/http.js';
import { WorkerHost } from '../src/browser/worker-host.js';
import { ManagedSession } from '../src/browser/managed.js';
import { ManagedHost } from '../src/browser/managed-host.js';
import { WorkerClient, type WorkerPort } from '../src/browser/client.js';
import { browserFetch } from '../src/browser/fetch.js';
import { DiagnosticError } from '../src/failure.js';
import type { RpcMessage, RpcRequest } from '../src/browser/worker-host.js';
import type { ModelRequest } from '../src/core.js';
import type { TokenizationStage } from '../src/tokenization.js';
const payload: ModelRequest = { model: 'qwen3:8b', provider: 'ollama', messages: [{ role: 'user', content: 'hello' }], stream: true, options: { num_ctx: 4096 } };
const binding = { url: 'http://tokenizer.test', alias: payload.model, identity: 'matching fixture' };
function gate() { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { wait, open }; }
async function saved(harness: BrowserHarness | NodeHarness) {
  const record = harness.activeSessionRecord(); record.events.push({ type: 'request', provider: 'ollama', model_request: payload });
  const copy = await harness.importSession(record); await harness.activateSession(copy.id); return record.events.length - 1;
}

test('Ollama reports render/tokenize phases and actionable failures without response secrets', async () => {
  const stages: TokenizationStage[] = [];
  const adapter = new OllamaAdapter(async url => Response.json(url.endsWith('/api/chat') ? { _debug_info: { rendered_template: 'hello' } } : url.endsWith('/v1/models') ? { data: [{ id: payload.model }] } : { tokens: [{ id: 1, piece: 'hello' }] }), 'http://ollama.test', { [payload.model]: binding });
  await adapter.inspectTokens(payload, undefined, stage => stages.push(stage)); assert.deepEqual(stages, ['rendering', 'tokenizing']);
  for (const fail of [new Error('SECRET invalid JSON'), 'SECRET', new Error('Ollama request failed with HTTP 503')]) {
    const broken = new OllamaAdapter(async () => { throw fail; }, 'http://ollama.test');
    const result = await broken.inspectTokens(payload); assert.match(result.explanation, /prompt rendering failed/); assert.ok(!result.explanation.includes('SECRET'));
    if (fail instanceof Error && fail.message.includes('503')) assert.match(result.explanation, /503/);
  }
  for (const fail of [new Error('SECRET invalid JSON'), 'SECRET', new Error('Tokenizer model lookup failed (HTTP 503)'), new Error('Configured tokenizer model alias does not match the running tokenizer service')]) {
    const broken = new OllamaAdapter(async url => { if (url.endsWith('/api/chat')) return Response.json({ _debug_info: { rendered_template: 'hello' } }); throw fail; }, 'http://ollama.test', { [payload.model]: binding });
    const result = await broken.inspectTokens(payload); assert.match(result.explanation, /llama.cpp tokenization failed/); assert.ok(!result.explanation.includes('SECRET')); assert.equal(result.renderedPrompt, 'hello');
  }
});

test('Node inspection progress is callable during a turn, cloned, and exposed over HTTP', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'token-progress-node-')); t.after(() => rm(root, { recursive: true, force: true }));
  const entered = gate(), finish = gate();
  const harness = new NodeHarness({ workspace: root, sessions: new SessionStore(path.join(root, 'sessions')), model: payload.model, contextLength: 4096, ollama: { async *streamChat() {}, async inspectTokens(_request, _signal, progress) { progress!('rendering'); entered.open(); await finish.wait; throw new DiagnosticError({ source: 'model', component: 'Ollama renderer', reason: 'HTTP 503', recovery: 'Restart Ollama when ready.' }); } } });
  await harness.initialize(); t.after(() => harness.close());
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal(await (await fetch(base + '/tokenize/progress')).json(), null);
  const index = await saved(harness), pending = harness.tokenize(index); await entered.wait;
  const status = await (await fetch(base + '/tokenize/progress')).json(); assert.equal(status.stage, 'rendering'); assert.equal(status.eventIndex, index);
  status.message = 'modified'; assert.match((await harness.tokenizationProgress())!.message, /Rendering/);
  finish.open(); assert.match((await pending).explanation, /Ollama renderer: HTTP 503/); assert.equal(await harness.tokenizationProgress(), null);
});

test('browser progress forwards real bridge stages and tolerates missing, unknown or unavailable status', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'token-progress-bridge-')); t.after(() => rm(root, { recursive: true, force: true }));
  const render = gate(), renderReady = gate(), tokenize = gate(), tokenizeReady = gate();
  const service = new NativeBridge({ workspace: root, origin: 'https://guide.test', grants: { writes: false, commands: false, gitWrites: false }, tokenizers: { [payload.model]: binding }, inspectionFetch: async url => {
    if (url.endsWith('/api/chat')) { renderReady.open(); await render.wait; return Response.json({ _debug_info: { rendered_template: 'hello' } }); }
    if (url.endsWith('/v1/models')) { tokenizeReady.open(); await tokenize.wait; return Response.json({ data: [{ id: payload.model }] }); }
    return Response.json({ tokens: [{ id: 42, piece: 'hello' }] });
  } });
  const server = createBridgeServer(service); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const rawFetch = globalThis.fetch, base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let override: string | null | undefined, fail = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    if (request.operation === 'inspectionProgress') { if (fail) throw new Error('offline'); if (override !== undefined) return Response.json({ value: { stage: override } }); }
    return rawFetch(url, { ...init, headers: { ...init.headers, origin: service.origin } });
  });
  const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library: { agents: {}, skills: {}, prompts: {} }, seed: {}, model: payload.model }); t.after(() => harness.close());
  await harness.attachBridge(base, service.code); assert.equal(await harness.tokenizationProgress(), null);
  const index = await saved(harness), pending = harness.tokenize(index); await renderReady.wait;
  assert.equal((await harness.tokenizationProgress())!.stage, 'rendering');
  for (const stage of [null, 'unknown']) { override = stage; assert.equal((await harness.tokenizationProgress())!.stage, 'inspecting'); }
  fail = true; assert.equal((await harness.tokenizationProgress())!.stage, 'inspecting'); fail = false; override = undefined;
  render.open(); await tokenizeReady.wait; assert.equal((await harness.tokenizationProgress())!.stage, 'tokenizing');
  tokenize.open(); assert.equal((await pending).count, 1); assert.equal(await harness.tokenizationProgress(), null);
  await harness.detachBridge();
});

test('Worker and managed transports expose progress immediately while inspection is pending', async t => {
  for (const managed of [false, true]) {
    const entered = gate(), finish = gate();
    const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library: { agents: {}, skills: {}, prompts: {} }, seed: {}, model: payload.model, modelPort: { async *streamChat() {}, async inspectTokens(_request, _signal, progress) { progress!('loading'); entered.open(); await finish.wait; throw new Error('failed'); } } });
    const session = new ManagedSession(harness, true); t.after(() => session.end());
    const messages: RpcMessage[] = [];
    let receive!: (event: { data?: RpcMessage }) => void;
    const send = (message: RpcMessage) => { messages.push(message); receive({ data: message }); };
    const host = managed ? new ManagedHost(session, send) : new WorkerHost(async () => harness, send);
    const port: WorkerPort = { postMessage(request: RpcRequest) { void host.handle(request); }, addEventListener(type, callback) { if (type === 'message') receive = callback; }, removeEventListener() {}, terminate() {} };
    const client = new WorkerClient(port), fetch_ = browserFetch(client);
    const index = await saved(harness), pending = client.call('tokenize', { event_index: index }); await entered.wait;
    const status = await (await fetch_('/tokenize/progress')).json(); assert.equal(status.stage, 'loading');
    finish.open(); await pending; assert.equal(await client.call('tokenizationProgress'), null); client.close();
  }
});

test('idle bridge progress is empty and requires the paired connection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'token-progress-idle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bridge = new NativeBridge({ workspace: root, origin: 'https://guide.test', grants: { writes: false, commands: false, gitWrites: false } });
  const { token } = bridge.pair(bridge.code);
  assert.deepEqual(await bridge.call(token, { id: 'idle', operation: 'inspectionProgress', args: {} }), { stage: null });
  await assert.rejects(bridge.call('other-token', { id: 'foreign', operation: 'inspectionProgress', args: {} })); bridge.close();
});

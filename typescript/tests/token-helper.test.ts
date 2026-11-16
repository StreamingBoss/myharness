import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { TokenHelper, createTokenHelperServer } from '../src/node/token-helper.js';
import { tokenHelperMain } from '../src/node/token-helper-cli.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { WorkerHost, type RpcMessage } from '../src/browser/worker-host.js';
import { HELPER_DEFAULT_ENDPOINT, HELPER_DEFAULT_ORIGIN, HelperError, object, text } from '../src/helper-protocol.js';
import type { ModelRequest } from '../src/core.js';
import type { FetchLike } from '../src/ollama.js';

const payload: ModelRequest = { model: 'qwen3:8b', provider: 'ollama', messages: [{ role: 'user', content: 'hello' }], stream: true, options: { num_ctx: 4096 } };
const binding = { url: 'http://tokenizer.test', alias: 'qwen3:8b', identity: 'matching GGUF sha256 verified' };
const origin = 'https://harness.test';
const library = { agents: {}, skills: {}, prompts: {} };

test('the helper tokenizes saved Ollama requests only: it validates model and endpoint, preserves bytes and cancels', async () => {
  const calls: string[] = []; let block = false;
  const inspectionFetch: FetchLike = async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'error');
    if (block) { await new Promise<void>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }
    if (url.endsWith('/api/chat')) { const request = JSON.parse(init.body!); assert.equal(request._debug_render_only, true); return Response.json({ _debug_info: { rendered_template: 'hello ü' } }); }
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: binding.alias }] });
    assert.equal(url, 'http://tokenizer.test/tokenize'); assert.equal(JSON.parse(init.body!).add_special, false);
    return Response.json({ tokens: [{ id: 4, piece: [195] }, { id: 5, piece: [188] }] });
  };
  const service = new TokenHelper({ origins: [origin], tokenizers: { [payload.model]: binding }, inspectionFetch });
  const { token, ...info } = service.connect(); let id = 0;
  assert.deepEqual(info, { models: [payload.model], ollamaUrl: 'http://localhost:11434', automatic: false }); assert.deepEqual(service.info, info);
  const call = (args: Record<string, unknown>) => service.call(token, { id: String(++id), operation: 'inspectTokens', args });
  const result = await call({ payload, ollamaUrl: 'http://localhost:11434' }) as { fidelity: string; groups: unknown; source: string };
  assert.equal(result.fidelity, 'configured-tokenizer'); assert.match(result.source, /matching GGUF/);
  assert.deepEqual(result.groups, [{ label: 'Ollama-rendered prompt', tokens: [{ id: '4', bytes: [195] }, { id: '5', bytes: [188] }] }]);
  for (const args of [{ payload: {} }, { payload: { ...payload, provider: 'openai' } }, { payload: { ...payload, provider: undefined, model: 'toString' }, ollamaUrl: 'http://localhost:11434' }, { payload, ollamaUrl: 'http://other' }, { payload }]) await assert.rejects(call(args));
  assert.equal(calls.length, 3);
  // Nothing but tokenization: the operations the old bridge offered are refused, and requests are validated.
  for (const operation of ['read', 'write', 'command', 'webSearch', 'git_status', 'browse', 'snapshot']) await assert.rejects(service.call(token, { id: operation, operation, args: {} }), /Unknown tokenizer helper operation/);
  await assert.rejects(service.call(token, { id: '', operation: 'inspectTokens', args: {} }), /unique request ID/);
  await assert.rejects(service.call(token, { id: 'x', operation: 5 as unknown as string, args: {} }), /unique request ID/);
  await assert.rejects(service.call(token, { id: 'x', operation: 'cancel', args: [] as unknown as Record<string, unknown> }), /Expected an object/);
  await assert.rejects(service.call(token, { id: 'x', operation: 'cancel', args: {} }), /id must be a string/);
  block = true; const pending = call({ payload: { ...payload, provider: undefined }, ollamaUrl: 'http://localhost:11434' });
  const running = String(id);
  await assert.rejects(service.call(token, { id: running, operation: 'inspectTokens', args: {} }), /unique request ID/);
  // A second inspection waits for the first; cancelling it while queued means it never starts.
  const queued = call({ payload, ollamaUrl: 'http://localhost:11434' });
  await service.call(token, { id: 'cancel-queued', operation: 'cancel', args: { id: String(id) } });
  await service.call(token, { id: 'cancel', operation: 'cancel', args: { id: running } });
  // The running inspection is aborted at its Ollama request and reports that; the queued one is refused outright.
  assert.match((await pending as { explanation: string }).explanation, /prompt rendering failed/); await assert.rejects(queued, /cancelled/);
  // Releasing a session aborts its work; an unknown session is refused.
  const other = service.connect(), blocked = service.call(other.token, { id: 'r', operation: 'inspectTokens', args: { payload, ollamaUrl: 'http://localhost:11434' } });
  assert.deepEqual(await service.call(other.token, { id: 'release', operation: 'release', args: {} }), { ok: true });
  await assert.rejects(blocked, /cancelled/); await assert.rejects(service.call(other.token, { id: 'again', operation: 'inspectionProgress', args: {} }), /connect again/);
  service.release('unknown'); service.close();
  for (const ollamaUrl of ['ftp://x', 'http://u:p@x', 'http://x/?q=x', 'http://x/#x']) assert.throws(() => new TokenHelper({ origins: [origin], ollamaUrl }), /Ollama URL/);
  for (const origins of [[], ['https://harness.test/'], ['https://harness.test/path'], ['ftp://harness.test']]) assert.throws(() => new TokenHelper({ origins }), /website origin/);
  assert.throws(() => new TokenHelper({ origins: [origin], tokenizers: { model: { ...binding, alias: '' } } }));
  assert.throws(() => text({}, 'x'), HelperError); assert.throws(() => object(null), HelperError); assert.equal(text({ x: 'y' }, 'x'), 'y');
});

test('without a tokenizer for the exact model the helper says so; the oldest page session gives way to new ones', async () => {
  const service = new TokenHelper({ origins: [origin], maxConnections: 2 });
  const first = service.connect(), second = service.connect();
  await assert.rejects(service.call(first.token, { id: 'i', operation: 'inspectTokens', args: { payload, ollamaUrl: 'http://localhost:11434' } }), /No tokenizer configured/);
  const third = service.connect();
  await assert.rejects(service.call(first.token, { id: 'p', operation: 'inspectionProgress', args: {} }), /connect again/);
  for (const session of [second, third]) assert.deepEqual(await service.call(session.token, { id: 'p', operation: 'inspectionProgress', args: {} }), { stage: null });
  service.close();
});

function post(base: string, route: string, headers: Record<string, string>, body: string, method = 'POST'): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(base + route, { method, headers }, response => { let data = ''; response.on('data', chunk => { data += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: data })); });
    request.on('error', reject); request.end(body);
  });
}

test('the loopback transport serves only allowed websites on its own host, with no pairing code', async t => {
  const service = new TokenHelper({ origins: [origin, 'http://localhost:5001'] });
  const server = createTokenHelperServer(service); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  const json = { 'content-type': 'application/json' };
  // Another website, a missing Origin and a rebinding Host are all refused before anything else happens.
  for (const headers of [{ ...json, origin: 'https://evil.test' }, json, { ...json, origin, host: 'evil.test' }]) {
    const refused = await post(base, '/v1/connect', headers, '{}');
    assert.equal(refused.status, 403); assert.match(refused.body, /not allowed/); assert.equal(refused.headers['access-control-allow-origin'], undefined);
  }
  const preflight = await post(base, '/v1/connect', { origin }, '', 'OPTIONS');
  assert.equal(preflight.status, 204); assert.equal(preflight.headers['access-control-allow-origin'], origin); assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
  for (const allowed of [origin, 'http://localhost:5001']) {
    const connected = await post(base, '/v1/connect', { ...json, origin: allowed }, '{}');
    assert.equal(connected.status, 200); assert.equal(connected.headers['access-control-allow-origin'], allowed); assert.equal(connected.headers['cache-control'], 'no-store');
    const { token, ...info } = JSON.parse(connected.body).value;
    assert.match(token, /^[0-9a-f]{64}$/); assert.deepEqual(info, { ollamaUrl: 'http://localhost:11434', models: [], automatic: false });
    const progress = await post(base, '/v1/call', { ...json, origin: allowed, authorization: 'Bearer ' + token }, JSON.stringify({ id: '1', operation: 'inspectionProgress', args: {} }));
    assert.deepEqual(JSON.parse(progress.body), { value: { stage: null } });
  }
  assert.equal((await post(base, '/v1/call', { ...json, origin }, JSON.stringify({ id: '1', operation: 'inspectionProgress', args: {} }))).status, 401);
  assert.equal((await post(base, '/v1/call', { ...json, origin, authorization: 'Basic x' }, JSON.stringify({ id: '1', operation: 'inspectionProgress', args: {} }))).status, 401);
  assert.equal((await post(base, '/v1/pair', { ...json, origin }, '{}')).status, 404);
  assert.equal((await post(base, '/v1/connect', { origin }, '', 'GET')).status, 404);
  const malformed = await post(base, '/v1/connect', { ...json, origin }, '{');
  assert.equal(malformed.status, 400); assert.match(malformed.body, /operation failed/);
  assert.equal((await post(base, '/v1/connect', { ...json, origin }, JSON.stringify({ pad: 'x'.repeat(12 * 1024 * 1024) }))).status, 413);
});

test('the browser backend reaches token pieces through a real helper, remembers it and reconnects without being asked', async t => {
  const rawFetch = globalThis.fetch; let fail = false, render = true; const upstream: string[] = [];
  const service = new TokenHelper({ origins: [origin], tokenizers: { [payload.model]: binding } });
  let host = createTokenHelperServer(service); await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(() => { host.closeAllConnections(); host.close(); });
  const port = (host.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith(HELPER_DEFAULT_ENDPOINT)) throw new Error('nothing listens on the default port in this test');
    if (url.startsWith('http://127.0.0.1:')) return rawFetch(url, { ...init, headers: { ...init.headers, origin } });
    upstream.push(url); if (fail) throw new Error('private details');
    if (url.endsWith('/api/chat')) return Response.json(render ? { _debug_info: { rendered_template: 'hello' } } : {});
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: binding.alias }] });
    return Response.json({ tokens: [{ id: 9, piece: 'hello' }] });
  });
  const storage = new MemoryStorage();
  const harness = await BrowserHarness.open({ storage, library, seed: {}, model: payload.model });
  async function inspect(backend: BrowserHarness, request: ModelRequest = payload) {
    const record = backend.activeSessionRecord(); record.events.push({ type: 'request', provider: 'ollama', model_request: request });
    const copy = await backend.importSession(record); await backend.activateSession(copy.id); return backend.tokenize(record.events.length - 1);
  }
  // Not enabled: no helper request is made, and the default address is only a suggestion.
  assert.deepEqual(harness.tokenizerStatus(), { enabled: false, connected: false, endpoint: HELPER_DEFAULT_ENDPOINT });
  assert.deepEqual((await harness.bootstrap()).tokenizer, harness.tokenizerStatus());
  assert.match((await inspect(harness)).explanation, /rendered prompt/);
  await assert.rejects(harness.connectTokenizer('http://example.test:5002'), /on this computer/);
  await assert.rejects(harness.connectTokenizer('http://127.0.0.1:1'), /unavailable/);
  // With no address given and none remembered, the fixed default address is tried.
  await assert.rejects(harness.connectTokenizer(), /unavailable/);
  assert.equal(harness.tokenizerStatus().enabled, false); assert.equal(await storage.get('settings', 'tokenizer-helper'), undefined);
  upstream.length = 0;
  assert.deepEqual(await harness.connectTokenizer(base), { enabled: true, connected: true, endpoint: base, ollamaUrl: 'http://localhost:11434', models: [payload.model], automatic: false });
  assert.deepEqual(await storage.get('settings', 'tokenizer-helper'), { endpoint: base });
  assert.match((await inspect(harness, { ...payload, model: 'other' })).explanation, /exact Ollama model/); assert.equal(upstream.length, 0);
  await storage.put('settings', 'ollama-url', 'http://other'); assert.match((await inspect(harness)).explanation, /different Ollama URLs/); assert.equal(upstream.length, 0);
  await storage.put('settings', 'ollama-url', undefined);
  const result = await inspect(harness); assert.equal(result.fidelity, 'configured-tokenizer'); assert.equal(result.count, 1);
  assert.deepEqual(upstream, ['http://localhost:11434/api/chat', 'http://tokenizer.test/v1/models', 'http://tokenizer.test/tokenize']);
  fail = true; assert.match((await inspect(harness)).explanation, /failed/); fail = false; render = false;
  assert.match((await inspect(harness)).explanation, /rendered prompt/); render = true;
  // Reconnecting replaces the previous session; other providers never use the helper.
  assert.equal((await harness.connectTokenizer()).connected, true);
  assert.equal((await inspect(harness, { ...payload, provider: 'openai' })).fidelity, 'unavailable');
  // Locking credentials does not concern the helper: it holds none.
  await harness.lockCredentials(); assert.equal(harness.tokenizerStatus().connected, true);
  await harness.close();

  // A later visit: the choice is remembered, nothing is contacted at startup, and the first inspection reconnects by itself.
  let helperRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith('http://127.0.0.1:')) { helperRequests++; return rawFetch(url, { ...init, headers: { ...init.headers, origin } }); }
    if (url.endsWith('/api/chat')) return Response.json({ _debug_info: { rendered_template: 'hello' } });
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: binding.alias }] });
    return Response.json({ tokens: [{ id: 9, piece: 'hello' }] });
  });
  const later = await BrowserHarness.open({ storage, library, seed: {}, model: payload.model }); t.after(() => later.close());
  assert.deepEqual(later.tokenizerStatus(), { enabled: true, connected: false, endpoint: base }); assert.equal(helperRequests, 0);
  assert.equal((await inspect(later)).fidelity, 'configured-tokenizer'); assert.equal(later.tokenizerStatus().connected, true);
  // The helper stops: inspection continues without pieces and the choice is kept. When it runs again, pieces return unasked.
  host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve()));
  assert.match((await inspect(later)).explanation, /unavailable/); assert.deepEqual(later.tokenizerStatus(), { enabled: true, connected: false, endpoint: base });
  assert.match((await inspect(later)).explanation, /rendered prompt/);
  const revived = new TokenHelper({ origins: [origin], tokenizers: { [payload.model]: binding } });
  host = createTokenHelperServer(revived); await new Promise<void>(resolve => host.listen(port, '127.0.0.1', resolve));
  assert.equal((await inspect(later)).fidelity, 'configured-tokenizer');
  // A helper with no tokenizer for any model changes nothing.
  host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve()));
  host = createTokenHelperServer(new TokenHelper({ origins: [origin] })); await new Promise<void>(resolve => host.listen(port, '127.0.0.1', resolve));
  assert.match((await inspect(later)).explanation, /unavailable|denied/); assert.match((await inspect(later)).explanation, /rendered prompt/);
  // Forgetting disconnects and stops reconnecting; the Worker transport exposes the same actions.
  assert.deepEqual(await later.forgetTokenizer(), { enabled: false, connected: false, endpoint: HELPER_DEFAULT_ENDPOINT });
  assert.equal(await storage.get('settings', 'tokenizer-helper'), undefined); await later.forgetTokenizer();
  const messages: RpcMessage[] = [], worker = new WorkerHost(async () => later, message => messages.push(message));
  await worker.handle({ id: 'a', action: 'connectTokenizer', payload: { endpoint: base } });
  await worker.handle({ id: 'b', action: 'tokenizerStatus', payload: {} });
  await worker.handle({ id: 'c', action: 'connectTokenizer', payload: {} });
  await worker.handle({ id: 'd', action: 'forgetTokenizer', payload: {} });
  assert.deepEqual(messages.map(message => (message as { value: { enabled: boolean; connected: boolean } }).value).map(value => [value.enabled, value.connected]), [[true, true], [true, true], [true, true], [false, false]]);
});

test('the helper CLI needs no arguments, accepts extra websites and prints no tokenizer endpoints', async () => {
  const output: string[] = [];
  assert.equal(await tokenHelperMain(['--help'], line => output.push(line), {}), undefined);
  assert.match(output.join('\n'), /tokenizes text and does nothing else/);
  await assert.rejects(tokenHelperMain(['--port', '70000'], () => undefined, {}), /valid port/);
  await assert.rejects(tokenHelperMain(['--port', '0'], () => undefined, { MYHARNESS_TOKENIZERS: '{' }));
  await assert.rejects(tokenHelperMain(['--port', '0', '--origin', 'harnessarium.com'], () => undefined, {}));
  output.length = 0;
  const server = await tokenHelperMain(['--port', '0'], line => output.push(line), { MYHARNESS_TOKENIZERS: JSON.stringify({ [payload.model]: binding }), OLLAMA_URL: 'http://ollama.test' });
  assert.match(output[0]!, /^Tokenizer helper on http:\/\/127\.0\.0\.1:\d+$/); assert.equal(output[1], `Allowed websites: ${HELPER_DEFAULT_ORIGIN}`);
  assert.ok(!output.join('').includes(binding.url)); assert.doesNotMatch(output.join(''), /code/i);
  process.emit('SIGTERM'); await new Promise<void>(resolve => server!.once('close', () => resolve()));
  output.length = 0;
  const custom = await tokenHelperMain(['--port', '0', '--origin', 'http://localhost:5001', '--origin', origin], line => output.push(line));
  assert.equal(output[1], `Allowed websites: http://localhost:5001, ${origin}`);
  await new Promise<void>(resolve => custom!.close(() => resolve()));
  // As a program: help succeeds, a bad website address and a busy port fail with a plain explanation.
  const cli = 'dist/typescript/src/node/token-helper-cli.js';
  assert.equal(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).status, 0);
  const failed = spawnSync(process.execPath, [cli, '--origin', 'not-a-website'], { encoding: 'utf8' });
  assert.equal(failed.status, 1); assert.match(failed.stderr, /exact website address/);
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const busy = spawnSync(process.execPath, [cli, '--port', String((occupied.address() as { port: number }).port)], { encoding: 'utf8' });
  assert.equal(busy.status, 1); assert.match(busy.stderr, /already in use/); assert.match(busy.stderr, /may already be running/);
  await new Promise<void>(resolve => occupied.close(() => resolve()));
});

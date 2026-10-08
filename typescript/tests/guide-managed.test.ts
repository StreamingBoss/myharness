import { DiagnosticError } from '../src/failure.js';
import { BackendError } from '../src/harness.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedSession } from '../src/browser/managed.js';
import { ManagedHost } from '../src/browser/managed-host.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { CredentialVault } from '../src/browser/vault.js';
import { startManagedWorker } from '../src/browser/managed-entry.js';
import { loadBrowserHarness } from '../src/browser/startup.js';
import { IDBFactory } from 'fake-indexeddb';
import type { RpcMessage, RpcRequest } from '../src/browser/worker-host.js';
import { NativeBridge, createBridgeServer } from '../src/node/bridge.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectFromFiles } from '../src/browser/workspace.js';

const library = { agents: {}, skills: {}, prompts: {} };
const password = 'private passphrase long';
async function backend() { return BrowserHarness.open({ storage: new MemoryStorage(), library, seed: { 'README.md': 'hello' }, model: 'scripted-demo' }); }

test('unpair restores original capabilities, preserves model credentials and session, and supports pairing again without UI', async t => {
  let releases = 0;
  const browsePaths: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith('https://generativelanguage.googleapis.com/')) return Response.json({});
    if (url.endsWith('/pair')) return Response.json({ value: { token: 'fixture-token' } });
    const request = JSON.parse(String(init.body)) as { operation: string; args: { path?: string } };
    if (request.operation === 'browse') browsePaths.push(request.args.path);
    if (request.operation === 'snapshot') return Response.json({ value: { project: projectFromFiles('/bridge-workspace', {}), git: false, grants: { commands: true, writes: true, gitWrites: false } } });
    if (request.operation === 'release') releases++;
    return Response.json({ value: {} });
  });
  for (const custom of [false, true]) {
    const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library, seed: { 'README.md': 'browser file' }, model: 'scripted-demo',
      ...(custom ? { runtime: { supportedTools: ['read_file', 'web_search'], webSearch: async () => 'custom search' } } : {}) });
    const session = new ManagedSession(harness, true);
    await session.call('detachBridge');
    await session.call('connectModel', { config: { provider: 'gemini', apiKey: 'KEEP_MODEL_KEY' } });
    const before = structuredClone(await harness.bootstrap());
    const attach = () => session.call('attachBridge', { endpoint: 'http://127.0.0.1:5001', code: 'fixture' });
    await attach();
    await harness.browseProject('/bridge-workspace');
    if (custom) await harness.setProject('/workspace');
    await session.call('detachBridge');
    const after = await harness.bootstrap();
    assert.deepEqual(after.tools, before.tools); assert.deepEqual(after.capabilities, before.capabilities);
    assert.equal(after.project, '/workspace'); assert.equal(after.ready, true);
    assert.equal(harness.activeSessionRecord().id, (before.session as { id: string }).id);
    assert.deepEqual(harness.bridgeStatus(), { connected: false });
    assert.equal((await harness.exportProject()).files['README.md'], 'browser file');
    if (custom) assert.deepEqual(await harness.runTool('web_search', { query: 'test' }, ['web_search']), { kind: 'text', text: 'custom search' });
    await harness.configureModel({ provider: 'gemini' });
    await attach(); await session.call('detachBridge'); await session.call('detachBridge');
    await session.end();
  }
  assert.equal(releases, 4);
  assert.deepEqual(browsePaths, ['', '']);
});

test('unpair cancels a pending pairing and rejects changes during an active turn', async t => {
  const harness = await backend(), session = new ManagedSession(harness, true);
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; }); let releases = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/pair')) { started(); await new Promise<void>(resolve => { finish = resolve; }); return Response.json({ value: { token: 'cancelled-token' } }); }
    const request = JSON.parse(String(init.body)) as { operation: string };
    if (request.operation === 'snapshot') return Response.json({ value: { project: projectFromFiles('/bridge-workspace', {}), git: false, grants: { commands: true, writes: true, gitWrites: false } } });
    if (request.operation === 'release') releases++;
    return Response.json({ value: {} });
  });
  const pairing = session.call('attachBridge', { endpoint: 'http://127.0.0.1:5001', code: 'fixture' });
  const cancelled = assert.rejects(pairing, /cancelled by unpairing/);
  await entered; await session.call('detachBridge'); finish(); await cancelled;
  assert.equal(releases, 1); assert.equal((await harness.bootstrap()).project, '/workspace');
  assert.deepEqual(harness.bridgeStatus(), { connected: false });
  for await (const event of harness.submit({ message: 'Write denied.txt: no', useMemory: true, tools: ['write_file'], askApproval: true, agent: '', prompt: '' })) {
    if (event.type === 'approval') { await assert.rejects(session.call('detachBridge'), /running turn/); harness.approve(String(event.id), false); }
  }
  assert.equal((await harness.exportProject()).files['denied.txt'], undefined); await session.end();
});

test('managed vault connection, explicit saving, restoration, MCP binding and inactivity are backend-owned', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  let now = 0; const harness = await backend(), storage = new MemoryStorage();
  const session = new ManagedSession(harness, false, () => now, async () => storage);
  assert.deepEqual(await session.call('managedStatus'), { temporary: false, vault: { id: '', locked: true } });
  assert.deepEqual(await session.call('vaultList'), []);
  const { id } = await session.call('vaultCreate', { label: 'test', passphrase: password, confirmation: password }) as { id: string };
  assert.deepEqual(await session.call('vaultList'), [{ id, label: 'test' }]);
  await session.call('connectModel', { config: { provider: 'gemini', apiKey: 'PRIVATE' }, remember: true });
  assert.equal((await harness.bootstrap()).ready, true); assert.equal(JSON.stringify(harness.activeSessionRecord()).includes('PRIVATE'), false);
  const mcp = { mcpServers: { github: { url: 'https://github.test/mcp', disabled: true, headers: { Authorization: 'MCP_PRIVATE' } }, other: { url: 'https://other.test/mcp', disabled: true } } };
  await session.call('saveMcp', { config: mcp }); await session.call('lock'); assert.equal((await harness.bootstrap()).ready, false);
  await session.call('vaultUnlock', { id, passphrase: password });
  await session.call('connectModel', { config: { provider: 'gemini' }, restore: true }); assert.equal((await harness.bootstrap()).ready, true);
  await assert.rejects(session.call('connectModel', { config: { provider: 'openai', model: 'test' }, restore: true }), /No saved/);
  await session.call('restoreMcp', { config: { mcpServers: { github: { url: 'https://github.test/mcp', disabled: true }, other: { url: 'https://unmatched.test/mcp', disabled: true } } } });
  assert.match(JSON.stringify(await harness.mcpConfiguration()), /MCP_PRIVATE/);
  await session.call('vaultForget', { binding: { kind: 'model', id: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/' } });
  await assert.rejects(session.call('connectModel', { config: { provider: 'gemini' }, restore: true }), /No saved/);
  await assert.rejects(session.call('connectModel', { config: { mode: 'demo', model: 'scripted-demo' }, remember: true }), /Only cloud/);
  await session.call('connectModel', { config: { mode: 'demo', model: 'scripted-demo' } });
  await session.call('bridgeHeartbeat'); now = 599999; await session.tick(); await session.call('activity'); now += 599999; await session.tick();
  assert.equal((await session.call('managedStatus') as { vault: { locked: boolean } }).vault.locked, false);
  now += 1; await session.tick(); assert.equal((await session.call('managedStatus') as { vault: { locked: boolean } }).vault.locked, false);
  await session.lock(); assert.equal((await session.call('managedStatus') as { vault: { locked: boolean } }).vault.locked, true);
  await session.call('vaultDelete', { id }); assert.deepEqual(await session.call('vaultList'), []);
  await assert.rejects(session.call('unknown')); await session.end(); await assert.rejects(session.call('managedStatus'), /ended/);
});

test('shared computer backend never opens a vault and locks pending approvals before effects run', async () => {
  const harness = await backend(); let opened = false;
  const session = new ManagedSession(harness, true, Date.now, async () => { opened = true; return new MemoryStorage(); });
  await assert.rejects(session.call('vaultList'), /disabled/); assert.equal(opened, false);
  const stream = harness.submit({ message: 'Write no.txt: no', useMemory: true, tools: ['write_file'], askApproval: true, agent: '', prompt: '' });
  for await (const event of stream) if (event.type === 'approval') await session.lock();
  assert.equal((await harness.exportProject()).files['no.txt'], undefined);
  await session.end();
});

test('locking during model connection cannot restore a credential afterward', async t => {
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); return Response.json({}); });
  const harness = await backend(), session = new ManagedSession(harness, false, Date.now, async () => new MemoryStorage());
  const connection = session.call('connectModel', { config: { provider: 'gemini', apiKey: 'NO_RESTORE' } });
  const rejection = assert.rejects(connection); await entered; await session.lock(); finish(); await rejection;
  await assert.rejects(harness.configureModel({ provider: 'gemini' })); await session.end();
});

test('managed host routes public actions and sanitized administrative results independently of pages', async () => {
  const harness = await backend(), session = new ManagedSession(harness, true), messages: RpcMessage[] = [];
  const host = new ManagedHost(session, message => messages.push(message));
  await host.handle({ id: '1', action: 'managedStatus', payload: {} }); await host.handle({ id: '2', action: 'bootstrap', payload: {} });
  await host.handle({ id: '3', action: 'vaultCreate', payload: { passphrase: 'PRIVATE' } });
  assert.equal(messages[0]!.type, 'result'); assert.equal(messages[1]!.type, 'result'); assert.equal(messages[2]!.type, 'error'); assert.equal(JSON.stringify(messages).includes('PRIVATE'), false); await session.end();
});

test('managed native bridge is the current workspace; backend heartbeat and lock settle the lease', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'guide-attach-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'AGENTS.md'), 'LOCAL_RULES'); await mkdir(path.join(root, '.git'));
  const bridge = new NativeBridge({ workspace: root, origin: 'https://guide.test', grants: { commands: true, writes: true, gitWrites: false } });
  const server = createBridgeServer(bridge); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { bridge.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, realFetch = fetch;
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => url.startsWith('https://html.duckduckgo.com/') ? Promise.resolve(new Response('No results')) : realFetch(url, { ...init, headers: { ...init.headers, origin: bridge.origin } }));
  const harness = await backend(); let now = 0; const session = new ManagedSession(harness, true, () => now);
  await session.call('attachBridge', { endpoint: base, code: bridge.code });
  const state = await harness.bootstrap(); assert.equal(state.project, '/bridge-workspace'); assert.ok((state.tools as { name: string }[]).some(tool => tool.name === 'run_command'));
  assert.match(JSON.stringify(await harness.explore({ useMemory: true, tools: [], agent: '', prompt: '' })), /LOCAL_RULES/);
  await assert.rejects(session.call('attachBridge', { endpoint: base, code: bridge.code }), /replacement/);
  now = 5000; await session.tick(); await session.call('bridgeHeartbeat');
  let commandOutput = '';
  for await (const event of harness.submit({ message: 'Run printf NATIVE_RUNTIME', useMemory: true, tools: ['run_command'], askApproval: true, agent: '', prompt: '' })) { if (event.type === 'approval') harness.approve(String(event.id), true); if (event.type === 'command') commandOutput = String(event.output); }
  assert.match(commandOutput, /NATIVE_RUNTIME/);
  const { DemoModel } = await import('../src/browser/demo.js');
  const original = DemoModel.prototype.streamChat;
  t.mock.method(DemoModel.prototype, 'streamChat', async function* (input: import('../src/core.js').ModelRequest) { yield JSON.stringify({ message: input.messages.at(-1)!.role === 'tool' ? { content: 'Finished search' } : { tool_calls: [{ function: { name: 'web_search', arguments: { query: 'fixture' } } }] }, done: true }); });
  await harness.newSession(); let webResult = '';
  for await (const event of harness.submit({ message: 'Search the web', useMemory: true, tools: ['web_search'], askApproval: true, agent: '', prompt: '' })) if (event.type === 'tool') webResult = JSON.stringify(event);
  assert.match(webResult, /No web results/); DemoModel.prototype.streamChat = original;
  await harness.setProject('/workspace');
  const active = harness.submit({ message: 'hello', useMemory: false, tools: [], askApproval: true, agent: '', prompt: '' }); await active.next();
  const outside = async () => { for await (const event of harness.executeCommand('printf NO')) if (event.type === 'approval') harness.approve(String(event.id), true); }; await assert.rejects(outside(), /bridge folder/); await active.return(undefined);
  await harness.setProject('/bridge-workspace');
  await session.lock(); assert.deepEqual(harness.bridgeStatus(), { connected: false }); await assert.rejects(harness.exportProject(), /disconnected/); now += 5000; await session.tick();
  await rm(path.join(root, '.git'), { recursive: true, force: true });
  const replacement = new NativeBridge({ workspace: root, origin: bridge.origin, grants: { commands: false, writes: false, gitWrites: false } }), second = createBridgeServer(replacement);
  await new Promise<void>(resolve => second.listen(0, '127.0.0.1', resolve)); t.after(() => { second.closeAllConnections(); second.close(); });
  await session.call('attachBridge', { endpoint: `http://127.0.0.1:${(second.address() as { port: number }).port}`, code: replacement.code });
  assert.equal(((await harness.bootstrap()).tools as { name: string }[]).some(tool => tool.name === 'run_command' || tool.name === 'git_status'), false);
  await session.end();
});

test('managed Worker startup supports temporary storage, failure and explicit teardown', async t => {
  const factory = new IDBFactory(), previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'); Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true }); t.after(() => { if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB; });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...library, workspace: {} }));
  const messages: RpcMessage[] = []; let receive!: (event: { data: RpcRequest }) => void;
  const cleanup = await startManagedWorker({ location: { href: 'https://guide.test/managed-worker.js?temporary=1' }, postMessage: value => messages.push(value), addEventListener: (_type, callback) => { receive = callback; } });
  receive({ data: { id: '1', action: 'managedStatus', payload: {} } }); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(messages[0]!.type, 'result'); cleanup();
  const personal = await startManagedWorker({ location: { href: 'https://guide.test/managed-worker.js?temporary=0&database=test' }, postMessage: () => undefined, addEventListener: () => undefined }); personal();
  const memory = await loadBrowserHarness('unused', 'https://guide.test/library.json', true); await memory.close();
});

test('a suspended linked page resumes its existing conversation on the next message', async () => {
  let now = 0; const harness = await backend(), session = new ManagedSession(harness, true, () => now);
  const messages: RpcMessage[] = [], host = new ManagedHost(session, message => messages.push(message));
  await host.handle({ id: 'first', action: 'chat', payload: { message: 'hello', use_memory: true, tools: [], ask_approval: true, agent: '', prompt: '' } });
  const id = harness.activeSessionRecord().id;
  await session.call('linkHeartbeat'); now = 30_000; await session.tick();
  await session.call('linkHeartbeat');
  await host.handle({ id: 'second', action: 'chat', payload: { message: 'continue', use_memory: true, tools: [], ask_approval: true, agent: '', prompt: '' } });
  assert.equal(messages.at(-1)!.type, 'done');
  assert.equal(harness.activeSessionRecord().id, id);
  assert.equal(harness.activeSessionRecord().events.filter(event => event.type === 'chat_user').length, 2);
  await session.end(); await session.tick();
});

test('explicitly ended managed chat reports an ended session without suggesting credential or model failures', async () => {
  let now = 0; const harness = await backend(), session = new ManagedSession(harness, true, () => now);
  const messages: RpcMessage[] = [], host = new ManagedHost(session, message => messages.push(message));
  await session.end();
  for (const message of ['What are you capable of?', 'hey']) {
    await host.handle({ id: message, action: 'chat', payload: { message } });
    const error = messages.at(-1)!;
    assert.equal(error.type, 'error');
    if (error.type === 'error') {
      assert.equal(error.status, 410); assert.match(error.message, /Guide session has ended/);
      assert.match(error.message, /open a new experiment/); assert.doesNotMatch(error.message, /vault|passphrase|privacy/);
    }
  }
});

test('vault initialization, configuration and bridge failure cannot restore authority after locking', async t => {
  const factory = new IDBFactory(), previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'); Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true }); t.after(() => { if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB; });
  const first = new ManagedSession(await backend(), false); assert.deepEqual(await first.call('vaultList'), []); await first.end();
  const harness = await backend(), storage = new MemoryStorage(), session = new ManagedSession(harness, false, Date.now, async () => storage);
  const creating = session.call('vaultCreate', { label: 'race', passphrase: password, confirmation: password }); const denied = assert.rejects(creating); await new Promise(resolve => setTimeout(resolve, 5)); await session.lock(); await denied;
  assert.equal((await session.call('managedStatus') as { vault: { locked: boolean } }).vault.locked, true);
  await session.call('vaultCreate', { label: 'MCP', passphrase: password, confirmation: password });
  let enter!: () => void, finish!: () => void; const started = new Promise<void>(resolve => { enter = resolve; });
  t.mock.method(harness, 'configureMcp', async () => { enter(); await new Promise<void>(resolve => { finish = resolve; }); return {}; });
  const connection = session.call('restoreMcp', { config: { mcpServers: {} } }), rejection = assert.rejects(connection); await started; await session.lock(); finish(); await rejection;
  await session.end();
  let resolveStorage!: (storage: MemoryStorage) => void; const delayed = new ManagedSession(await backend(), false, Date.now, () => new Promise(resolve => { resolveStorage = resolve; }));
  const listing = delayed.call('vaultList'), failure = assert.rejects(listing); await delayed.end(); resolveStorage(new MemoryStorage()); await failure;
  let now = 0; const remote = await backend(), bridgeSession = new ManagedSession(remote, true, () => now);
  t.mock.method(remote, 'attachBridge', async () => undefined); t.mock.method(remote, 'bridgeHeartbeat', async () => { throw new Error('offline'); });
  await bridgeSession.call('attachBridge', { endpoint: 'http://127.0.0.1:5001', code: 'fake' }); now = 5000; await bridgeSession.tick(); await bridgeSession.end();
});

test('managed worker buffers immediate RPC messages while loading its independent backend', async t => {
  let finish!: () => void; t.mock.method(globalThis, 'fetch', async () => { await new Promise<void>(resolve => { finish = resolve; }); return Response.json({ ...library, workspace: {} }); });
  let receive!: (event: { data: RpcRequest }) => void; const messages: RpcMessage[] = [];
  const start = startManagedWorker({ location: { href: 'https://guide.test/managed-worker.js' }, postMessage: message => messages.push(message), addEventListener: (_type, listener) => { receive = listener; } });
  receive({ data: { id: 'early', action: 'managedStatus', payload: {} } }); finish(); const cleanup = await start; assert.equal(messages[0]!.id, 'early'); cleanup();
});

test('locking during bridge and MCP preparation rejects the proposed connection', async t => {
  const harness = await backend(), session = new ManagedSession(harness, false, Date.now, async () => new MemoryStorage());
  t.mock.method(harness, 'attachBridge', async () => { await session.lock(); });
  await assert.rejects(session.call('attachBridge', { endpoint: 'http://127.0.0.1:5001', code: 'fake' }), /cancelled/);
  await session.call('vaultCreate', { label: 'Mine', passphrase: password, confirmation: password });
  t.mock.method(CredentialVault.prototype, 'read', async () => { await session.lock(); return '{}'; });
  await assert.rejects(session.call('restoreMcp', { config: { mcpServers: { one: { url: 'https://mcp.test' } } } }), /cancelled/);
  await assert.rejects(session.call('connectModel', { config: { provider: 'openai', model: 'test' }, restore: true }), /locked/);
  t.mock.method(harness, 'configureModel', async () => undefined);
  await session.call('vaultCreate', { label: 'Mine', passphrase: password, confirmation: password });
  await assert.rejects(session.call('connectModel', { config: { provider: 'openai', model: 'test' }, remember: true }), /API key/);
  await session.call('forgetModel', { provider: 'openai' }); await session.call('forgetMcp', { config: { mcpServers: { one: { url: 'https://mcp.test' } } } });
  await session.call('endSession');
});

test('completed connection callbacks are rejected when locking overtakes model or vault unlock', async t => {
  const harness = await backend(), session = new ManagedSession(harness, false, Date.now, async () => new MemoryStorage());
  t.mock.method(harness, 'configureModel', async () => { await session.lock(); });
  await assert.rejects(session.call('connectModel', { config: { mode: 'demo', model: 'scripted-demo' } }), /cancelled/);
  t.mock.method(CredentialVault.prototype, 'unlock', async () => { await session.lock(); });
  await assert.rejects(session.call('vaultUnlock', { id: 'fixture', passphrase: password }), /cancelled/); await session.end();
});

test('managed Worker executable initializes its backend and reports startup failure', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self'); Object.defineProperty(globalThis, 'self', { configurable: true, value: { location: { href: 'https://guide.test/managed-worker.js' }, postMessage() {}, addEventListener() {} } }); t.after(() => { if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self'); });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...library, workspace: {} }));
  t.mock.method(globalThis, 'setInterval', (() => ({ unref() {} })) as unknown as typeof setInterval);
  await import('../ui/managed-worker.js'); await new Promise(resolve => setImmediate(resolve));
  const { spawnSync } = await import('node:child_process');
  const failed = spawnSync(process.execPath, ['--input-type=module', '-e', "process.once('uncaughtException', error => { if (error.message !== 'Managed backend unavailable') process.exitCode = 1; }); globalThis.self = {location:{href:'invalid'}}; await import('./dist/typescript/ui/managed-worker.js');"], { encoding: 'utf8' }); assert.equal(failed.status, 0, failed.stderr);
});

test('runtime attachment is rejected if a turn starts while pairing is in flight', async t => {
  const { BridgeClient } = await import('../src/browser/bridge.js'); const harness = await backend(); let stream: AsyncGenerator | undefined;
  t.mock.method(BridgeClient.prototype, 'pair', async () => { stream = harness.submit({ message: 'hello', useMemory: true, tools: [], askApproval: true, agent: '', prompt: '' }); await stream.next(); });
  await assert.rejects(harness.attachBridge('http://127.0.0.1:5001', 'fake'), /running/);
  await stream!.return(undefined); await harness.close(); harness.closeStorage();
});

test('managed MCP credentials never go to the legacy local debug endpoint', async t => {
  const { reportBrowserMcpConfig } = await import('../src/browser/fetch.js');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location'); Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '?managed=1', hostname: 'localhost' } }); t.after(() => { if (previous) Object.defineProperty(globalThis, 'location', previous); else Reflect.deleteProperty(globalThis, 'location'); });
  let requested = false; t.mock.method(globalThis, 'fetch', async () => { requested = true; return new Response(); });
  await reportBrowserMcpConfig({ call: async () => { throw new Error('must not inspect credentials'); } } as unknown as import('../src/browser/client.js').WorkerClient); assert.equal(requested, false);
});

test('legacy harness connection actions obey managed lifecycle locking and reject all actions after End session', async t => {
  const harness = await backend(), session = new ManagedSession(harness, true), messages: RpcMessage[] = [], host = new ManagedHost(session, message => messages.push(message));
  t.mock.method(harness, 'configureModel', async () => { await session.lock(); });
  await host.handle({ id: 'race', action: 'configureModel', payload: { provider: 'demo' } }); assert.equal(messages.at(-1)!.type, 'error');
  t.mock.method(harness, 'listModels', async () => [{ id: 'fixture', label: 'Fixture' }]);
  await host.handle({ id: 'models', action: 'listModels', payload: { provider: 'demo' } }); assert.equal(messages.at(-1)!.type, 'result');
  await session.end(); await host.handle({ id: 'closed', action: 'bootstrap', payload: {} }); assert.equal(messages.at(-1)!.type, 'error');
});

test('shared-computer inactivity locks credentials even without page heartbeats', async t => {
  let now = 0; const harness = await backend(), session = new ManagedSession(harness, true, () => now);
  let locks = 0; const lock = harness.lockCredentials.bind(harness);
  t.mock.method(harness, 'lockCredentials', async () => { locks++; await lock(); });
  now = 599_999; await session.tick(); assert.equal(locks, 0);
  now++; await session.tick(); assert.equal(locks, 1);
  const host = new ManagedHost(session, () => undefined);
  await host.handle({ id: 'resume', action: 'bootstrap', payload: {} });
  now += 599_999; await session.tick(); assert.equal(locks, 1);
  await session.end();
});

test('managed host preserves safe backend diagnostics and sanitizes unexpected administrative exceptions', async t => {
  const { BackendError } = await import('../src/harness.js');
  const harness = await backend(), session = new ManagedSession(harness, false), messages: RpcMessage[] = [];
  const host = new ManagedHost(session, message => messages.push(message));
  for (const exception of [new BackendError('A turn is already running.', 409), new Error('PRIVATE unexpected exception')]) {
    t.mock.method(session, 'call', async () => { throw exception; });
    await host.handle({ id: 'check', action: 'managedStatus', payload: {} });
    const result = messages.at(-1)!; assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.failure!.source, 'harness');
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
      assert.match(result.failure!.reason, exception instanceof BackendError ? /already running/ : /could not be completed/);
    }
    t.mock.restoreAll();
  }
  await session.end();
});

test('managed administrative diagnostics preserve safe backend details and sanitize unknown errors', async t => {
  const harness = await backend(), session = new ManagedSession(harness, true), messages: RpcMessage[] = [];
  const host = new ManagedHost(session, message => messages.push(message));
  const detail = { source: 'bridge' as const, component: 'Tokenizer startup', reason: 'Executable missing', recovery: 'Install llama.cpp.' };
  for (const error of [new DiagnosticError(detail), new BackendError('The backend is busy.'), new Error('SECRET')]) {
    t.mock.method(session, 'call', async () => { throw error; });
    await host.handle({ id: 'check', action: 'activity', payload: {} });
    const message = messages.at(-1)!; assert.equal(message.type, 'error');
    if (message.type === 'error') { assert.equal(message.status, 400); assert.ok(!message.message.includes('SECRET')); if (error instanceof DiagnosticError) assert.deepEqual(message.failure, detail); }
    t.mock.restoreAll();
  }
  await session.end();
});

test('private bridge heartbeat failures preserve the model connection for retry', async t => {
  let now = 0; const harness = await backend(), session = new ManagedSession(harness, false, () => now);
  t.mock.method(harness, 'attachBridge', async () => undefined);
  t.mock.method(harness, 'bridgeHeartbeat', async () => { throw new Error('bridge process unavailable'); });
  let locked = false; t.mock.method(harness, 'lockCredentials', async () => { locked = true; });
  await session.call('attachBridge', { endpoint: 'http://127.0.0.1:5001', code: 'fixture' });
  now = 5000; await session.tick(); assert.equal(locked, false);
  assert.equal((await harness.bootstrap()).ready, true);
  await session.end(); assert.equal(locked, true);
});

test('private Guide pairing retains real native bridge authority after browser suspension', async t => {
  let now = 0;
  const root = await mkdtemp(path.join(tmpdir(), 'private-guide-bridge-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'resume.txt'), 'still connected');
  const bridge = new NativeBridge({ workspace: root, origin: 'https://guide.test', now: () => now, grants: { commands: true, writes: false, gitWrites: false } });
  const server = createBridgeServer(bridge); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { bridge.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, realFetch = fetch;
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => realFetch(url, { ...init, headers: { ...init.headers, origin: bridge.origin } }));
  const harness = await backend(), session = new ManagedSession(harness, false, () => now);
  await session.call('attachBridge', { endpoint: base, code: bridge.code });
  now = 24 * 60 * 60 * 1000; bridge.sweep(); await session.tick();
  assert.equal(harness.bridgeStatus().connected, true);
  assert.equal((await harness.exportProject()).files['resume.txt'], 'still connected');
  assert.ok(((await harness.bootstrap()).tools as { name: string }[]).some((tool: { name: string }) => tool.name === 'run_command'));
  await session.end();
});

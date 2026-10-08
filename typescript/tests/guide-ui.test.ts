import assert from 'node:assert/strict';
import test from 'node:test';
import { mountGuide } from '../ui/guide.js';
import { ChannelWorker, SessionRelay } from '../src/browser/channel.js';
import { harnessClient } from '../src/browser/handoff.js';
import { watchGuideState } from '../ui/guide-state.js';
import type { WorkerPort } from '../src/browser/client.js';
import type { RpcMessage, RpcRequest } from '../src/browser/worker-host.js';

class Events {
  listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, fn: (event: any) => void) { let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(fn); }
  removeEventListener(type: string, fn: (event: any) => void) { this.listeners.get(type)?.delete(fn); }
  emit(type: string, event: any = {}) { for (const fn of [...this.listeners.get(type) ?? []]) fn(event); }
}
class Element extends Events {
  value = ''; textContent = ''; hidden = false; disabled = false; checked = false; children: Element[] = [];
  replaceChildren(...children: Element[]) { this.children = children; this.value = children[0]?.value ?? ''; }
  append(child: Element) { this.children.push(child); if (this.children.length === 1) this.value = child.value; }
}
class Port extends Events {
  peer?: Port; closed = false; messages: unknown[] = [];
  postMessage(value: unknown) { this.messages.push(value); this.peer?.emit('message', { data: value }); }
  start() {} close() { this.closed = true; }
}
class Backend extends Events implements WorkerPort {
  requests: RpcRequest[] = []; ended = false; reject = ''; values: Record<string, unknown> = {};
  postMessage(request: RpcRequest) { this.requests.push(request); queueMicrotask(() => this.emit('message', { data: request.action === this.reject ? { id: request.id, type: 'error', message: 'PRIVATE' } : { id: request.id, type: 'result', value: this.values[request.action] ?? { ok: true } } })); }
  terminate() { this.ended = true; }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(origin = 'https://guide.test') {
  const elements = new Map<string, Element>();
  const get = (id: string) => { let element = elements.get(id); if (!element) elements.set(id, element = new Element()); return element; };
  get('privacy').value = 'shared'; get('provider').value = 'ollama';
  const document_ = { getElementById: get, createElement: () => new Element() } as unknown as Document;
  const events = new Events(); let timer!: () => void;
  const child = { closed: false, focusCount: 0, focus() { this.focusCount++; }, postMessage() {} };
  const window_ = Object.assign(events, { location: { href: origin + '/guide.html', origin }, setInterval: (fn: () => void) => { timer = fn; return 1; }, clearInterval() {} }) as unknown as Window;
  const worker = new Backend(); let popup = true; let count = 0;
  const ports: Port[] = [];
  const cleanup = mountGuide(document_, window_, { worker: url => { assert.equal(url.searchParams.get('temporary'), get('privacy').value === 'shared' ? '1' : '0'); count++; return worker; }, open: () => popup ? child as unknown as Window : null, channel: () => { const port1 = new Port(), port2 = new Port(); port1.peer = port2; port2.peer = port1; ports.push(port1, port2); return { port1, port2 } as unknown as MessageChannel; } });
  const click = async (id: string) => { get(id).emit('click'); await settle(); };
  return { get, click, worker, events, child, ports, cleanup, poll: () => timer(), setPopup: (value: boolean) => { popup = value; }, count: () => count };
}

test('guide renders privacy and forwards connection/vault/MCP actions without retaining input secrets', async () => {
  const f = fixture(); assert.equal(f.get('save-key').disabled, true); f.events.emit('pointerdown'); await f.click('end-session');
  f.get('save-key').checked = f.get('restore-key').checked = true; await f.click('connect-model'); assert.equal(f.worker.requests.at(-1)!.payload.remember, false); assert.equal(f.worker.requests.at(-1)!.payload.restore, false);
  f.get('save-key').checked = f.get('restore-key').checked = false;
  f.worker.values.listModels = [{ id: 'm', label: 'Model' }]; await f.click('check-models'); assert.equal(f.get('model').value, 'm');
  f.worker.values.listModels = []; await f.click('check-models'); assert.match(f.get('status').textContent, /No models/);
  f.get('privacy').value = 'personal'; f.get('privacy').emit('change'); await settle(); assert.equal(f.get('personal-fields').hidden, false);
  f.get('provider').value = 'openai'; f.get('api-key').value = 'PRIVATE'; f.get('provider').emit('change'); assert.equal(f.get('api-key').value, '');
  f.get('api-key').value = 'PRIVATE'; f.get('model-id').value = 'explicit'; f.get('save-key').checked = true; f.get('restore-key').checked = true;
  await f.click('connect-model'); assert.equal(f.get('api-key').value, ''); assert.equal(f.worker.requests.at(-1)!.payload.remember, true);
  f.get('model-id').value = ''; f.get('save-key').checked = false; f.get('restore-key').checked = false; await f.click('connect-model');
  f.worker.values.vaultList = []; await f.click('list-vaults'); assert.match(f.get('status').textContent, /No saved/);
  f.worker.values.vaultList = [{ id: 'v', label: 'Mine' }]; await f.click('list-vaults'); assert.equal(f.get('vault').value, 'v');
  f.worker.values.vaultCreate = { id: 'v2' }; f.get('passphrase').value = 'PRIVATE'; await f.click('create-vault'); assert.equal(f.get('passphrase').value, '');
  f.worker.values.attachBridge = { connection: { workspace: '/bridge-workspace', grants: { writes: true, commands: true, gitWrites: true } } };
  for (const button of ['unlock-vault', 'forget-model', 'delete-vault', 'lock', 'connect-bridge']) await f.click(button);
  f.worker.values.attachBridge = { connection: { workspace: '/bridge-workspace', grants: { writes: false, commands: false, gitWrites: false } } }; await f.click('connect-bridge'); assert.match(f.get('status').textContent, /unavailable/);
  for (const button of ['save-mcp', 'restore-mcp', 'forget-mcp']) { f.get('mcp-config').value = '{"mcpServers":{}}'; await f.click(button); assert.equal(f.get('mcp-config').value, ''); }
  f.worker.reject = 'connectModel'; f.get('api-key').value = 'PRIVATE'; await f.click('connect-model'); assert.doesNotMatch(f.get('status').textContent, /PRIVATE/); assert.equal(f.get('api-key').value, '');
  f.events.emit('keydown'); await settle(); await f.click('end-session'); assert.equal(f.worker.ended, true); f.cleanup();
});

test('guide handoff validates window identity, replaces a reloaded tab connection and closes linked sessions', async t => {
  const f = fixture(); f.setPopup(false); await f.click('open-harness'); assert.match(f.get('status').textContent, /Could not/);
  f.setPopup(true); await f.click('open-harness'); await f.click('open-harness'); assert.equal(f.child.focusCount, 1); assert.equal(f.count(), 1);
  for (const event of [{ source: f.child, origin: 'https://evil.test', data: { type: 'harness-ready' } }, { source: {}, origin: 'https://guide.test', data: { type: 'harness-ready' } }, { source: f.child, origin: 'https://guide.test', data: { type: 'wrong' } }]) f.events.emit('message', event);
  assert.equal(f.ports.length, 0);
  const ready = { source: f.child, origin: 'https://guide.test', data: { type: 'harness-ready' } }; f.events.emit('message', ready); f.events.emit('message', ready); assert.equal(f.ports.length, 4); assert.equal(f.ports[0]!.closed, true); assert.equal(f.ports[2]!.closed, false);
  const before = f.worker.requests.length;
  f.ports[1]!.postMessage({ id: 'stale', action: 'endSession', payload: {} }); await settle(); assert.equal(f.worker.requests.length, before);
  f.ports[3]!.postMessage({ id: 'remote', action: 'bootstrap', payload: {} }); await settle(); assert.ok(f.ports[2]!.messages.length);
  f.ports[3]!.postMessage({ type: 'link-close' }); await settle(); assert.equal(f.worker.ended, true); f.events.emit('message', ready); f.cleanup();
  const g = fixture(); await g.click('open-harness'); g.child.closed = true; g.poll(); await settle(); assert.equal(g.worker.ended, true); g.cleanup();
  const h = fixture(); await h.click('open-harness'); h.events.emit('pagehide'); await settle(); assert.equal(h.worker.ended, true); h.cleanup();
  const failed = fixture(); await failed.click('open-harness');
  t.mock.method(failed.child, 'postMessage', () => { throw new Error('Transfer failed'); });
  failed.events.emit('message', { ...ready, source: failed.child });
  assert.equal(failed.ports[0]!.closed, true); assert.equal(failed.ports[1]!.closed, true);
  assert.match(failed.get('status').textContent, /Could not connect the harness tab/); await failed.click('end-session'); failed.cleanup();
});

test('channel adapter preserves RPC, errors, listener removal and empty relay shutdown', async () => {
  const port = new Port(), adapter = new ChannelWorker(port); let messages = 0, errors = 0;
  const message = () => { messages++; }, error = () => { errors++; };
  adapter.addEventListener('message', message); adapter.addEventListener('error', error);
  port.emit('message', { data: { type: 'result' } }); port.emit('message', { data: { type: 'closed' } }); assert.equal(messages, 1); assert.equal(errors, 1);
  adapter.removeEventListener('message', message); adapter.removeEventListener('error', error); port.emit('message', { data: { type: 'closed' } });
  adapter.postMessage({ id: '1', action: 'bootstrap', payload: {} }); adapter.terminate(); assert.equal(port.closed, true);
  const worker = new Backend(), relay = new SessionRelay(worker, () => undefined); worker.emit('message', { data: { type: 'result' } }); relay.close();
  relay.attach(new Port()); assert.throws(() => relay.attach(new Port()), /already has/); relay.close();
});

test('managed setup notifications refresh only the linked view and stop on unload', async () => {
  let refreshes = 0; const failures: unknown[] = [];
  const refresh = async () => { refreshes++; }, failure = (error: unknown) => failures.push(error);
  for (const window_ of [
    { location: { href: 'https://guide.test/index.html' } },
    { location: { href: 'https://guide.test/index.html?managed=1' } },
  ]) watchGuideState(window_ as Window, refresh, failure)();
  const events = new Events(), opener = {}, window_ = Object.assign(events, { opener, location: { href: 'https://guide.test/index.html?managed=1', origin: 'https://guide.test' } }) as unknown as Window;
  const cleanup = watchGuideState(window_, refresh, failure);
  const changed = { origin: 'https://guide.test', source: opener, data: { type: 'harness-state-changed' } };
  for (const event of [{ ...changed, origin: 'https://other.test' }, { ...changed, source: {} }, { ...changed, data: {} }, { ...changed, data: undefined }]) events.emit('message', event);
  assert.equal(refreshes, 0);
  events.emit('message', changed); await settle(); assert.equal(refreshes, 1);
  cleanup(); events.emit('message', changed); await settle(); assert.equal(refreshes, 1);
  const offline = new Error('Backend unavailable');
  const stop = watchGuideState(window_, async () => { throw offline; }, failure);
  events.emit('message', changed); await settle(); assert.deepEqual(failures, [offline]); stop();
});

test('Guide notifies its live harness after setup changes, including bridge pairing', async t => {
  const f = fixture(); await f.click('open-harness');
  const messages: { type: string; origin: string }[] = [];
  t.mock.method(f.child, 'postMessage', (message: { type: string }, origin: string) => messages.push({ type: message.type, origin }));
  f.worker.values.attachBridge = { connection: { workspace: '/bridge-workspace', grants: { writes: true, commands: true, gitWrites: true } } };
  for (const action of ['connect-bridge', 'connect-model', 'lock', 'delete-vault', 'save-mcp', 'restore-mcp', 'disconnect-bridge']) {
    f.get('mcp-config').value = '{}'; await f.click(action);
    assert.deepEqual(messages.at(-1), { type: 'harness-state-changed', origin: 'https://guide.test' });
  }
  assert.equal(messages.length, 7);
  assert.match(f.get('bridge-status').textContent, /Bridge unpaired/);
  f.worker.reject = 'attachBridge'; await f.click('connect-bridge'); assert.equal(messages.length, 7);
  f.child.closed = true; await f.click('lock'); assert.equal(messages.length, 7);
  await f.click('end-session'); f.cleanup();
});

test('harness handoff accepts only the guide port and handles missing opener, timeout and closure', async t => {
  const worker = new Backend(), previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker'); Object.defineProperty(globalThis, 'Worker', { configurable: true, value: function () { return worker; } }); t.after(() => { if (previous) Object.defineProperty(globalThis, 'Worker', previous); else delete (globalThis as { Worker?: unknown }).Worker; });
  const direct = await harnessClient({ location: { href: 'https://guide.test/index.html' } } as Window, new URL('https://guide.test/backend-worker.js')); await direct.call('bootstrap'); direct.close();
  await assert.rejects(harnessClient({ location: { href: 'https://guide.test/index.html?managed=1' } } as Window, new URL('https://guide.test/worker.js')), /Guide/);
  const events = new Events(), opener = { postMessage() {} }, window_ = Object.assign(events, { opener, setInterval: () => 1, clearInterval: () => undefined, location: { href: 'https://guide.test/index.html?managed=1', origin: 'https://guide.test' } }) as unknown as Window;
  let timeout!: () => void; t.mock.method(globalThis, 'setTimeout', ((fn: () => void) => { timeout = fn; return 1; }) as typeof setTimeout); t.mock.method(globalThis, 'clearTimeout', () => undefined);
  const failed = harnessClient(window_, new URL('https://guide.test/worker.js')); const rejection = assert.rejects(failed, /timed out/); timeout(); await rejection;
  const connected = harnessClient(window_, new URL('https://guide.test/worker.js')), port = new Port();
  for (const event of [{ origin: 'bad', source: opener, data: {} }, { origin: 'https://guide.test', source: {}, data: {} }, { origin: 'https://guide.test', source: opener, data: { type: 'wrong' } }, { origin: 'https://guide.test', source: opener, data: { type: 'harness-port' }, ports: [] }]) events.emit('message', event);
  events.emit('message', { origin: 'https://guide.test', source: opener, data: { type: 'harness-port' }, ports: [port] }); const client = await connected;
  events.emit('pointerdown'); events.emit('keydown'); events.emit('pagehide'); await settle(); await assert.rejects(client.call('bootstrap'), /closed/);
  assert.equal(port.closed, true);
  assert.equal(port.messages.some(message => (message as RpcRequest).action === 'endSession' || (message as { type: string }).type === 'link-close'), false);
});

test('guide module bootstrap uses the actual platform adapters', async t => {
  const f = fixture(); f.cleanup(); const elements = new Map<string, Element>(), get = (id: string) => { let element = elements.get(id); if (!element) elements.set(id, element = new Element()); return element; }; get('privacy').value = 'shared';
  const worker = new Backend(), events = new Events(), child = { closed: false, focus() {}, postMessage() {} };
  const window_ = Object.assign(events, { location: { href: 'https://guide.test/guide.html', origin: 'https://guide.test' }, setInterval: () => 1, clearInterval() {}, open: () => child });
  const globals: Record<string, unknown> = { document: { getElementById: get, createElement: () => new Element() }, window: window_, Worker: class { constructor() { return worker; } }, MessageChannel: class { port1 = new Port(); port2 = new Port(); } };
  for (const [key, value] of Object.entries(globals)) { const previous = Object.getOwnPropertyDescriptor(globalThis, key); Object.defineProperty(globalThis, key, { value, configurable: true }); t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); }); }
  await import('../ui/guide-entry.js'); get('open-harness').emit('click'); await settle(); events.emit('message', { origin: 'https://guide.test', source: child, data: { type: 'harness-ready' } }); events.emit('pagehide'); await settle();
});

test('bridge setup shows immediate local progress, sanitized failure and successful retry', async () => {
  const f = fixture();
  assert.equal(f.get('bridge-origin').textContent, 'https://guide.test');
  let pending!: RpcRequest; const original = f.worker.postMessage.bind(f.worker);
  f.worker.postMessage = request => { if (request.action === 'attachBridge') { f.worker.requests.push(request); pending = request; } else original(request); };
  f.get('bridge-code').value = 'PRIVATE'; f.get('connect-bridge').emit('click');
  assert.equal(f.get('connect-bridge').disabled, true); assert.match(f.get('bridge-status').textContent, /Connecting/);
  assert.equal(f.get('bridge-status').textContent, f.get('status').textContent);
  f.worker.emit('message', { data: { id: pending.id, type: 'error', message: 'PRIVATE' } }); await settle();
  assert.equal(f.get('connect-bridge').disabled, false); assert.equal(f.get('bridge-code').value, '');
  assert.match(f.get('bridge-status').textContent, /Could not connect/); assert.match(f.get('bridge-status').textContent, /exact origin/); assert.doesNotMatch(f.get('bridge-status').textContent, /PRIVATE/);
  f.get('bridge-code').value = 'FRESH'; f.get('connect-bridge').emit('click');
  f.worker.emit('message', { data: { id: pending.id, type: 'result', value: { connection: { workspace: '/bridge-workspace', grants: { writes: true, commands: false, gitWrites: false } } } } }); await settle();
  assert.match(f.get('bridge-status').textContent, /Native workspace connected/); assert.match(f.get('bridge-status').textContent, /Bash: unavailable/);
  assert.equal(f.get('connect-bridge').disabled, false); assert.equal(f.get('bridge-code').value, '');
  await f.click('lock'); assert.equal(f.get('bridge-status').textContent, ''); await f.click('end-session'); f.cleanup();
});

test('model setup shows immediate local progress, sanitized failure and successful retry', async () => {
  const f = fixture(); let pending!: RpcRequest; const original = f.worker.postMessage.bind(f.worker);
  f.worker.postMessage = request => { if (request.action === 'connectModel') { f.worker.requests.push(request); pending = request; } else original(request); };
  f.get('api-key').value = 'PRIVATE'; f.get('connect-model').emit('click');
  assert.equal(f.get('connect-model').disabled, true); assert.match(f.get('model-status').textContent, /Connecting/);
  assert.equal(f.get('model-status').textContent, f.get('status').textContent);
  f.worker.emit('message', { data: { id: pending.id, type: 'error', message: 'PRIVATE' } }); await settle();
  assert.equal(f.get('connect-model').disabled, false); assert.equal(f.get('api-key').value, '');
  assert.match(f.get('model-status').textContent, /Could not connect/); assert.doesNotMatch(f.get('model-status').textContent, /PRIVATE/);
  f.get('connect-model').emit('click'); f.worker.emit('message', { data: { id: pending.id, type: 'result', value: { ok: true } } }); await settle();
  assert.match(f.get('model-status').textContent, /Model connected/); assert.equal(f.get('connect-model').disabled, false);
  f.get('provider').emit('change'); assert.equal(f.get('model-status').textContent, '');
  await f.click('end-session'); f.cleanup();
});


test('bridge failures show the exact HTTP or HTTPS restart argument without assuming a mismatch', async () => {
  for (const origin of ['http://localhost:5001', 'https://localhost:5001']) {
    const f = fixture(origin); f.worker.reject = 'attachBridge'; await f.click('connect-bridge');
    const message = f.get('bridge-status').textContent;
    assert.ok(message.includes('exact origin is ' + origin)); assert.ok(message.includes('--origin ' + origin));
    assert.match(message, /http:\/\/ and https:\/\/ are different origins/);
    assert.match(message, /Ctrl\+C/); assert.match(message, /new pairing code/); assert.match(message, /If the origin already matches/);
    assert.doesNotMatch(message, /PRIVATE/); await f.click('end-session'); f.cleanup();
  }
});

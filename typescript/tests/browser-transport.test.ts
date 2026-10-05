import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerClient, type WorkerPort } from '../src/browser/client.js';
import { WorkerHost, type RpcMessage, type RpcRequest } from '../src/browser/worker-host.js';
import { browserFetch } from '../src/browser/fetch.js';
import { BackendError } from '../src/harness.js';
import type { LocalDirectory } from '../src/browser/local.js';
import { projectFromFiles } from '../src/browser/workspace.js';
import { fixture, collect } from './browser-fixture.js';

class Wire implements WorkerPort {
  readonly listeners = new Map<string, Set<(event: { data?: RpcMessage; message?: string }) => void>>();
  sent: RpcRequest[] = []; terminated = false; handler: (request: RpcRequest) => void = () => {};
  postMessage(request: RpcRequest): void { this.sent.push(request); this.handler(request); }
  addEventListener(type: string, callback: (event: { data?: RpcMessage; message?: string }) => void): void { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(callback); }
  removeEventListener(type: string, callback: (event: { data?: RpcMessage; message?: string }) => void): void { this.listeners.get(type)!.delete(callback); }
  terminate(): void { this.terminated = true; }
  send(message: RpcMessage) { for (const listener of this.listeners.get('message')!) listener({ data: message }); }
  crash(event: { message?: string } = {}) { for (const listener of this.listeners.get('error')!) listener(event); }
}
const turn = { message: 'List files', tools: ['list_files', 'read_file', 'write_file', 'edit_file'], use_memory: true, ask_approval: true, agent: '', prompt: '' };

test('Worker transport exposes the complete backend session/project/model lifecycle headlessly', async t => {
  const { backend } = await fixture(t), wire = new Wire(); let loads = 0;
  const host = new WorkerHost(async () => { loads++; return backend; }, value => wire.send(value)); wire.handler = request => { void host.handle(request); };
  const client = new WorkerClient(wire); t.after(() => client.close());
  assert.equal((await client.call('bootstrap') as { runtime: string }).runtime, 'browser');
  const first = (await client.call('sessions') as { active_id: string }).active_id;
  assert.equal((await client.call('getSession', { id: first }) as { id: string }).id, first);
  await client.call('patchSession', { id: first, name: 'renamed' });
  const record = await client.call('getSession', { id: first });
  await client.call('importSession', record as Record<string, unknown>);
  await client.call('newSession', { name: 'named' }); await client.call('newSession'); await client.call('newSession', { name: 4 });
  await client.call('activateSession', { id: first });
  await client.call('importProject', projectFromFiles('/code', { 'nested/file': 'code' }) as unknown as Record<string, unknown>);
  await client.call('project', { path: '/workspace' });
  assert.ok(await client.call('browse')); assert.ok(await client.call('browse', { path: '/' })); assert.ok(await client.call('exportProject'));
  assert.ok(await client.call('explore', turn));
  const events = await collect(client.stream('chat', turn)); assert.ok(events.some(event => event.type === 'tool'));
  await assert.rejects(collect(client.stream('compact', { session_id: first, use_memory: false })), /Enable Harness memory/);
  assert.ok((await collect(client.stream('compact', { session_id: first, use_memory: true }))).some(event => event.type === 'context'));
  await collect(client.stream('compact')); await client.call('reset'); await client.call('stop'); await client.call('configureModel', { mode: 'demo' });
  await client.call('configureModel', { mode: 'demo', url: 'http://localhost', model: 'unused' });
  await assert.rejects(client.call('listModels', { provider: 'demo' }), /real model/);
  const listing = t.mock.method(backend, 'listModels', async (value: { provider?: string }) => { assert.equal(value.provider, 'ollama'); return [{ id: 'installed', label: 'Installed' }]; });
  assert.deepEqual(await client.call('listModels', { provider: 'ollama' }), [{ id: 'installed', label: 'Installed' }]); listing.mock.restore();
  await client.call('forgetApiKey');
  for (const payload of [{}, { mode: 4 }, { mode: 'demo', url: 4 }, { mode: 'demo', model: 4 }]) await assert.rejects(client.call('configureModel', payload), /settings/);
  for (const payload of [{ approved: 'true' }, { approved: true }, { approved: true, id: 'expired' }]) await assert.rejects(client.call('approve', payload), /boolean|waiting/);
  await assert.rejects(client.call('project'), /string/); await assert.rejects(client.call('unknown'), (error: BackendError) => error.status === 404);
  await assert.rejects(client.call('attachLocalFolder', { handle: { kind: 'file' } }), /directory/);
  const attach = t.mock.method(backend, 'attachLocalFolder', async (handle: LocalDirectory) => { assert.equal(handle.kind, 'directory'); return { ok: true }; });
  assert.deepEqual(await client.call('attachLocalFolder', { handle: { kind: 'directory' } }), { ok: true }); attach.mock.restore();
  assert.equal(loads, 1);
  const stream = client.stream('chat', { ...turn, message: 'Write approved.txt: yes' });
  for await (const event of stream) if (event.type === 'approval') await client.call('approve', { id: event.id, approved: true });
  assert.equal((await backend.exportProject()).files['approved.txt'], 'yes\n');
  const stopped = client.stream('chat', { ...turn, message: 'Write stopped.txt: no' });
  for await (const event of stopped) if (event.type === 'approval') { await client.call('stop'); break; }
  await new Promise(resolve => setImmediate(resolve)); assert.equal((await backend.exportProject()).files['stopped.txt'], undefined);
  await host.handle({ id: 'unknown-cancel', action: 'cancel', payload: {} });
});

test('Worker client reports send failures, streamed failures, crashes and cancellation and closes listeners', async () => {
  const wire = new Wire(), client = new WorkerClient(wire);
  wire.send({ id: 'unknown', type: 'done' });
  wire.handler = request => wire.send({ id: request.id, type: 'result', value: 42 }); assert.equal(await client.call('x'), 42);
  wire.handler = request => wire.send({ id: request.id, type: 'error', message: 'denied', status: 409 }); await assert.rejects(client.call('x'), /denied/); await assert.rejects(collect(client.stream('x')), /denied/);
  wire.handler = () => { throw new Error('cannot clone'); }; await assert.rejects(client.call('x'), /clone/); await assert.rejects(collect(client.stream('x')), /clone/);
  wire.handler = request => { if (request.action !== 'cancel') { wire.send({ id: request.id, type: 'event', event: { type: 'response', content: 'one' } }); wire.send({ id: request.id, type: 'event', event: { type: 'response', content: 'two' } }); wire.send({ id: request.id, type: 'done' }); } };
  assert.equal((await collect(client.stream('x'))).length, 2);
  wire.handler = request => { if (request.action !== 'cancel') queueMicrotask(() => wire.send({ id: request.id, type: 'event', event: { type: 'response', content: 'one' } })); };
  const cancelled = client.stream('x'); await cancelled.next(); await cancelled.return(undefined); assert.equal(wire.sent.at(-1)!.action, 'cancel');
  wire.handler = () => {};
  const waiting = client.call('x'), stream = client.stream('x'), next = stream.next(); wire.crash();
  await assert.rejects(waiting, /stopped/); await assert.rejects(next, /stopped/); await assert.rejects(client.call('x'), /closed/); await assert.rejects(collect(client.stream('x')), /closed/);
  client.close(); assert.ok(wire.terminated); assert.equal(wire.listeners.get('message')!.size, 0);
  const wire2 = new Wire(), client2 = new WorkerClient(wire2), pending = client2.call('x'); wire2.crash({ message: 'Worker exploded' }); await assert.rejects(pending, /exploded/); client2.close();
});

test('Worker host surfaces loading and model errors, including non-Error exceptions', async t => {
  const messages: RpcMessage[] = [], broken = new WorkerHost(async () => { throw 'load failed'; }, message => messages.push(message));
  await broken.handle({ id: '1', action: 'bootstrap', payload: {} }); assert.deepEqual(messages[0], { id: '1', type: 'error', message: 'load failed', status: 400 });
  const { backend } = await fixture(t, { async *streamChat() { throw new Error('model failed'); } });
  const host = new WorkerHost(async () => backend, message => messages.push(message)); await host.handle({ id: '2', action: 'chat', payload: turn }); assert.match(JSON.stringify(messages), /model failed/); assert.equal(messages.at(-1)!.type, 'done');
});

test('fetch compatibility validates methods and JSON and maps sessions, state and NDJSON streams to Worker calls', async t => {
  const { backend } = await fixture(t), wire = new Wire(), host = new WorkerHost(async () => backend, message => wire.send(message)); wire.handler = request => { void host.handle(request); };
  const client = new WorkerClient(wire); t.after(() => client.close()); const fetch = browserFetch(client);
  const post = (route: string, body: unknown = {}) => fetch(route, { method: 'POST', body: JSON.stringify(body) });
  for (const route of ['/bootstrap', '/sessions', '/browse', '/browse?path=%2F']) assert.equal((await fetch(route)).status, 200);
  const created = await (await post('/sessions', { name: 'transport' })).json() as { session: { id: string } }, id = created.session.id;
  for (const suffix of ['', '/export']) assert.equal((await fetch('/sessions/' + id + suffix)).status, 200);
  assert.equal((await fetch('/sessions/' + id, { method: 'PATCH', body: '{"name":"changed"}' })).status, 200);
  assert.equal((await post('/sessions/' + id + '/activate')).status, 200);
  const exported = await (await fetch('/sessions/' + id + '/export')).json(); assert.equal((await post('/sessions/import', exported)).status, 201);
  for (const route of ['/reset', '/stop', '/project', '/explore']) assert.equal((await post(route, route === '/project' ? { path: '/workspace' } : turn)).status, 200);
  assert.equal((await post('/approve', { approved: true, id: 'expired' })).status, 404);
  assert.match(await (await post('/chat', turn)).text(), /"type":"tool"/); assert.match(await (await post('/compact')).text(), /context/);
  for (const route of ['/unknown', '/chat', '/compact']) assert.equal((await fetch(route)).status, 404);
  for (const body of ['null', '[]', '4', '{']) assert.equal((await fetch('/reset', { method: 'POST', body })).status, 400);
  for (const [route, method] of [['/sessions/x/export', 'PATCH'], ['/sessions/x', 'POST'], ['/unknown', 'POST'], ['/unknown', 'DELETE']]) assert.equal((await fetch(route!, { method: method! })).status, 404);
  assert.equal((await post('/chat', { message: 1 })).status, 400);
  const response = await post('/chat', { ...turn, message: 'Write cancelled.txt: no' }); const reader = response.body!.getReader();
  while (!(new TextDecoder().decode((await reader.read()).value)).includes('approval')) {} await reader.cancel(); assert.equal((await backend.exportProject()).files['cancelled.txt'], undefined);
});

test('fetch streams handle empty sources, pull errors and non-Error call failures', async () => {
  const empty = { async *stream() {}, async call() { return {}; } } as unknown as WorkerClient;
  assert.equal(await (await browserFetch(empty)('/chat', { method: 'POST' })).text(), '');
  const broken = { async *stream() { yield { type: 'response', content: 'partial' }; throw new Error('stream lost'); }, async call() { throw 'plain failure'; } } as unknown as WorkerClient;
  const fetch = browserFetch(broken); await assert.rejects((await fetch('/chat', { method: 'POST' })).text(), /stream lost/); assert.match(await (await fetch('/bootstrap')).text(), /plain failure/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserStorage } from '../src/browser/storage.js';
import { BrowserSessions } from '../src/browser/sessions.js';
import { createSession } from '../src/sessions.js';
import { loadBrowserHarness } from '../src/browser/startup.js';
import * as sdk from '../src/browser/index.js';

function global(t: { after(callback: () => void): void }, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
}

test('IndexedDB store persists independent snapshots and session saves recover after a rejected transaction', async t => {
  const factory = new IDBFactory(), storage = await BrowserStorage.open('test', factory); t.after(() => storage.close());
  const sessions = new BrowserSessions(storage), record = createSession({ workspace: '/workspace', model: 'scripted-demo', context_length: 4096 });
  const original = storage.put.bind(storage); let failed = false;
  t.mock.method(storage, 'put', async (store: string, key: string, value: unknown) => { if (!failed) { failed = true; throw new Error('quota exceeded'); } await original(store, key, value); });
  await assert.rejects(sessions.save(record), /quota/); record.name = 'saved'; await sessions.save(record); record.name = 'mutated'; assert.equal((await sessions.load(record.id)).name, 'saved');
  await assert.rejects(sessions.load('missing'), /session/);
  const other = createSession({ workspace: '/workspace', model: 'scripted-demo', context_length: 4096 }); await sessions.save(other); assert.equal((await sessions.list()).length, 2);
  // A version upgrade invokes the open database's versionchange handler and closes it.
  await new Promise<void>((resolve, reject) => { const request = factory.open('test', 2); request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error); });
  await assert.rejects(storage.get('settings', 'x'), { name: 'InvalidStateError' });
});

test('IndexedDB open, read and transaction failures remain explicit, including blocked storage', async () => {
  type Request = { result?: unknown; error?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void };
  const open = (event: 'onerror' | 'onblocked') => ({ open() { const request: Request = { error: new Error('open error') }; queueMicrotask(() => request[event]!()); return request; } }) as unknown as IDBFactory;
  await assert.rejects(BrowserStorage.open('error', open('onerror')), /open error/); await assert.rejects(BrowserStorage.open('blocked', open('onblocked')), /blocked/);
  let abortedError: unknown = new Error('quota');
  const database = { close() {}, transaction() {
    const transaction = { error: abortedError, onabort: undefined as (() => void) | undefined, objectStore() { return {
      get() { const request: Request = { error: new Error('read error') }; queueMicrotask(() => request.onerror!()); return request; },
      getAll() { const request: Request = { result: [] }; queueMicrotask(() => request.onsuccess!()); return request; },
      put() { queueMicrotask(() => transaction.onabort!()); },
    }; } }; return transaction;
  } };
  const factory = { open() { const request: Request = { result: database }; queueMicrotask(() => request.onsuccess!()); return request; } } as unknown as IDBFactory;
  const storage = await BrowserStorage.open('broken', factory); await assert.rejects(storage.get('settings', 'x'), /read error/); assert.deepEqual(await storage.all('sessions'), []);
  await assert.rejects(storage.put('settings', 'x', 1), /quota/); abortedError = null; await assert.rejects(storage.put('settings', 'x', 1), /transaction aborted/); storage.close();
});

test('browser startup loads the packaged library, reports fetch failures and closes storage on initialization failure', async t => {
  global(t, 'indexedDB', new IDBFactory());
  const library = { agents: {}, prompts: {}, skills: {}, workspace: { 'README.md': 'seed' } };
  t.mock.method(globalThis, 'fetch', async () => Response.json(library));
  assert.equal((await loadBrowserHarness('startup', 'http://static/library.json')).state.workspace, '/workspace');
  assert.ok(sdk.BrowserHarness); assert.ok(sdk.WorkerClient); assert.ok(sdk.DemoModel); assert.ok(sdk.OllamaAdapter);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 })); await assert.rejects(loadBrowserHarness('failed', 'http://static/library.json'), /instruction library/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...library, workspace: { '.': '' } }));
  await assert.rejects(loadBrowserHarness('bad', 'http://static/library.json'), /name/);
});

test('Worker entrypoint loads its own backend and dispatches messages without a DOM', async t => {
  global(t, 'indexedDB', new IDBFactory());
  t.mock.method(globalThis, 'fetch', async () => Response.json({ agents: {}, prompts: {}, skills: {}, workspace: {} }));
  let callback: (event: { data: unknown }) => void = () => {}; let resolve: (message: unknown) => void = () => {};
  const response = new Promise<unknown>(done => { resolve = done; });
  global(t, 'self', { location: { href: 'http://static/backend-worker.js?database=entry-test' }, addEventListener(_type: string, listener: typeof callback) { callback = listener; }, postMessage(message: unknown) { resolve(message); } });
  await import('../src/browser/worker-entry.js'); callback({ data: { id: 'entry', action: 'bootstrap', payload: {} } });
  assert.equal((await response as { type: string }).type, 'result');
  const defaultResponse = new Promise<unknown>(done => { resolve = done; });
  global(t, 'self', { location: { href: 'http://static/backend-worker.js' }, addEventListener(_type: string, listener: typeof callback) { callback = listener; }, postMessage(message: unknown) { resolve(message); } });
  const entry = '../src/browser/worker-entry.js'; await import(entry + '?defaults'); callback({ data: { id: 'default-entry', action: 'bootstrap', payload: {} } });
  assert.equal((await defaultResponse as { type: string }).type, 'result');
});

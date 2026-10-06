import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { NodeHarness } from '../src/node/harness.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { BrowserStorage } from '../src/browser/storage.js';
import { McpManager } from '../src/mcp/manager.js';
import { WorkerHost, type RpcMessage } from '../src/browser/worker-host.js';
import { browserFetch } from '../src/browser/fetch.js';
import type { WorkerClient } from '../src/browser/client.js';
import { createHarnessServer } from '../src/node/http.js';
import { request } from 'node:http';
import { FixtureServer, fixtureFetch } from './mcp-fixture.js';

const entry = { mcpServers: { added: { url: 'http://remote.test/mcp', headers: { Authorization: 'Bearer config-secret' } } } };
const model = { async *streamChat() { yield ''; } };

test('Node saves MCP entries atomically, preserves configuration and rejects collisions/errors without UI', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', fixtureFetch(new FixtureServer(), { stateless: true }));
  const file = path.join(root, 'mcp.json');
  const backend = new NodeHarness({ workspace: root, model: 'scripted', contextLength: 4000, ollama: model, mcpConfigFile: file });
  t.after(() => backend.close());
  assert.equal((await backend.addMcp(entry)).source, file);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), entry);
  assert.equal((backend.mcpStatus().servers as { status: string }[])[0]!.status, 'connected');
  const original = { comment: 'keep this', mcpServers: { existing: { disabled: true }, ...entry.mcpServers } };
  await writeFile(file, JSON.stringify(original));
  await backend.addMcp({ mcpServers: { other: { disabled: true } } });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...original, mcpServers: { ...original.mcpServers, other: { disabled: true } } });
  const before = await readFile(file, 'utf8');
  await assert.rejects(backend.addMcp(entry), /already exists/);
  await assert.rejects(backend.addMcp({ mcpServers: { broken: { command: '' } } }), /command must/);
  await assert.rejects(backend.addMcp({}), /at least one/);
  await assert.rejects(backend.addMcp(null), /JSON object/);
  assert.equal(await readFile(file, 'utf8'), before);
  await writeFile(file, 'null'); await assert.rejects(backend.addMcp(entry), /JSON object/);
  await writeFile(file, '{'); await assert.rejects(backend.addMcp(entry), /mcp.json/);
  await writeFile(file, '{}'); await backend.addMcp(entry);
  await rm(file); await mkdir(file); await assert.rejects(backend.addMcp(entry), /mcp.json/);
  await rm(file, { recursive: true });
  // A target directory appearing after the read makes atomic replacement fail.
  const read = (backend as unknown as { mcp: { runtime: { loadConfig: () => Promise<unknown> } } }).mcp.runtime;
  t.mock.method(read, 'loadConfig', async () => { await mkdir(file, { recursive: true }); return {}; });
  await assert.rejects(backend.addMcp(entry), /EISDIR/);
  assert.deepEqual(await readdir(root), ['mcp.json']);
  const missing = new NodeHarness({ workspace: root, model: 'scripted', contextLength: 4000, ollama: model });
  await assert.rejects(missing.addMcp(entry), /No MCP configuration file/);
  const badFolder = new NodeHarness({ workspace: root, model: 'scripted', contextLength: 4000, ollama: model, mcpConfigFile: path.join(root, 'missing', 'mcp.json') });
  await assert.rejects(badFolder.addMcp(entry), /ENOENT/);
  await assert.rejects(new McpManager(undefined).addConfig(entry), /cannot save/);
  await assert.rejects(new McpManager({ source: 'read-only', loadConfig: async () => ({}) }).addConfig(entry), /cannot save/);
});

test('browser and Worker additions merge config, retain headers only in memory and expose HTTP shim', async t => {
  t.mock.method(globalThis, 'fetch', fixtureFetch(new FixtureServer(), { stateless: true }));
  const storage = await BrowserStorage.open('mcp-add', new IDBFactory()); t.after(() => storage.close());
  const backend = await BrowserHarness.open({ storage, library: { agents: {}, prompts: {}, skills: {} }, seed: {} }); t.after(() => backend.close());
  await backend.configureMcp({ mcpServers: { keep: { disabled: true } } });
  const messages: RpcMessage[] = [];
  const host = new WorkerHost(async () => backend, message => messages.push(message));
  await host.handle({ id: 'add', action: 'addMcp', payload: entry });
  assert.equal(messages[0]!.type, 'result');
  assert.deepEqual(await storage.get('settings', 'mcp-config'), { mcpServers: { keep: { disabled: true }, added: { url: 'http://remote.test/mcp' } } });
  assert.equal((backend.mcpStatus().servers as { status: string }[])[1]!.status, 'connected');
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const saving = t.mock.method(storage, 'put', async () => { await waiting; throw new Error('storage unavailable'); });
  const pending = backend.addMcp({ mcpServers: { third: { disabled: true } } });
  await assert.rejects(backend.addMcp({ mcpServers: { fourth: { disabled: true } } }), /running turn/);
  release(); await assert.rejects(pending, /storage unavailable/);
  saving.mock.restore();
  assert.equal((await backend.addMcp({ mcpServers: { third: { disabled: true } } })).supported, true);
  const shim = browserFetch({ call: async (action: string, payload: unknown) => { assert.equal(action, 'addMcp'); assert.deepEqual(payload, entry); return {}; } } as unknown as WorkerClient);
  assert.equal((await shim('/mcp/add', { method: 'POST', body: JSON.stringify(entry) })).status, 200);
});

test('Node HTTP exposes explicit MCP config additions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-add-http-')); t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', fixtureFetch(new FixtureServer(), { stateless: true }));
  const backend = new NodeHarness({ workspace: root, model: 'scripted', contextLength: 4000, ollama: model, mcpConfigFile: path.join(root, 'mcp.json') }); t.after(() => backend.close());
  const server = createHarnessServer(backend); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const result = await new Promise<{ status: number; value: { servers: unknown[] } }>((resolve, reject) => {
    const outgoing = request(`http://127.0.0.1:${address.port}/mcp/add`, { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let body = ''; response.on('data', chunk => { body += String(chunk); }); response.on('end', () => resolve({ status: response.statusCode!, value: JSON.parse(body) }));
    }); outgoing.on('error', reject); outgoing.end(JSON.stringify(entry));
  });
  assert.equal(result.status, 200); assert.equal(result.value.servers.length, 1);
});

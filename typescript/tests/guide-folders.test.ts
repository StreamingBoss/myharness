import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeBridge, createBridgeServer } from '../src/node/bridge.js';
import { BridgeClient, BridgeWorkspace } from '../src/browser/bridge.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { WorkerHost } from '../src/browser/worker-host.js';
import { browserFetch } from '../src/browser/fetch.js';
import type { RpcMessage } from '../src/browser/worker-host.js';

async function setup(t: { after(fn: () => unknown): void }, commands = true) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'bridge-folders-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const first = path.join(scratch, 'first'), second = path.join(scratch, 'second');
  for (const folder of [first, second]) {
    await mkdir(folder); await writeFile(path.join(folder, 'AGENTS.md'), 'Rules for ' + path.basename(folder));
    await writeFile(path.join(folder, 'same.txt'), path.basename(folder));
  }
  assert.equal(spawnSync('git', ['init', '-q', second]).status, 0);
  spawnSync('git', ['-C', second, 'config', 'user.email', 'test@example.test']);
  spawnSync('git', ['-C', second, 'config', 'user.name', 'Test']);
  const bridge = new NativeBridge({ workspace: first, origin: 'https://guide.test', grants: { writes: true, commands, gitWrites: true } });
  const server = createBridgeServer(bridge); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { bridge.close(); server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const realFetch = fetch;
  const fetch_ = (url: string, init: RequestInit) => realFetch(url, { ...init, headers: { ...init.headers, origin: bridge.origin } });
  return { scratch, first, second, bridge, endpoint, fetch_ };
}

test('native selection scopes files, commands and Git to explicitly chosen repositories', async t => {
  const { first, second, scratch, bridge, endpoint, fetch_ } = await setup(t);
  const client = new BridgeClient(endpoint, fetch_); await client.pair(bridge.code);
  const original = new BridgeWorkspace(client);
  assert.equal(client.snapshot().workspace, first);
  assert.throws(() => client.snapshot(second), /Select/);
  await assert.rejects(client.call('read', { workspace: second, path: 'same.txt' }), /denied/);
  for (const folder of ['relative', path.join(scratch, 'missing'), path.join(first, 'same.txt')]) await assert.rejects(client.selectProject(folder), /denied/);
  assert.equal((await client.call<{ path: string }>('browse', { path: '' })).path, first);
  assert.deepEqual((await client.call<{ folders: string[] }>('browse', { path: scratch })).folders, ['first', 'second']);
  assert.equal((await client.call<{ parent: string | null }>('browse', { path: '/' })).parent, null);
  const snapshot = await client.selectProject(second); assert.equal(snapshot.project.root, second); assert.equal(snapshot.git, true);
  const selected = new BridgeWorkspace(client, second);
  assert.equal(await original.readText('same.txt'), 'first'); assert.equal(await selected.readText('same.txt'), 'second');
  assert.equal((await client.call<{ output: string }>('command', { workspace: second, command: 'pwd' })).output.trim(), second);
  await selected.writeText('new.txt', 'created in second'); await selected.readText('new.txt');
  await selected.move('new.txt', 'renamed.txt'); await selected.readText('renamed.txt'); await selected.remove('renamed.txt');
  assert.match(await selected.listFiles(), /same.txt/); assert.match(await selected.readNumbered('same.txt'), /second/);
  assert.match(await selected.findFiles('same.txt'), /same.txt/); assert.match(await selected.search('second'), /same.txt/);
  const git = client.git(undefined, second);
  assert.ok((await git.status()).entries.length); await git.diff({}); await git.log({ limit: 2 }); await git.branches();
  await git.commit('initial', ['same.txt']); await git.createBranch('other'); await git.checkout('other');
  assert.equal((await git.branches()).current, 'other');
  assert.equal(await original.readText('same.txt'), 'first'); await client.close();
});

test('headless harness switches native repos, preserves approval policy and restores the browser on unpair', async t => {
  const { first, second, bridge, endpoint, fetch_ } = await setup(t);
  t.mock.method(globalThis, 'fetch', fetch_);
  const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library: { agents: {}, skills: {}, prompts: {} }, seed: {}, model: 'scripted-demo' });
  t.after(() => harness.close());
  await assert.rejects(harness.selectBridgeProject(second), /Pair a bridge/);
  await assert.rejects(harness.browseProject(second, true), /Pair a bridge/);
  await harness.attachBridge(endpoint, bridge.code);
  await assert.rejects(harness.selectBridgeProject(path.join(second, 'missing')), /does not exist or could not be opened/);
  assert.equal((await harness.browseProject('/bridge-workspace')).path, first);
  assert.equal((await harness.browseProject('/workspace', true)).path, first);
  await harness.setProject(second);
  const state = await harness.bootstrap(); assert.equal(state.project, second);
  assert.equal((state.tools as { name: string }[]).some(tool => tool.name === 'run_command'), true);
  assert.match(JSON.stringify(await harness.explore({ useMemory: true, tools: [], agent: '', prompt: '' })), /Rules for second/);
  const run = async (command: string, approve: boolean) => {
    let output = '';
    for await (const event of harness.submit({ message: 'Run ' + command, useMemory: true, tools: ['run_command'], askApproval: true, agent: '', prompt: '' })) {
      if (event.type === 'approval') {
        await assert.rejects(harness.selectBridgeProject(first), /running turn/);
        harness.approve(String(event.id), approve);
      }
      if (event.type === 'command') output = String(event.output);
    }
    return output;
  };
  await run('touch denied.txt', false); await assert.rejects(readFile(path.join(second, 'denied.txt')));
  assert.equal((await run('pwd', true)).trim(), second);
  await run('printf from-command > approved.txt', true);
  assert.equal(await readFile(path.join(second, 'approved.txt'), 'utf8'), 'from-command');
  await assert.rejects(readFile(path.join(first, 'approved.txt')));
  const export_ = await harness.exportProject(); assert.equal(export_.files['same.txt'], 'second');
  await harness.setProject('/bridge-workspace'); assert.equal((await run('pwd', true)).trim(), first);
  await harness.setProject(second); assert.equal((await run('pwd', true)).trim(), second);
  const messages: RpcMessage[] = [], host = new WorkerHost(async () => harness, message => messages.push(message));
  await host.handle({ id: 'browse', action: 'browse', payload: { path: first, bridge: true } }); assert.equal(messages.at(-1)!.type, 'result');
  await host.handle({ id: 'project', action: 'project', payload: { path: first, bridge: true } }); assert.equal(harness.state.workspace, first);
  let payload: unknown;
  await browserFetch({ call: async (_action: string, value: unknown) => { payload = value; return {}; } } as unknown as import('../src/browser/client.js').WorkerClient)('/browse?path=%2Ftmp&bridge=1');
  assert.deepEqual(payload, { path: '/tmp', bridge: true });
  await harness.detachBridge(); assert.equal(harness.state.workspace, '/workspace');
  assert.equal(((await harness.bootstrap()).tools as { name: string }[]).some(tool => tool.name === 'run_command'), false);
});

test('selecting another repository never grants commands and cancelled selections cannot restore bridge access', async t => {
  const { second, bridge, endpoint, fetch_ } = await setup(t, false);
  t.mock.method(globalThis, 'fetch', fetch_);
  const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library: { agents: {}, skills: {}, prompts: {} }, seed: {}, model: 'scripted-demo' });
  t.after(() => harness.close()); await harness.attachBridge(endpoint, bridge.code);
  await harness.selectBridgeProject(second);
  assert.equal(((await harness.bootstrap()).tools as { name: string }[]).some(tool => tool.name === 'run_command'), false);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = BridgeClient.prototype.selectProject;
  t.mock.method(BridgeClient.prototype, 'selectProject', async function (this: BridgeClient, folder: string) {
    const snapshot = await original.call(this, folder); entered(); await new Promise<void>(resolve => { finish = resolve; }); return snapshot;
  });
  const pending = harness.selectBridgeProject(second), cancelled = assert.rejects(pending, /cancelled/);
  await started; await harness.detachBridge(); finish(); await cancelled;
  assert.equal(harness.state.workspace, '/workspace');
});

test('credential locking prevents a delayed native folder response from changing the active workspace', async t => {
  const { second, bridge, endpoint, fetch_ } = await setup(t);
  t.mock.method(globalThis, 'fetch', fetch_);
  const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library: { agents: {}, skills: {}, prompts: {} }, seed: {}, model: 'scripted-demo' });
  t.after(() => harness.close()); await harness.attachBridge(endpoint, bridge.code);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = BridgeClient.prototype.selectProject;
  t.mock.method(BridgeClient.prototype, 'selectProject', async function (this: BridgeClient, folder: string) {
    const snapshot = await original.call(this, folder); entered(); await new Promise<void>(resolve => { finish = resolve; }); return snapshot;
  });
  const selection = harness.selectBridgeProject(second), cancelled = assert.rejects(selection, /cancelled/);
  await started; await harness.lockCredentials(); finish(); await cancelled;
  assert.equal(harness.state.workspace, '/bridge-workspace'); assert.deepEqual(harness.bridgeStatus(), { connected: false });
});

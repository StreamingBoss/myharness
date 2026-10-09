import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { NativeBridge, createBridgeServer } from '../src/node/bridge.js';
import { BridgeClient, BridgeWorkspace } from '../src/browser/bridge.js';
import { BridgeError, object, text } from '../src/bridge/protocol.js';
import { bridgeMain } from '../src/node/bridge-cli.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { DemoModel } from '../src/browser/demo.js';
import { BrowserCatalog } from '../src/browser/catalog.js';
import { BrowserWorkspace } from '../src/browser/workspace.js';
import type { ModelRequest } from '../src/core.js';

const grants = { writes: true, commands: true, gitWrites: true };
async function setup(t: { after(fn: () => unknown): void }, git = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-bridge-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n'); await writeFile(path.join(root, 'AGENTS.md'), 'Local project rules');
  await mkdir(path.join(root, 'sub')); await writeFile(path.join(root, 'sub', 'b.txt'), 'needle');
  await symlink('/etc', path.join(root, 'escape')); await symlink('/missing-bridge-target', path.join(root, 'dangling'));
  if (git) { spawnSync('git', ['init', '-q', root]); spawnSync('git', ['-C', root, 'config', 'user.email', 'test@example.test']); spawnSync('git', ['-C', root, 'config', 'user.name', 'Test']); }
  const bridge = new NativeBridge({ workspace: root, origin: 'https://harness.test', grants });
  const server = createBridgeServer(bridge); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { bridge.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new BridgeClient(base, (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: bridge.origin } }));
  await client.pair(bridge.code); return { root, bridge, server, base, client };
}

test('native workspace reaches real files and Git with stale-effect and symlink protection', async t => {
  const { root, bridge, client } = await setup(t);
  const workspace = new BridgeWorkspace(client); await workspace.refresh();
  assert.equal(workspace.exists('a.txt'), true); assert.equal(workspace.isDirectory('sub'), true);
  assert.match(await workspace.listFiles(), /a.txt/); assert.match(await workspace.listFiles('sub'), /b.txt/);
  assert.match(await workspace.readNumbered('a.txt'), /one/); assert.match(await workspace.readNumbered('a.txt', 2, 2), /two/);
  assert.match(await workspace.findFiles('*.txt'), /a.txt/); assert.match(await workspace.search('needle'), /b.txt/); assert.match(await workspace.search('needle', 'sub', '*.txt'), /b.txt/);
  assert.equal(await workspace.readText('a.txt'), 'one\ntwo\n');
  const proposal = await workspace.edit('a.txt', 'one', 'ONE');
  await workspace.writeText(proposal.path, proposal.content); assert.match(await readFile(path.join(root, 'a.txt'), 'utf8'), /ONE/);
  await workspace.writeText('new.txt', 'new');
  await workspace.readText('new.txt'); await workspace.move('new.txt', 'nested/new.txt');
  await workspace.readText('nested/new.txt'); await workspace.remove('nested/new.txt');
  await workspace.readText('a.txt'); await writeFile(path.join(root, 'a.txt'), 'external'); await assert.rejects(workspace.writeText('a.txt', 'stale'), /denied/);
  await assert.rejects(client.call('write', { path: 'a.txt', content: 'missing expected' }), /denied/);
  await assert.rejects(client.call('read', { path: 'escape/passwd' })); await assert.rejects(client.call('read', { path: 'dangling' }));
  const git = client.git(); assert.equal((await git.status()).entries.length > 0, true); assert.equal((await git.log({ limit: 10 })).length, 0);
  await git.commit('initial', ['a.txt', 'AGENTS.md']); assert.equal((await git.log({ limit: 1, path: 'a.txt' })).length, 1);
  assert.match(await git.commit('add subfolder'), /add subfolder/);
  await writeFile(path.join(root, 'a.txt'), 'diff'); assert.match(await git.diff({ paths: ['a.txt'], staged: false }), /diff/);
  await git.diff({}); await git.branches(); await git.createBranch('experiment'); await git.checkout('experiment'); assert.equal((await git.branches()).current, 'experiment');
  await assert.rejects(client.call('unknown'));
  assert.match((await client.call<{ output: string }>('command', { command: 'printf SCRIPT_OK' })).output, /SCRIPT_OK/);
  await client.heartbeat(); await client.close(); await client.close();
  assert.throws(() => workspace.exists('a.txt'), /disconnected/); assert.throws(() => workspace.isDirectory('sub'), /disconnected/); await assert.rejects(client.call('snapshot'));
  assert.throws(() => new BridgeClient('https://other.test'), /loopback/);
  assert.throws(() => object([]), /object/); assert.throws(() => text({}, 'path'), /string/); assert.equal(new BridgeError('a').status, 400);
  bridge.close();
});

test('bridge policy, pairing, lease, request IDs and HTTP origin checks fail closed', async t => {
  const { root, base } = await setup(t, false);
  let now = 0;
  const bridge = new NativeBridge({ workspace: root, origin: 'https://harness.test', grants: { writes: false, commands: false, gitWrites: false }, now: () => now });
  assert.throws(() => new NativeBridge({ workspace: root, origin: 'https://harness.test/path', grants }));
  assert.throws(() => new NativeBridge({ workspace: path.join(root, 'missing'), origin: bridge.origin, grants }));
  assert.throws(() => bridge.pair('bad'));
  const { token } = bridge.pair(bridge.code); assert.throws(() => bridge.pair(bridge.code));
  const call = (operation: string, args = {}) => bridge.call(token, { id: crypto.randomUUID(), operation, args });
  await assert.rejects(call('write'), /not granted/); await assert.rejects(call('command'), /not granted/); await assert.rejects(call('git_commit'), /not granted/);
  await assert.rejects(call('unknown'), /Unknown/); await assert.rejects(call('read', { path: '/etc/passwd' }));
  await assert.rejects(bridge.call(token, { id: '', operation: 'read', args: {} }), /unique/);
  await call('cancel', { id: 'nonexistent' }); now = 1000; await call('heartbeat'); now = 120999; await call('snapshot'); now = 121000; await assert.rejects(call('snapshot'), /unavailable/); bridge.release('missing'); bridge.close();
  const expired = new NativeBridge({ workspace: root, origin: bridge.origin, grants, now: () => now }); now += 300001; assert.throws(() => expired.pair(expired.code));
  assert.equal((await fetch(base + '/v1/pair', { method: 'POST' })).status, 403);
  assert.equal(await new Promise<number>(resolve => { const request = httpRequest(base + '/v1/pair', { method: 'POST', headers: { origin: bridge.origin, host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode!); }); request.end(); }), 403);
  assert.equal((await fetch(base + '/v1/call', { method: 'OPTIONS', headers: { origin: bridge.origin } })).status, 204);
  assert.equal((await fetch(base + '/no', { headers: { origin: bridge.origin } })).status, 404);
  assert.equal((await fetch(base + '/v1/call', { method: 'POST', headers: { origin: bridge.origin }, body: 'invalid' })).status, 400);
  assert.equal((await fetch(base + '/v1/call', { method: 'POST', headers: { origin: bridge.origin }, body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/v1/call', { method: 'POST', headers: { origin: bridge.origin }, body: 'x'.repeat(13 * 1024 * 1024) })).status, 413);
});

test('Stop cancels native process groups and queued effects never start after cancellation', async t => {
  const { bridge, client } = await setup(t);
  const controller = new AbortController();
  const running = client.call('command', { command: 'sleep 30 & wait' }, controller.signal); const denied = assert.rejects(running, /cancelled|unavailable/);
  await new Promise(resolve => setTimeout(resolve, 40)); controller.abort(); await denied;
  const service = new NativeBridge({ workspace: bridge.workspace.root, origin: bridge.origin, grants });
  const { token } = service.pair(service.code);
  const first = service.call(token, { id: 'running', operation: 'command', args: { command: 'sleep 30' } });
  await assert.rejects(service.call(token, { id: 'running', operation: 'snapshot', args: {} }), /unique/);
  const queued = service.call(token, { id: 'queued', operation: 'write', args: { path: 'cancelled.txt', content: 'no', expected: null } });
  const cancelled = assert.rejects(queued, /cancelled/);
  await service.call(token, { id: 'cancel1', operation: 'cancel', args: { id: 'queued' } });
  await service.call(token, { id: 'cancel2', operation: 'cancel', args: { id: 'running' } });
  await first; await cancelled; service.close();
  await assert.rejects(readFile(path.join(bridge.workspace.root, 'cancelled.txt')));
});

test('browser backend uses the native runtime with approvals without any UI', async t => {
  const { root, bridge, client } = await setup(t);
  const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library: { agents: {}, prompts: {}, skills: {} }, seed: {}, model: 'scripted-demo', modelPort: new DemoModel(), runtime: {
    workspace: () => new BridgeWorkspace(client), catalog: () => ({ agents: () => ({}), skills: () => ({}), prompts: () => ({}), projectInstructions: () => ['AGENTS.md', 'Local project rules'] }),
    supportedTools: ['read_file', 'write_file', 'run_command'], executeCommand: (command, _root, signal) => client.call('command', { command }, signal), git: () => client.git(),
  } });
  const action = { message: 'Write approved.txt: hello', useMemory: true, tools: ['write_file'], askApproval: true, agent: '', prompt: '' };
  for await (const event of harness.submit(action)) if (event.type === 'approval') harness.approve(String(event.id), false);
  await assert.rejects(readFile(path.join(root, 'approved.txt')));
  for await (const event of harness.submit(action)) if (event.type === 'approval') harness.approve(String(event.id), true);
  assert.equal(await readFile(path.join(root, 'approved.txt'), 'utf8'), 'hello\n');
  let result = '';
  for await (const event of harness.submit({ ...action, message: 'Run printf APPROVED', tools: ['run_command'] })) { if (event.type === 'approval') harness.approve(String(event.id), true); if (event.type === 'command') result = String(event.output); }
  assert.match(result, /APPROVED/);
  await harness.lockCredentials(); await harness.close(); bridge.close();
});

test('bridge CLI validates options and starts an independent paired host', async t => {
  const { root, server: occupied } = await setup(t);
  const output: string[] = []; assert.equal(await bridgeMain(['--help'], line => output.push(line)), undefined);
  await assert.rejects(bridgeMain([], () => undefined), /required/); await assert.rejects(bridgeMain([], () => undefined, 'win32'), /WSL/);
  await assert.rejects(bridgeMain(['--workspace', root, '--origin', 'https://harness.test', '--port', 'bad']), /port/);
  const server = await bridgeMain(['--workspace', root, '--origin', 'https://harness.test', '--port', '0', '--allow-writes', '--allow-commands', '--allow-git-writes'], line => output.push(line));
  await new Promise<void>(resolve => server!.close(() => resolve())); assert.ok(output.some(line => line.includes('pairing code')));
  const failed = spawnSync(process.execPath, ['dist/typescript/src/node/bridge-cli.js'], { encoding: 'utf8' }); assert.equal(failed.status, 1);
  const help = spawnSync(process.execPath, ['dist/typescript/src/node/bridge-cli.js', '--help'], { encoding: 'utf8' }); assert.equal(help.status, 0);
  const busy = spawnSync(process.execPath, ['dist/typescript/src/node/bridge-cli.js', '--workspace', root, '--origin', 'https://localhost', '--port', String((occupied.address() as { port: number }).port)], { encoding: 'utf8' });
  assert.equal(busy.status, 1); assert.match(busy.stderr, /port is already in use/); assert.match(busy.stderr, /--port 5002/);
  assert.doesNotMatch(busy.stderr, /pairing code/); assert.ok(occupied.listening);
});

test('transport failure, unread mutations, cancelled requests, metadata bounds and CLI process shutdown', async t => {
  const { client, root, base } = await setup(t);
  const workspace = new BridgeWorkspace(client);
  await assert.rejects(workspace.remove('a.txt')); await assert.rejects(workspace.move('a.txt', 'other.txt'));
  const limited = new NativeBridge({ workspace: root, origin: 'https://harness.test', grants, maxMetadataEntries: 1 }); await assert.rejects(limited.snapshot(), /metadata/); limited.close();
  let requests = 0;
  const failing = new BridgeClient(base, async () => { if (++requests === 1) return Response.json({ value: { token: 'fixture' } }); if (requests === 2) return Response.json({ value: await client.refresh() }); throw new Error('offline'); });
  await failing.pair('code'); const signal = new AbortController(), failure = assert.rejects(failing.call('command', {}, signal.signal)); signal.abort(); await failure; await new Promise(resolve => setImmediate(resolve)); await failing.close();
  const service = new NativeBridge({ workspace: root, origin: 'https://harness.test', grants }); const { token } = service.pair(service.code);
  await assert.rejects(service.call(token, { id: 'bad', operation: 1 as unknown as string, args: {} }), /unique/);
  service.close();
  const child = spawn(process.execPath, ['dist/typescript/src/node/bridge-cli.js', '--workspace', root, '--origin', 'https://harness.test', '--port', '0']);
  t.after(() => child.kill('SIGTERM'));
  await new Promise<void>((resolve, reject) => { child.stdout.on('data', () => resolve()); child.once('error', reject); });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve)); child.kill('SIGINT'); assert.equal(await exited, 0);
});

test('pre-aborted commands, leased process cleanup and native web search use explicit capabilities', async t => {
  const { client, root } = await setup(t); const abort = new AbortController(); abort.abort(); await assert.rejects(client.call('command', {}, abort.signal), /cancelled/);
  const service = new NativeBridge({ workspace: root, origin: 'https://harness.test', grants, fetch: async () => new Response('No results') });
  const { token } = service.pair(service.code); assert.match(await service.call(token, { id: 'search', operation: 'webSearch', args: { query: 'fixture' } }) as string, /No web results/);
  const running = service.call(token, { id: 'running', operation: 'command', args: { command: 'sleep 30' } }); await new Promise(resolve => setTimeout(resolve, 20)); service.release(token); await running;
  t.mock.method(globalThis, 'fetch', async () => new Response('No results')); const fallback = new NativeBridge({ workspace: root, origin: service.origin, grants }); const second = fallback.pair(fallback.code);
  assert.match(await fallback.call(second.token, { id: 'search', operation: 'webSearch', args: { query: 'fixture' } }) as string, /No web results/); fallback.close();
});


test('bridge project agents and skills retain instructions in the browser catalog and model context', async t => {
  const { root, client } = await setup(t, false);
  await mkdir(path.join(root, 'agents'));
  await mkdir(path.join(root, 'skills', 'review'), { recursive: true });
  const agentBody = 'Read the relevant code before answering. Project coder instructions.';
  const skillBody = 'Review each change against the project requirements.';
  await writeFile(path.join(root, 'agents', 'coder.md'), 'tools: read_file, use_skill\n---\n' + agentBody);
  await writeFile(path.join(root, 'agents', 'notes.txt'), 'Not an agent');
  await writeFile(path.join(root, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code changes\n---\n' + skillBody);
  await writeFile(path.join(root, 'skills', 'review', 'notes.md'), 'Read on demand');
  const snapshot = await client.refresh();
  assert.equal(snapshot.project.files['agents/coder.md'], 'tools: read_file, use_skill\n---\n' + agentBody);
  assert.ok(snapshot.project.files['skills/review/SKILL.md']!.includes(skillBody));
  for (const name of ['a.txt', 'agents/notes.txt', 'skills/review/notes.md']) assert.equal(snapshot.project.files[name], '');
  assert.equal(snapshot.project.files['AGENTS.md'], 'Local project rules');

  const library = { agents: { coder: 'Bundled coder fallback' }, prompts: {}, skills: {} };
  const requests: ModelRequest[] = [], model = new DemoModel();
  const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library, seed: {}, model: 'scripted-demo', modelPort: {
    async *streamChat(payload) { requests.push(payload); yield* model.streamChat(payload); },
    request: (endpoint, payload) => model.request(endpoint, payload),
  }, runtime: {
    workspace: () => new BridgeWorkspace(client),
    catalog: workspace => new BrowserCatalog(library, workspace as BrowserWorkspace),
  } });
  t.after(() => harness.close());
  const action = { useMemory: true, tools: ['read_file', 'use_skill'], agent: 'coder', prompt: '' };
  const state = await harness.explore(action);
  assert.deepEqual(state.agent, { source: 'project', tools: ['read_file', 'use_skill'], prompt: agentBody });
  assert.deepEqual(state.skills, [{ name: 'review', description: 'Review code changes', source: 'project', body: skillBody }]);
  for await (const _event of harness.submit({ ...action, message: 'Hello', askApproval: true })) { /* consume the backend turn */ }
  assert.ok(requests[0]!.messages.some(message => message.role === 'system' && message.content.includes(agentBody) && message.content.includes('review: Review code changes')));
  // Existing conversations keep frozen instructions; a new session loads the corrected catalog.
  await writeFile(path.join(root, 'agents', 'coder.md'), 'tools: read_file\n---\nUpdated project instructions');
  assert.deepEqual((await harness.explore(action)).agent, state.agent);
  await harness.newSession();
  assert.deepEqual((await harness.explore(action)).agent, { source: 'project', tools: ['read_file'], prompt: 'Updated project instructions' });
});

test('private bridge pairings survive browser suspension until explicit release', async t => {
  const { root } = await setup(t); let now = 0;
  const bridge = new NativeBridge({ workspace: root, origin: 'https://guide.test', grants, now: () => now });
  const { token } = bridge.pair(bridge.code, true);
  now = 24 * 60 * 60 * 1000; bridge.sweep();
  await bridge.call(token, { id: 'resume', operation: 'heartbeat', args: {} });
  now *= 2; bridge.sweep();
  await bridge.call(token, { id: 'read', operation: 'read', args: { path: 'a.txt' } });
  bridge.release(token); await assert.rejects(bridge.call(token, { id: 'closed', operation: 'snapshot', args: {} }), /pair again/);
  bridge.close();
});

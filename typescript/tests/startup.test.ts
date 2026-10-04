import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Server } from 'node:net';
import { loadHarness } from '../src/node/startup.js';
import { startServer } from '../src/node/server.js';

test('startup reads settings and model metadata, restores sessions, and starts an isolated server', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-start-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'workspace')); await mkdir(path.join(root, 'saved'));
  const response = () => new Response(JSON.stringify({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 4096 } }));
  t.mock.method(globalThis, 'fetch', async () => response());
  const env = { MYHARNESS_ROOT: root, MYHARNESS_PORT: '0', OLLAMA_URL: 'http://fake', MYHARNESS_MODEL: 'qwen3:8b' };
  const initial = await loadHarness(env); assert.equal(initial.state.workspace, path.join(root, 'workspace'));
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ project: path.join(root, 'saved') }));
  await rm(path.join(root, 'sessions'), { recursive: true });
  const saved = await loadHarness(env); assert.equal(saved.state.workspace, path.join(root, 'saved'));
  await rm(path.join(root, 'sessions'), { recursive: true });
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ project: path.join(root, 'gone') }));
  const missing = await loadHarness(env); assert.equal(missing.state.workspace, path.join(root, 'workspace'));
  await loadHarness({ ...env, MYHARNESS_WORKSPACE: path.join(root, 'workspace'), MYHARNESS_SETTINGS: path.join(root, 'other.json'), MYHARNESS_SESSIONS: path.join(root, 'other-sessions') });
  const old = { ...process.env };
  try {
    Object.assign(process.env, { MYHARNESS_ROOT: root, MYHARNESS_PORT: '0' });
    delete process.env.OLLAMA_URL; delete process.env.MYHARNESS_MODEL;
    await loadHarness(); const server = await startServer(); await new Promise<void>(resolve => server.close(() => resolve()));
  } finally { process.env = old; }
  const server = await startServer(env); await new Promise<void>(resolve => server.close(() => resolve()));
  const fallbackRoot = await startServer({ MYHARNESS_PORT: '0', MYHARNESS_WORKSPACE: root, MYHARNESS_SESSIONS: path.join(root, 'isolated-sessions'), MYHARNESS_SETTINGS: path.join(root, 'isolated-settings.json') });
  await new Promise<void>(resolve => fallbackRoot.close(() => resolve()));
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, 'listen', function (this: Server, port: number, host: string, callback: () => void) { assert.equal(port, 5001); return Reflect.apply(listen, this, [0, host, callback]); } as typeof listen);
  const defaultPort = await startServer({ MYHARNESS_ROOT: root }); await new Promise<void>(resolve => defaultPort.close(() => resolve()));
});

test('executable launchers handle help, successful startup and connection failure', async t => {
  const execute = (file: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; text: string }>(resolve => {
    const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env } }); let text = '';
    child.stdout.on('data', chunk => { text += String(chunk); }); child.stderr.on('data', chunk => { text += String(chunk); }); child.on('close', code => resolve({ code, text }));
  });
  const help = await execute('dist/typescript/src/node/headless.js', ['--help']); assert.equal(help.code, 0); assert.match(help.text, /Usage/);
  const failed = await execute('dist/typescript/src/node/server.js', [], { OLLAMA_URL: 'http://127.0.0.1:1' }); assert.equal(failed.code, 1); assert.match(failed.text, /Could not start/);
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const ollama = createServer((_request, response) => { response.end(JSON.stringify({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 4096 }, message: { content: 'hello' }, done: true }) + '\n'); });
  await new Promise<void>(resolve => ollama.listen(0, '127.0.0.1', resolve)); t.after(() => ollama.close());
  const address = ollama.address(); assert.ok(address && typeof address !== 'string');
  const env = { ...process.env, MYHARNESS_ROOT: root, MYHARNESS_WORKSPACE: root, MYHARNESS_PORT: '0', OLLAMA_URL: `http://127.0.0.1:${address.port}` };
  const child = spawn(process.execPath, ['dist/typescript/src/node/server.js'], { env }); t.after(() => child.kill());
  const message = await new Promise<string>(resolve => child.stdout.once('data', data => resolve(String(data))));
  assert.match(message, /TypeScript harness on http/);
  const base = message.trim().split(' ').at(-1)!;
  assert.equal((await fetch(base + '/bootstrap')).status, 200);
  child.kill('SIGINT'); await new Promise(resolve => child.once('close', resolve));
  const direct = await execute('dist/typescript/src/node/headless.js', ['hello', '--tools', 'pwd'], env); assert.equal(direct.code, 0); assert.match(direct.text, /"content":"hello"/);
});

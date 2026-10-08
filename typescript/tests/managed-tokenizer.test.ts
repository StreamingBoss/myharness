import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedTokenizer, modelFilePath } from '../src/node/managed-tokenizer.js';
import { NativeBridge, createBridgeServer } from '../src/node/bridge.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { bridgeMain } from '../src/node/bridge-cli.js';
import type { FetchLike } from '../src/ollama.js';
import type { ModelRequest } from '../src/core.js';

const model = 'qwen3:8b';
const grants = { writes: false, commands: false, gitWrites: false };
const request: ModelRequest = { model, provider: 'ollama', messages: [{ role: 'user', content: 'hello' }], stream: true, options: { num_ctx: 4096 } };
async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-tokenizer-')); t.after(() => rm(root, { recursive: true, force: true }));
  const gguf = path.join(root, 'model file.gguf'), executable = path.join(root, 'llama-server');
  await writeFile(gguf, 'GGUF fixture');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
const get = key => args[args.indexOf(key) + 1];
const file = get('-m');
fs.writeFileSync(file + '.process', JSON.stringify({pid:process.pid,args,env:process.env.LLAMA_ARG_TOOLS}));
if (fs.readFileSync(file,'utf8').includes('exit')) process.exit(1);
const server = http.createServer(async (req,res) => {
 if (req.url === '/v1/models') {res.end(JSON.stringify({data:[{id:get('--alias')}]}));return;}
 let body='';for await(const chunk of req)body+=chunk;
 res.end(JSON.stringify({tokens:[{id:42,piece:JSON.parse(body).content}]}));
});
if (!fs.readFileSync(file,'utf8').includes('stall')) server.listen(Number(get('--port')),get('--host'));
else setInterval(()=>{},1000);
`, { mode: 0o755 });
  const rawFetch = globalThis.fetch;
  let show: unknown = { modelfile: `FROM "${gguf}"\n` };
  const fetch_: FetchLike = async (url, init) => {
    if (url.endsWith('/api/show')) return Response.json(show);
    if (url.endsWith('/api/chat')) return Response.json({ _debug_info: { rendered_template: 'hello' } });
    return rawFetch(url, init);
  };
  return { root, gguf, executable, fetch_, setShow(value: unknown) { show = value; } };
}
async function pid(file: string): Promise<number> { return JSON.parse(await readFile(file + '.process', 'utf8')).pid; }
async function gone(processId: number) {
  for (let i = 0; i < 50; i++) { try { process.kill(processId, 0); } catch { return; } await delay(10); }
  assert.fail('managed child survived cleanup');
}

test('managed tokenizer discovers exact GGUF, reuses and replaces owned processes, removes inherited tool settings', async t => {
  const f = await fixture(t);
  const previous = process.env.LLAMA_ARG_TOOLS; process.env.LLAMA_ARG_TOOLS = 'all';
  t.after(() => { if (previous === undefined) delete process.env.LLAMA_ARG_TOOLS; else process.env.LLAMA_ARG_TOOLS = previous; });
  const manager = new ManagedTokenizer({ executable: f.executable }, 'http://localhost:11434', f.fetch_); t.after(() => manager.close());
  const signal = new AbortController().signal;
  const phases: string[] = [];
  const progress = (stage: string) => phases.push(stage);
  const first = await manager.binding(model, signal, progress), firstPid = await pid(f.gguf);
  assert.equal(first.alias, model); assert.match(first.identity, /Ollama-reported GGUF/);
  assert.deepEqual(await manager.binding(model, signal, progress), first); assert.equal(await pid(f.gguf), firstPid); assert.deepEqual(phases, ['locating', 'loading', 'locating', 'reusing']);
  const args = JSON.parse(await readFile(f.gguf + '.process', 'utf8')); assert.equal(args.env, undefined);
  assert.equal(args.args[args.args.indexOf('--host') + 1], '127.0.0.1');
  assert.ok(!args.args.includes('--tools')); assert.ok(!args.args.includes('--agent'));
  await manager.binding('other-exact-model', signal); const secondPid = await pid(f.gguf); assert.notEqual(firstPid, secondPid); await gone(firstPid);
  process.kill(secondPid, 'SIGKILL'); await gone(secondPid); await delay(20);
  await manager.binding('other-exact-model', signal); const thirdPid = await pid(f.gguf); assert.notEqual(secondPid, thirdPid);
  await writeFile(f.gguf, 'GGUF changed fixture');
  await manager.binding('other-exact-model', signal); const fourthPid = await pid(f.gguf); assert.notEqual(thirdPid, fourthPid); await gone(thirdPid);
  manager.close(); manager.close(); await gone(fourthPid);
  await assert.rejects(manager.binding(model, signal));
});

test('GGUF discovery fails safely for inaccessible files, incompatible metadata and remote hosts', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const make = (url = 'http://127.0.0.1:11434') => new ManagedTokenizer({}, url, f.fetch_);
  for (const show of [{}, { modelfile: 'FROM model:latest' }, { modelfile: `FROM ${f.gguf}\nADAPTER /somewhere` }, { modelfile: `FROM ${f.root}/missing` }, { modelfile: `FROM ${f.root}` }]) {
    f.setShow(show); const manager = make(); await assert.rejects(manager.binding(model, signal), /GGUF|model file/); manager.close();
  }
  f.setShow({ modelfile: `FROM ${f.gguf}` }); await writeFile(f.gguf, 'bad');
  await assert.rejects(make().binding(model, signal), /invalid/);
  await assert.rejects(make('http://remote.test:11434').binding(model, signal), /another host/);
  for (const id of ['', '-m', 'model\n--tools']) await assert.rejects(make().binding(id, signal), /valid exact Ollama model ID/);
  const failed = new ManagedTokenizer({}, 'http://[::1]:11434', async () => { throw new Error('SECRET'); });
  await assert.rejects(failed.binding(model, signal), /Check OLLAMA_URL/);
  const badStatus = new ManagedTokenizer({}, 'http://localhost:11434', async () => new Response('', { status: 404 }));
  await assert.rejects(badStatus.binding(model, signal), /Check OLLAMA_URL/);
  for (const models of [null, [], 'bad', { q: 3 }, { q: 'relative' }]) assert.throws(() => new ManagedTokenizer({ models: models as Record<string, string> }, 'http://localhost', f.fetch_), /absolute GGUF/);
});

test('explicit operator GGUF supports remote Ollama and startup errors are actionable', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const configured = new ManagedTokenizer({ executable: f.executable, models: { [model]: f.gguf } }, 'http://remote.test', f.fetch_); t.after(() => configured.close());
  assert.match((await configured.binding(model, signal)).identity, /operator-configured/); configured.close(); await gone(await pid(f.gguf));
  const missing = new ManagedTokenizer({ executable: path.join(f.root, 'missing'), models: { [model]: f.gguf } }, 'http://remote.test', f.fetch_);
  await assert.rejects(missing.binding(model, signal), /Install llama.cpp/); missing.close();
  const nonexecutable = path.join(f.root, 'not-executable'); await writeFile(nonexecutable, 'bad');
  const denied = new ManagedTokenizer({ executable: nonexecutable, models: { [model]: f.gguf } }, 'http://remote.test', f.fetch_);
  await assert.rejects(denied.binding(model, signal), /executable permissions/); denied.close();
  await writeFile(f.gguf, 'GGUF exit');
  const exits = new ManagedTokenizer({ executable: f.executable }, 'http://localhost:11434', f.fetch_);
  await assert.rejects(exits.binding(model, signal), /exited/); exits.close();
  await writeFile(f.gguf, 'GGUF stall');
  const stalled = new ManagedTokenizer({ executable: f.executable, startupTimeoutMs: 350 }, 'http://localhost:11434', f.fetch_);
  await assert.rejects(stalled.binding(model, signal), /did not become ready/); await gone(await pid(f.gguf)); stalled.close();
});

test('startup cancellation and shutdown kill only the owned process; wrong readiness aliases never succeed', async t => {
  const f = await fixture(t); await writeFile(f.gguf, 'GGUF stall');
  for (const shutdown of [false, true]) {
    const controller = new AbortController();
    const manager = new ManagedTokenizer({ executable: f.executable }, 'http://localhost:11434', f.fetch_);
    const pending = manager.binding(model, controller.signal); const rejection = assert.rejects(pending, /cancelled/);
    let processId: number | undefined;
    for (let i = 0; i < 100; i++) { try { processId = await pid(f.gguf); break; } catch { await delay(10); } }
    assert.ok(processId); if (shutdown) manager.close(); else controller.abort(); await rejection; manager.close(); await gone(processId);
    await rm(f.gguf + '.process');
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new ManagedTokenizer({}, 'http://localhost', f.fetch_).binding(model, controller.signal));
  const wrong: FetchLike = async (url, init) => url.endsWith('/api/show') ? f.fetch_(url, init) : Response.json({ data: [{ id: 'wrong' }] });
  const manager = new ManagedTokenizer({ executable: f.executable, startupTimeoutMs: 200 }, 'http://localhost:11434', wrong);
  await assert.rejects(manager.binding(model, new AbortController().signal), /did not become ready/); manager.close();
});

test('browser requests automatic inspection through a real bridge without Bash grants; unpair stops the child', async t => {
  const f = await fixture(t), rawFetch = globalThis.fetch;
  const service = new NativeBridge({ workspace: f.root, origin: 'https://guide.test', grants, managedTokenizer: { executable: f.executable }, inspectionFetch: f.fetch_ });
  const server = createBridgeServer(service); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith(base), 'browser must only contact bridge during inspection');
    return rawFetch(url, { ...init, headers: { ...init.headers, origin: service.origin } });
  });
  const harness = await BrowserHarness.open({ storage: new MemoryStorage(), library: { agents: {}, skills: {}, prompts: {} }, seed: {}, model }); t.after(() => harness.close());
  await harness.attachBridge(base, service.code);
  const record = harness.activeSessionRecord(); record.events.push({ type: 'request', provider: 'ollama', model_request: request });
  const copy = await harness.importSession(record); await harness.activateSession(copy.id);
  const result = await harness.tokenize(record.events.length - 1);
  assert.equal(result.fidelity, 'configured-tokenizer'); assert.equal(result.groups[0]!.tokens[0]!.id, '42');
  assert.ok(!(await harness.bootstrap()).tools || !JSON.stringify((await harness.bootstrap()).tools).includes('run_command'));
  const processId = await pid(f.gguf); await harness.detachBridge(); await gone(processId);
});

test('CLI startup grant enables automatic inspection; setup failure returns safe unavailable evidence', async t => {
  const f = await fixture(t);
  const args = ['--workspace', f.root, '--origin', 'https://guide.test', '--port', '0', '--allow-tokenizer'];
  await assert.rejects(bridgeMain(args, () => undefined, 'linux', { MYHARNESS_TOKENIZER_MODELS: 'null' }), /absolute GGUF/);
  const server = await bridgeMain(args, () => undefined, 'linux', { MYHARNESS_LLAMA_SERVER: f.executable, MYHARNESS_TOKENIZER_MODELS: '{}' });
  await new Promise<void>(resolve => server!.close(() => resolve()));
  const service = new NativeBridge({ workspace: f.root, origin: 'https://guide.test', grants, managedTokenizer: {}, inspectionFetch: f.fetch_ });
  const { token } = service.pair(service.code);
  f.setShow({});
  const result = await service.call(token, { id: 'inspect', operation: 'inspectTokens', args: { payload: request, ollamaUrl: 'http://localhost:11434' } }) as { fidelity: string; explanation: string };
  assert.equal(result.fidelity, 'unavailable'); assert.match(result.explanation, /usable model file/);
  service.close();
});

test('manual bindings take precedence; aborted discovery cannot launch a process', async t => {
  const f = await fixture(t);
  const manual = new NativeBridge({ workspace: f.root, origin: 'https://guide.test', grants, managedTokenizer: { executable: '/missing' },
    tokenizers: { [model]: { url: 'http://configured.test', alias: model, identity: 'operator verified' } },
    inspectionFetch: async url => Response.json(url.endsWith('/api/chat') ? { _debug_info: { rendered_template: 'hello' } } : url.endsWith('/v1/models') ? { data: [{ id: model }] } : { tokens: [{ id: 1, piece: 'hello' }] }) });
  const paired = manual.pair(manual.code);
  const result = await manual.call(paired.token, { id: 'manual', operation: 'inspectTokens', args: { payload: request, ollamaUrl: 'http://localhost:11434' } }) as { fidelity: string };
  assert.equal(result.fidelity, 'configured-tokenizer'); await assert.rejects(readFile(f.gguf + '.process')); manual.close();
  let token = '';
  const cancelled = new NativeBridge({ workspace: f.root, origin: 'https://guide.test', grants, managedTokenizer: { executable: f.executable }, inspectionFetch: async () => {
    await cancelled.call(token, { id: 'stop', operation: 'cancel', args: { id: 'discovery' } });
    return Response.json({ modelfile: `FROM ${f.gguf}` });
  } });
  token = cancelled.pair(cancelled.code).token;
  await assert.rejects(cancelled.call(token, { id: 'discovery', operation: 'inspectTokens', args: { payload: request, ollamaUrl: 'http://localhost:11434' } }));
  await assert.rejects(readFile(f.gguf + '.process')); cancelled.close();
});

test('readiness requires a successful matching catalog; default executable lookup has useful errors', async t => {
  const f = await fixture(t);
  for (const response of [new Response('{}', { status: 503 }), Response.json({}), Response.json({ data: [] }), Response.json({ data: [{ id: model }] }, { status: 503 })]) {
    const manager = new ManagedTokenizer({ executable: f.executable, startupTimeoutMs: 150 }, 'http://localhost:11434', async (url, init) => url.endsWith('/api/show') ? f.fetch_(url, init) : response.clone());
    await assert.rejects(manager.binding(model, new AbortController().signal), /did not become ready/); manager.close();
  }
  const previous = process.env.PATH; process.env.PATH = '/missing-managed-tokenizer-path';
  try {
    const manager = new ManagedTokenizer({}, 'http://localhost:11434', f.fetch_);
    await assert.rejects(manager.binding(model, new AbortController().signal), /Install llama.cpp/); manager.close();
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  const args = ['--workspace', f.root, '--origin', 'https://guide.test', '--port', '0', '--allow-tokenizer'];
  const server = await bridgeMain(args, () => undefined, 'linux', {});
  await new Promise<void>(resolve => server!.close(() => resolve()));
});

test('Windows Ollama drive paths resolve through WSL mounts without changing native or relative paths', async t => {
  assert.equal(modelFilePath('D:\\Users\\emman\\.ollama\\models\\blobs\\sha256-model'), '/mnt/d/Users/emman/.ollama/models/blobs/sha256-model');
  assert.equal(modelFilePath('C:/Users/Some Name/model.gguf'), '/mnt/c/Users/Some Name/model.gguf');
  assert.equal(modelFilePath('/native/model.gguf'), '/native/model.gguf');
  assert.equal(modelFilePath('model:latest'), 'model:latest');
  assert.equal(modelFilePath('D:relative'), 'D:relative');
  assert.equal(modelFilePath(String.raw`\\server\share\model.gguf`), String.raw`\\server\share\model.gguf`);
  const f = await fixture(t), mounted = path.join(f.root, 'd', 'Users', 'Some Name', 'model.gguf');
  await mkdir(path.dirname(mounted), { recursive: true }); await writeFile(mounted, 'GGUF fixture');
  f.setShow({ modelfile: 'FROM "D:\\Users\\Some Name\\model.gguf"' });
  const manager = new ManagedTokenizer({ executable: f.executable, windowsMountRoot: f.root }, 'http://localhost:11434', f.fetch_);
  t.after(() => manager.close());
  const binding = await manager.binding(model, new AbortController().signal);
  assert.equal(binding.identity, 'Ollama-reported GGUF model.gguf');
  const launched = JSON.parse(await readFile(mounted + '.process', 'utf8'));
  assert.equal(launched.args[launched.args.indexOf('-m') + 1], mounted);
  manager.close(); await gone(launched.pid);
});

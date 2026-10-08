import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { IDBFactory } from 'fake-indexeddb';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';
import { loadHarness } from '../src/node/startup.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { BrowserStorage } from '../src/browser/storage.js';
import { WorkerHost, type RpcMessage } from '../src/browser/worker-host.js';
import { browserFetch } from '../src/browser/fetch.js';
import type { WorkerClient } from '../src/browser/client.js';
import type { CoreEvent, ModelRequest } from '../src/core.js';
import { ECHO, FixtureServer, PROMPT, RESOURCE, STDIO_SERVER, fixtureFetch } from './mcp-fixture.js';

/** Replies with scripted Ollama chunks and records every request the harness sends. */
class ScriptedModel {
  readonly payloads: ModelRequest[] = [];
  constructor(private readonly turns: unknown[][]) {}
  async *streamChat(payload: ModelRequest): AsyncGenerator<string> {
    this.payloads.push(structuredClone(payload));
    for (const chunk of this.turns.shift() ?? [{ message: { content: 'done' }, done: true }]) yield JSON.stringify(chunk);
  }
  async request(): Promise<Record<string, unknown>> { return { template: '{{ .Prompt }}', parameters: '' }; }
}
const callTool = (name: string, args: Record<string, unknown>) => [{ message: { tool_calls: [{ function: { name, arguments: args } }] }, done: true }];
const done = [{ message: { content: 'done' }, done: true }];
const turn = (message: string, tools: string[], askApproval = true) => ({ message, useMemory: true, tools, askApproval, agent: '', prompt: '' });
async function run(harness: NodeHarness | BrowserHarness, action: ReturnType<typeof turn>, answer?: boolean | 'stop'): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of harness.submit(action)) {
    events.push(event);
    if (event.type === 'approval' && answer !== undefined) { if (answer === 'stop') harness.stop(); else harness.approve(String(event.id), answer); }
  }
  return events;
}

async function nodeFixture(t: { after(callback: () => unknown): void }, model: ScriptedModel, fixture: Record<string, unknown> = {}, options: { approvalTimeoutMs?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-harness-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [STDIO_SERVER], env: { MCP_FIXTURE: JSON.stringify({ instructions: 'Use echo to repeat text.', resources: [RESOURCE], prompts: [PROMPT], ...fixture }) } } } }));
  const harness = new NodeHarness({ workspace: root, model: 'scripted', contextLength: 20000, ollama: model, mcpConfigFile: config, sessions: new SessionStore(path.join(root, 'sessions')), projectRoot: root, ...options });
  await harness.initialize(); t.after(() => harness.close());
  return { harness, root, config };
}

test('bundled Exa config discovers search and enforces headless approval and cancellation', async t => {
  const config = path.resolve('mcp.json');
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), {
    mcpServers: { exa: { url: 'https://mcp.exa.ai/mcp?tools=web_search_exa' } },
  });
  const server = new FixtureServer({ era: 'legacy', legacyVersion: '2025-11-25', tools: [{
    name: 'web_search_exa', description: 'Search the web',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    annotations: { readOnlyHint: true },
  }], call: (_name, args) => ({ content: [{ type: 'text', text: `Search results for ${String(args.query)}: https://example.org` }] }) });
  const fetch_ = fixtureFetch(server, { sse: true });
  let hanging = false, aborted = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: Parameters<typeof fetch_>[1]) => {
    assert.equal(url, 'https://mcp.exa.ai/mcp?tools=web_search_exa');
    assert.equal(init.headers['x-api-key'], undefined);
    assert.equal(init.headers.Authorization, undefined);
    if (hanging && init.body && JSON.parse(init.body).method === 'tools/call') {
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason); }, { once: true });
        setTimeout(() => harness.stop(), 10);
      });
    }
    return fetch_(url, init);
  });
  const root = await mkdtemp(path.join(tmpdir(), 'exa-harness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = 'mcp__exa__web_search_exa';
  const search = () => callTool(name, { query: 'TypeScript docs' });
  const model = new ScriptedModel([search(), done, search(), done, search(), done, search(), search()]);
  const harness = new NodeHarness({ workspace: root, model: 'scripted', contextLength: 20000, ollama: model, mcpConfigFile: config, approvalTimeoutMs: 20 });
  t.after(() => harness.close());
  await harness.initialize();
  assert.ok(((await harness.bootstrap()).tools as { name: string }[]).some(tool => tool.name === name));
  const calls = () => server.log.filter(message => 'method' in message && message.method === 'tools/call');
  const approved = await run(harness, turn('search', [name]), true);
  assert.equal(approved.find(event => event.type === 'mcp')!.outcome, 'allowed-once');
  assert.match(String(approved.find(event => event.type === 'tool')!.result), /Search results for TypeScript docs/);
  assert.equal(calls().length, 1);
  for (const [answer, outcome] of [[false, 'rejected'], [undefined, 'unavailable'], ['stop', 'cancelled']] as const) {
    const events = await run(harness, turn('search', [name]), answer);
    assert.equal(events.find(event => event.type === 'mcp')!.outcome, outcome);
    assert.equal(calls().length, 1);
  }
  hanging = true;
  const stopped = await run(harness, turn('search', [name]), true);
  assert.equal(aborted, true);
  assert.equal(stopped.at(-1)!.type, 'stopped');
});

test('Node: an MCP tool call is described, approved, executed over stdio and shown as events', async t => {
  const model = new ScriptedModel([callTool('mcp__files__echo', { text: 'hello' }), done, callTool('mcp__files__echo', { text: 'again' }), done]);
  const { harness } = await nodeFixture(t, model);
  const boot = await harness.bootstrap();
  const tool = (boot.tools as Record<string, unknown>[]).find(item => item.name === 'mcp__files__echo')!;
  assert.deepEqual(tool, { name: 'mcp__files__echo', description: '[MCP server files] Echo the text back', supported: true, source: 'mcp', server: 'files', tokens: 55, tokens_estimated: true });
  const status = boot.mcp as { servers: Record<string, unknown>[] };
  assert.equal(status.servers[0]!.status, 'connected'); assert.equal(status.servers[0]!.transport, 'stdio');

  const events = await run(harness, turn('repeat hello', ['read_file', 'mcp__files__echo']), true);
  assert.deepEqual(events.map(event => event.type), ['request', 'response', 'approval', 'mcp', 'tool', 'request', 'response']);
  const approval = events.find(event => event.type === 'approval')!;
  assert.deepEqual({ ...approval, id: undefined }, { type: 'approval', id: undefined, name: 'mcp__files__echo', server: 'files', tool: 'echo', arguments: '{\n  "text": "hello"\n}', annotations: { readOnlyHint: true } });
  const mcp = events.find(event => event.type === 'mcp')!;
  assert.equal(mcp.approved, true); assert.equal(mcp.result, 'echo: hello'); assert.equal(mcp.is_error, false);
  assert.equal(mcp.protocol_version, '2026-07-28'); assert.equal(mcp.transport, 'stdio');
  assert.equal((mcp.request as { method: string }).method, 'tools/call'); assert.ok(mcp.response);
  assert.equal(events.find(event => event.type === 'tool')!.result, 'echo: hello');
  const first = model.payloads[0]!;
  assert.deepEqual(first.tools!.map(item => item.function.name), ['read_file', 'mcp__files__echo', 'get_orchestration', 'configure_goal', 'get_goal', 'update_goal']);
  assert.match(first.messages[0]!.content, /# MCP server instructions[\s\S]*## files\n\nUse echo to repeat text\./);
  assert.deepEqual(harness.activeSessionRecord().settings.tools, ['read_file', 'mcp__files__echo']);
  assert.equal(harness.state.memory.at(-2)!.content, 'echo: hello');

  const denied = await run(harness, turn('repeat again', ['mcp__files__echo']), false);
  const refused = denied.find(event => event.type === 'mcp')!;
  assert.deepEqual([refused.approved, refused.result], [false, '']);
  assert.match(String(denied.find(event => event.type === 'tool')!.result), /^refused: the user did not approve this MCP tool call/);
});

test('Node: approvals off, Stop during a call, timeouts, disabled tools and disconnected servers', async t => {
  const model = new ScriptedModel([callTool('mcp__files__echo', { text: 'auto' }), done, callTool('mcp__files__echo', { text: 'x' }), done, callTool('mcp__files__echo', { text: 'y' }), callTool('mcp__files__echo', { text: 'z' }), done]);
  const { harness } = await nodeFixture(t, model, {}, { approvalTimeoutMs: 30 });
  const automatic = await run(harness, turn('auto', ['mcp__files__echo'], false));
  assert.deepEqual(automatic.map(event => event.type), ['request', 'response', 'mcp', 'tool', 'request', 'response']);
  const timedOut = await run(harness, turn('wait', ['mcp__files__echo']));
  assert.equal(timedOut.find(event => event.type === 'mcp')!.approved, false);
  const stopped = await run(harness, turn('stop', ['mcp__files__echo']), 'stop');
  assert.equal(stopped.find(event => event.type === 'tool')!.result, 'stopped: the user stopped the turn before this tool ran');
  const unknown = await run(harness, turn('not enabled', ['read_file']));
  assert.equal(unknown.find(event => event.type === 'tool')!.result, "error: unknown tool 'mcp__files__echo'");

  const hanging = await nodeFixture(t, new ScriptedModel([callTool('mcp__files__echo', { text: 'slow' }), done]), { hangCalls: true });
  const pending = run(hanging.harness, turn('slow', ['mcp__files__echo'], false));
  setTimeout(() => hanging.harness.stop(), 100);
  const events = await pending;
  const mcp = events.find(event => event.type === 'mcp')!;
  assert.match(String(mcp.result), /^error: /);
  assert.equal(events.find(event => event.type === 'tool')!.result, 'stopped: the user stopped the turn before this tool ran');

  await hanging.harness.close();
  const after = new ScriptedModel([callTool('mcp__files__echo', { text: 'gone' }), done]);
  const offline = new NodeHarness({ workspace: hanging.root, model: 'scripted', contextLength: 20000, ollama: after, mcpConfigFile: path.join(hanging.root, 'missing.json') });
  await offline.initialize();
  const disconnected = await run(offline, turn('gone', ['mcp__files__echo', 'list_mcp_resources']));
  assert.deepEqual(after.payloads[0]!.tools!.map(tool => tool.function.name), ['get_orchestration', 'configure_goal', 'get_goal', 'update_goal']);
  assert.equal(disconnected.find(event => event.type === 'tool')!.result, "error: unknown tool 'mcp__files__echo'");
  assert.deepEqual(offline.activeSessionRecord().settings.tools, ['mcp__files__echo', 'list_mcp_resources']);
});

test('Node: MCP prompts as slash commands, resource tools, explore, reload and HTTP routes', async t => {
  const model = new ScriptedModel([done, done, callTool('read_mcp_resource', { server: 'files', uri: 'memo://greeting' }), done]);
  const { harness, config } = await nodeFixture(t, model);
  const prompted = await run(harness, turn('/mcp__files__review the parser', []));
  assert.deepEqual(prompted[0], { type: 'mcp_prompt', server: 'files', name: 'review' });
  assert.match(String(model.payloads[0]!.messages.at(-1)!.content), /^<mcp-prompt server="files" name="review">\n\[user\]: Please review the focusing on parser\./);
  assert.equal(model.payloads[0]!.messages[0]!.role, 'user');
  const unknownPrompt = await run(harness, turn('/mcp__files__nothing here', []));
  assert.equal(unknownPrompt[0]!.type, 'request');

  const resource = await run(harness, turn('read it', ['read_mcp_resource']));
  assert.equal(resource.find(event => event.type === 'tool')!.result, '[resource memo://greeting]\ncontents of memo://greeting');
  assert.match(model.payloads.at(-1)!.messages[0]!.content, /## files/);

  const explored = await harness.explore({ useMemory: true, tools: ['mcp__files__echo', 'list_mcp_resources'], agent: '', prompt: '' });
  assert.match(String(explored.tools), /mcp__files__echo[\s\S]*list_mcp_resources/);
  assert.match(String(explored.final), /This is generated|reconstruction/);
  assert.equal((explored.mcp as { servers: unknown[] }).servers.length, 1);

  const server = createHarnessServer(harness);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal(((await (await fetch(`${base}/mcp`)).json()) as { servers: { status: string }[] }).servers[0]!.status, 'connected');
  await writeFile(config, JSON.stringify({ mcpServers: { files: { disabled: true } } }));
  const reloaded = await (await fetch(`${base}/mcp/reload`, { method: 'POST' })).json() as { servers: { status: string }[] };
  assert.equal(reloaded.servers[0]!.status, 'disabled');
  await writeFile(config, '{ not json');
  const broken = await harness.reloadMcp() as { error: string };
  assert.match(broken.error, /mcp\.json: /);
});

test('Node startup reads MYHARNESS_MCP and the harness reports an absent configuration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-start-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'servers.json'), JSON.stringify({ mcpServers: { off: { disabled: true } } }));
  const harness = await loadHarness({ MYHARNESS_ROOT: root, MYHARNESS_MCP: path.join(root, 'servers.json'), MYHARNESS_PROVIDER: 'openai', MYHARNESS_MODEL: 'gpt-test', MYHARNESS_SESSIONS: path.join(root, 'sessions') });
  assert.deepEqual(harness.mcpStatus(), { supported: true, source: path.join(root, 'servers.json'), servers: [{ name: 'off', transport: '', status: 'disabled', era: null, protocol_version: null, server_info: null, instructions: '', capabilities: {}, tools: [], resources: 0, prompts: [], warnings: [], log: [], stderr: [] }] });
  const bare = new NodeHarness({ workspace: root, model: 'scripted', contextLength: 4000, ollama: new ScriptedModel([]) });
  await bare.initialize();
  assert.deepEqual(bare.mcpStatus(), { supported: true, source: '(no MCP configuration file)', servers: [] });
  await writeFile(path.join(root, 'stdio.json'), JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [STDIO_SERVER] } } }));
  const cwdRoot = new NodeHarness({ workspace: root, model: 'scripted', contextLength: 4000, ollama: new ScriptedModel([]), mcpConfigFile: path.join(root, 'stdio.json') });
  await cwdRoot.initialize(); t.after(() => cwdRoot.close());
  assert.equal((cwdRoot.mcpStatus() as { servers: { status: string }[] }).servers[0]!.status, 'connected');
});

test('Browser: HTTP MCP servers through the Worker backend; stdio unsupported; header values never persisted', async t => {
  const remote = new FixtureServer({ instructions: 'Remote hints.', tools: [ECHO] }), fetch_ = fixtureFetch(remote);
  t.mock.method(globalThis, 'fetch', (url: string, init: Parameters<typeof fetch_>[1]) => fetch_(url, init));
  const storage = await BrowserStorage.open('mcp-test', new IDBFactory()); t.after(() => storage.close());
  const model = new ScriptedModel([callTool('mcp__remote__echo', { text: 'web' }), done]);
  const options = { storage, library: { agents: {}, prompts: {}, skills: {} }, seed: { 'README.md': 'hi\n' }, modelPort: model, mcpTimeouts: { connectTimeoutMs: 2000 } };
  const backend = await BrowserHarness.open(options);
  assert.deepEqual((await backend.bootstrap()).mcp, { supported: true, source: 'imported MCP configuration (browser storage)', servers: [] });
  await assert.rejects(backend.configureMcp([]), /"mcpServers" object/);
  assert.deepEqual((await backend.configureMcp({}) as { servers: unknown[] }).servers, []);
  assert.match(String((await backend.configureMcp({ mcpServers: { odd: 3 } }) as { servers: { error: string }[] }).servers[0]!.error), /must be an object/);
  const status = await backend.configureMcp({ mcpServers: { remote: { url: 'http://remote.test/mcp', headers: { authorization: 'Bearer secret' } }, local: { command: 'node' } } }) as { servers: Record<string, unknown>[] };
  assert.deepEqual(status.servers.map(server => [server.name, server.status]), [['remote', 'connected'], ['local', 'unsupported']]);
  assert.match(String(status.servers[1]!.error), /browser cannot do/);
  assert.equal(fetch_.calls[0]!.headers.authorization, 'Bearer secret');
  assert.deepEqual(await storage.get('settings', 'mcp-config'), { mcpServers: { remote: { url: 'http://remote.test/mcp' }, local: { command: 'node' } } });

  const events = await run(backend, turn('echo web', ['mcp__remote__echo']), true);
  assert.equal(events.find(event => event.type === 'mcp')!.result, 'echo: web');
  assert.match(model.payloads[0]!.messages[0]!.content, /## remote\n\nRemote hints\./);

  const sent: RpcMessage[] = [], host = new WorkerHost(async () => backend, message => sent.push(message));
  await host.handle({ id: '1', action: 'mcp', payload: {} });
  await host.handle({ id: '2', action: 'reloadMcp', payload: {} });
  await host.handle({ id: '3', action: 'configureMcp', payload: { mcpServers: {} } });
  assert.deepEqual(sent.map(message => message.type), ['result', 'result', 'result']);
  assert.deepEqual((sent[2] as { value: { servers: unknown[] } }).value.servers, []);

  const calls: [string, Record<string, unknown>][] = [];
  const shim = browserFetch({ call: async (action: string, payload: Record<string, unknown>) => { calls.push([action, payload]); return { ok: action }; } } as unknown as WorkerClient);
  assert.deepEqual(await (await shim('/mcp')).json(), { ok: 'mcp' });
  assert.deepEqual(await (await shim('/mcp/reload', { method: 'POST' })).json(), { ok: 'reloadMcp' });
  assert.deepEqual(calls.map(call => call[0]), ['mcp', 'reloadMcp']);

  const reopened = await BrowserHarness.open(options);
  const restored = (reopened.mcpStatus() as { servers: Record<string, unknown>[] }).servers;
  assert.deepEqual(restored, []);
  await storage.put('settings', 'mcp-config', { mcpServers: { remote: { url: 'http://remote.test/mcp' } } });
  const third = await BrowserHarness.open(options);
  assert.equal((third.mcpStatus() as { servers: Record<string, unknown>[] }).servers[0]!.status, 'connected');
  assert.equal(fetch_.calls.at(-1)!.headers.authorization, undefined);
  await Promise.all([backend.close(), reopened.close(), third.close()]);
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { IDBFactory } from 'fake-indexeddb';
import { registryServer, searchRegistry, serverKey, type RegistryServer } from '../src/mcp/registry.js';
import { McpManager } from '../src/mcp/manager.js';
import type { McpFetch, McpFetchResponse } from '../src/mcp/http.js';
import { NodeHarness } from '../src/node/harness.js';
import { createHarnessServer } from '../src/node/http.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { BrowserStorage } from '../src/browser/storage.js';
import { WorkerHost, type RpcMessage } from '../src/browser/worker-host.js';
import { browserFetch } from '../src/browser/fetch.js';
import type { WorkerClient } from '../src/browser/client.js';
import { FixtureServer, fixtureFetch } from './mcp-fixture.js';

const entry = (server: Record<string, unknown>, status?: string) => ({ server: { name: 'io.github.acme/weather', description: 'Weather data', version: '1.2.0', ...server }, ...(status ? { _meta: { 'io.modelcontextprotocol.registry/official': { status } } } : {}) });
const option = (server: RegistryServer | undefined, index = 0) => server!.options[index]!;

test('registry entries become remote and package options with ready mcp.json snippets', () => {
  assert.equal(serverKey('io.github.acme/weather'), 'weather');
  assert.equal(serverKey('ai.example/a b.c'), 'a-b-c');
  assert.equal(serverKey('x/'), 'server');
  assert.equal(registryServer(null), undefined);
  assert.equal(registryServer({ server: { description: 'no name' } }), undefined);

  const remote = registryServer(entry({ title: 'Weather', websiteUrl: 'https://acme.test', repository: { url: 'https://github.com/acme/weather' }, remotes: [
    { type: 'streamable-http', url: 'https://{region}.acme.test/{tenant}/mcp', variables: { region: { default: 'eu' }, tenant: { description: 'Your tenant' } },
      headers: [{ name: 'Authorization', isRequired: true, isSecret: true, description: 'Bearer token.' }, { name: 'X-Client', value: 'harness-{tenant}' }, { name: 'X-Opt' }] },
    { type: 'sse', url: 'https://acme.test/sse' }, 'odd',
  ] }, 'active'))!;
  assert.deepEqual({ ...remote, options: undefined }, { name: 'io.github.acme/weather', title: 'Weather', description: 'Weather data', version: '1.2.0', status: 'active', website: 'https://acme.test', repository: 'https://github.com/acme/weather', options: undefined });
  assert.deepEqual(option(remote), {
    kind: 'remote', label: 'Remote server · Streamable HTTP · https://eu.acme.test/${TENANT}/mcp', preview: null,
    config: { mcpServers: { weather: { url: 'https://eu.acme.test/${TENANT}/mcp', headers: { Authorization: '${AUTHORIZATION}', 'X-Client': 'harness-${TENANT}', 'X-Opt': '${X_OPT}' } } } },
    notes: ['Set TENANT: Your tenant.', 'Set AUTHORIZATION for the Authorization header (required), a secret: Bearer token.', 'Set TENANT.', 'Set X_OPT for the X-Opt header.', 'The preview can send an Authorization header entered for that preview. Other headers must be supplied through the backend preview API or server configuration.'],
  });
  assert.deepEqual(option(remote, 1), { kind: 'remote', label: 'Remote server · HTTP+SSE (deprecated) · https://acme.test/sse', preview: { type: 'sse', url: 'https://acme.test/sse' }, config: { mcpServers: { weather: { type: 'sse', url: 'https://acme.test/sse' } } }, notes: [] });
  assert.equal(remote.options.length, 2);

  const packages = registryServer(entry({ packages: [
    { registryType: 'npm', identifier: '@acme/weather', version: '1.2.0', transport: { type: 'stdio' }, environmentVariables: [
      { name: 'ACME_KEY', isRequired: true, isSecret: true, description: 'API key' }, { name: 'ACME_URL', description: 'Override.' }, { name: 'ACME_DEBUG' }, { name: 'ACME_MODE', default: 'fast' }, { name: 'ACME_HOME', value: '{home}/acme', variables: { home: { default: '/opt' } } }, { name: 'PLAIN', isRequired: true }],
      packageArguments: [{ type: 'positional', valueHint: 'path', isRequired: true, description: 'Folder' }, { type: 'named', name: '--port', default: '8080' }, { type: 'named', name: '--verbose' }, { type: 'named', name: '--token', isRequired: true }, { type: 'positional', value: 'fixed' }, { type: 'positional', isRequired: true }] },
    { registryType: 'pypi', identifier: 'acme-weather', version: '2.0', runtimeHint: 'uvx', runtimeArguments: [{ type: 'named', name: '--python', value: '3.12' }] },
    { registryType: 'oci', identifier: 'ghcr.io/acme/weather', version: '1.2.0', environmentVariables: [{ name: 'TOKEN', isRequired: true }] },
    { registryType: 'oci', identifier: 'ghcr.io/acme/weather:latest', version: '', runtimeArguments: [{ type: 'named', name: '-e', value: 'TOKEN={token}', variables: { token: { isSecret: true } } }] },
    { registryType: 'oci', identifier: 'ghcr.io/acme/own', version: '1', runtimeArguments: [{ type: 'positional', value: 'run' }, { type: 'positional', value: '-i' }] },
    { registryType: 'nuget', identifier: 'Acme.Weather', version: '1.0.0' },
    { registryType: 'mcpb', identifier: 'https://acme.test/weather.mcpb', version: '1' },
    { registryType: 'npm', identifier: '@acme/http', version: '1', transport: { type: 'streamable-http', url: 'http://localhost:{port}/mcp' } },
    { identifier: 'mystery' },
  ] }, 'deprecated'))!;
  assert.equal(packages.status, 'deprecated'); assert.equal(packages.title, 'io.github.acme/weather');
  assert.deepEqual(option(packages), {
    kind: 'package', label: 'npm package · stdio · @acme/weather 1.2.0', preview: null,
    config: { mcpServers: { weather: { command: 'npx', args: ['-y', '@acme/weather@1.2.0', '<path>', '--port', '8080', '--token', '<token>', 'fixed', '<value>'], env: { ACME_KEY: '${ACME_KEY}', ACME_MODE: 'fast', ACME_HOME: '/opt/acme', PLAIN: '${PLAIN}' } } } },
    notes: ['Set ACME_KEY, a secret, in your environment: API key.', 'Optional: ACME_URL (Override).', 'Optional: ACME_DEBUG.', 'Set PLAIN in your environment.', 'Replace <path>: Folder.', 'Replace <token>.', 'Replace <value>.',
      "Adding this runs 'npx', which downloads and starts @acme/weather with your account's permissions. Registry entries are not reviewed."],
  });
  assert.deepEqual(option(packages, 1).config, { mcpServers: { weather: { command: 'uvx', args: ['--python', '3.12', 'acme-weather==2.0'] } } });
  assert.deepEqual(option(packages, 2).config, { mcpServers: { weather: { command: 'docker', args: ['run', '-i', '--rm', '-e', 'TOKEN', 'ghcr.io/acme/weather:1.2.0'], env: { TOKEN: '${TOKEN}' } } } });
  // Like GitHub's entry: runtime arguments follow docker run -i --rm.
  assert.deepEqual((option(packages, 3).config!.mcpServers as Record<string, { args: string[] }>).weather!.args, ['run', '-i', '--rm', '-e', 'TOKEN=${TOKEN}', 'ghcr.io/acme/weather:latest']);
  assert.deepEqual((option(packages, 4).config!.mcpServers as Record<string, { args: string[] }>).weather!.args, ['run', '-i', 'ghcr.io/acme/own:1']);
  assert.deepEqual(option(packages, 5).config, { mcpServers: { weather: { command: 'dnx', args: ['Acme.Weather@1.0.0'] } } });
  assert.deepEqual([option(packages, 6).config, option(packages, 6).notes], [null, ["The harness cannot generate a command for mcpb packages. See the server's documentation."]]);
  assert.match(option(packages, 7).notes[0]!, /runs its own local HTTP server/);
  assert.equal(option(packages, 7).label, 'npm package · streamable-http · @acme/http 1');
  assert.deepEqual([option(packages, 8).label, option(packages, 8).notes], ['unknown package · stdio · mystery', ["The harness cannot generate a command for this package. See the server's documentation."]]);
  assert.deepEqual(registryServer(entry({ repository: 'not an object' }))!.options, []);
});

test('registry search asks for the latest versions, pages with a cursor and reports failures', async () => {
  const urls: string[] = [];
  const reply = (body: string, status = 200): McpFetch => async url => { urls.push(url); return new Response(body, { status }) as unknown as McpFetchResponse; };
  const page = JSON.stringify({ servers: [entry({}), entry({ name: 'gone/x' }, 'deleted'), { junk: true }], metadata: { nextCursor: 'io.github.acme/weather:1.2.0', count: 3 } });
  const found = await searchRegistry(reply(page), { search: 'weather', cursor: 'abc' });
  assert.deepEqual(found.servers.map(server => server.name), ['io.github.acme/weather']);
  assert.equal(found.nextCursor, 'io.github.acme/weather:1.2.0');
  assert.equal(urls[0], 'https://api.mcp.github.com/v0.1/servers?limit=20&search=weather&cursor=abc');
  assert.deepEqual(await searchRegistry(reply('[]'), { limit: 5 }, new AbortController().signal, 'http://local.test'), { servers: [], nextCursor: '' });
  assert.equal(urls[1], 'http://local.test/v0.1/servers?limit=5');
  await searchRegistry(reply('{}'), { source: 'official', search: 'git' });
  assert.equal(urls[2], 'https://registry.modelcontextprotocol.io/v0/servers?version=latest&limit=20&search=git');
  assert.deepEqual(await searchRegistry(reply('{"servers":"x","metadata":[]}'), {}), { servers: [], nextCursor: '' });
  await assert.rejects(searchRegistry(reply('down', 503), {}), /HTTP 503/);
  await assert.rejects(searchRegistry(reply('<html>'), {}), /invalid JSON/);
});

test('previews connect once to a remote server and leave nothing behind', async () => {
  const server = new FixtureServer({ instructions: 'Preview hints.', prompts: [{ name: 'p' }] }), fetch_ = fixtureFetch(server, { stateless: true });
  const manager = new McpManager({ source: 'test', fetch: fetch_, loadConfig: async () => undefined });
  const preview = await manager.preview({ type: 'http', url: 'http://remote.test/mcp' });
  assert.equal(preview.status, 'connected'); assert.equal(preview.instructions, 'Preview hints.');
  assert.deepEqual((preview.tools as { qualified: string }[]).map(tool => tool.qualified), ['mcp__preview__echo']);
  assert.deepEqual(manager.definitions(), []);
  const refused = await new McpManager({ source: 'test', fetch: fixtureFetch(server, { status: 401 }), loadConfig: async () => undefined }).preview({ type: 'sse', url: 'http://remote.test/sse' });
  assert.equal(refused.status, 'error'); assert.match(String(refused.error), /Authorization required/);
  await assert.rejects(new McpManager(undefined).preview({ type: 'http', url: 'http://x.test' }), /does not provide MCP/);
  await assert.rejects(new McpManager(undefined).searchRegistry({}), /cannot reach the MCP registry/);
  await assert.rejects(new McpManager({ source: 'x', loadConfig: async () => undefined }).searchRegistry({}), /cannot reach/);
});

test('authenticated previews use ephemeral headers, reject invalid headers and do not retain credentials', async t => {
  const token = 'Bearer preview-secret';
  const fixture = fixtureFetch(new FixtureServer(), { stateless: true });
  const seen: Record<string, string>[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: Parameters<McpFetch>[1]) => {
    seen.push(init.headers);
    if (init.headers.Authorization !== token) return new Response('Authorization required', { status: 401 });
    return fixture(url, init);
  });
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-preview-auth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const harness = new NodeHarness({ workspace: root, model: 'scripted', contextLength: 4000, ollama: { async *streamChat() { yield ''; } } });
  t.after(() => harness.close());
  const target = { type: 'http', url: 'http://remote.test/mcp' };
  assert.equal((await harness.previewMcp(target)).status, 'error');
  seen.length = 0;
  const result = await harness.previewMcp({ ...target, headers: { Authorization: token, 'X-Client': 'preview' } });
  assert.equal(result.status, 'connected');
  assert.ok(seen.length > 1);
  assert.ok(seen.every(headers => headers.Authorization === token && headers['X-Client'] === 'preview'));
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(harness.mcpStatus()).includes(token));
  assert.deepEqual(harness.mcpStatus().servers, []);
  assert.equal((await harness.previewMcp(target)).status, 'error');
  for (const headers of [null, [], 'Bearer secret', { Authorization: 42 }]) {
    await assert.rejects(harness.previewMcp({ ...target, headers }), /headers must be an object of strings/);
  }
});

test('registry search and previews through Node HTTP, browser Worker RPC and the UI fetch shim', async t => {
  const remote = new FixtureServer(), mcp = fixtureFetch(remote);
  let registryStatus = 200;
  const registryUrls: string[] = [];
  const fake = async (url: string, init: Parameters<McpFetch>[1]) => url.startsWith('https://registry.modelcontextprotocol.io/') || url.startsWith('https://api.mcp.github.com/')
    ? (registryUrls.push(url),  new Response(JSON.stringify({ servers: [entry({ remotes: [{ type: 'streamable-http', url: 'http://remote.test/mcp' }] })], metadata: {} }), { status: registryStatus }))
    : mcp(url, init);
  t.mock.method(globalThis, 'fetch', fake);
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-registry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const harness = new NodeHarness({ workspace: root, model: 'scripted', contextLength: 4000, ollama: { async *streamChat() { yield ''; } } });
  await harness.initialize();
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Global fetch is mocked here, so requests to the harness use node:http directly.
  const http = (route: string, init: { method?: string; body?: string } = {}) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const outgoing = request(base + route, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json' } }, response => {
        let text = ''; response.on('data', chunk => { text += String(chunk); }); response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
      });
      outgoing.on('error', reject); outgoing.end(init.body);
    });
  const found = await http('/mcp/registry?search=weather');
  assert.equal(found.status, 200); assert.equal((found.body.servers as RegistryServer[])[0]!.options[0]!.preview!.url, 'http://remote.test/mcp');
  assert.equal((await http('/mcp/registry')).status, 200);
  assert.equal((await http('/mcp/registry?source=official')).status, 200);
  assert.deepEqual(registryUrls.map(url => new URL(url).host), ['api.mcp.github.com', 'api.mcp.github.com', 'registry.modelcontextprotocol.io']);
  const badSource = await http('/mcp/registry?source=evil'); assert.equal(badSource.status, 400); assert.match(String(badSource.body.error), /source must be/);
  const preview = await http('/mcp/preview', { method: 'POST', body: JSON.stringify({ type: 'http', url: 'http://remote.test/mcp' }) });
  assert.equal(preview.body.status, 'connected');
  const refused = await http('/mcp/preview', { method: 'POST', body: JSON.stringify({ command: 'npx' }) });
  assert.equal(refused.status, 400); assert.match(String(refused.body.error), /Packages are not run for a preview/);
  registryStatus = 500;
  const failed = await http('/mcp/registry');
  assert.equal(failed.status, 502); assert.match(String(failed.body.error), /Could not search the MCP registry: the registry answered HTTP 500/);
  registryStatus = 200;
  await assert.rejects(harness.searchMcpRegistry({ search: 3 }), /search must be a string/);
  await assert.rejects(harness.searchMcpRegistry({ cursor: [] }), /cursor must be a string/);
  assert.equal((await harness.searchMcpRegistry({ search: '', cursor: 'next' }) as { servers: unknown[] }).servers.length, 1);

  const storage = await BrowserStorage.open('mcp-registry', new IDBFactory()); t.after(() => storage.close());
  const backend = await BrowserHarness.open({ storage, library: { agents: {}, prompts: {}, skills: {} }, seed: {} });
  const sent: RpcMessage[] = [], host = new WorkerHost(async () => backend, message => sent.push(message));
  await host.handle({ id: '1', action: 'mcpRegistry', payload: { search: 'weather' } });
  await host.handle({ id: '2', action: 'previewMcp', payload: { type: 'http', url: 'http://remote.test/mcp' } });
  await host.handle({ id: '3', action: 'previewMcp', payload: { type: 'http', url: 'not a url' } });
  assert.deepEqual(sent.map(message => message.type), ['result', 'result', 'result']);
  assert.match(String((sent[2] as { value: { error: string } }).value.error), /HTTP\(S\) URL/);
  const bare = new McpManager(undefined);
  Object.defineProperty(backend, 'mcp', { value: bare });
  await assert.rejects(backend.previewMcp({ type: 'http', url: 'http://remote.test/mcp' }), /does not provide MCP/);

  const calls: [string, Record<string, unknown>][] = [];
  const shim = browserFetch({ call: async (action: string, payload: Record<string, unknown>) => { calls.push([action, payload]); return {}; } } as unknown as WorkerClient);
  await shim('/mcp/registry?search=git&cursor=c1&source=official');
  await shim('/mcp/preview', { method: 'POST', body: JSON.stringify({ type: 'sse', url: 'http://x.test' }) });
  assert.deepEqual(calls, [['mcpRegistry', { search: 'git', cursor: 'c1', source: 'official' }], ['previewMcp', { type: 'sse', url: 'http://x.test' }]]);
  await harness.close();
});

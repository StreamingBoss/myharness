import assert from 'node:assert/strict';
import test from 'node:test';
import { McpManager, expand, parseConfig, type McpRuntime, type StdioConfig } from '../src/mcp/manager.js';
import type { McpFetch, McpFetchResponse } from '../src/mcp/http.js';
import type { McpToolCall } from '../src/mcp/manager.js';
import { ECHO, FixtureServer, MemoryChannel, PROMPT, RESOURCE, fixtureFetch } from './mcp-fixture.js';

const signal = () => new AbortController().signal;
type Status = { supported: boolean; source?: string; reason?: string; error?: string; servers: Record<string, unknown>[] };
const servers = (manager: McpManager) => (manager.status() as unknown as Status).servers;

/** Routes requests to fixture servers by host name. */
function router(routes: Record<string, McpFetch>): McpFetch {
  return (url, init) => routes[new URL(url).hostname]!(url, init);
}

test('configuration: the standard mcpServers format, per-server errors and ${VAR} expansion', () => {
  assert.deepEqual(parseConfig(undefined), {});
  assert.deepEqual(parseConfig({}), {});
  assert.throws(() => parseConfig([]), /"mcpServers" object/);
  assert.throws(() => parseConfig({ mcpServers: [] }), /"mcpServers" object/);
  const parsed = parseConfig({ mcpServers: {
    files: { command: 'node', args: ['server.js'], env: { TOKEN: 'x' }, cwd: 'tools' },
    bare: { command: 'run' },
    remote: { type: 'http', url: 'https://example.test/mcp', headers: { authorization: 'Bearer x' } },
    plain: { url: 'https://example.test/mcp' }, alias: { type: 'streamable-http', url: 'https://example.test/mcp' },
    old: { type: 'sse', url: 'https://example.test/sse' }, off: { disabled: true, command: 'x' },
    'bad name': { command: 'x' }, notObject: 3, emptyCommand: { command: ' ' }, badArgs: { command: 'x', args: [1] }, badCwd: { command: 'x', cwd: 1 },
    badEnv: { command: 'x', env: { A: 1 } }, badType: { type: 'ws', url: 'x' }, noUrl: { type: 'http' }, badHeaders: { url: 'https://x', headers: [] },
  } });
  assert.deepEqual(parsed.files, { kind: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'x' }, cwd: 'tools' });
  assert.deepEqual(parsed.bare, { kind: 'stdio', command: 'run', args: [], env: {} });
  assert.deepEqual(parsed.remote, { kind: 'http', url: 'https://example.test/mcp', headers: { authorization: 'Bearer x' } });
  assert.equal((parsed.plain as { kind: string }).kind, 'http'); assert.equal((parsed.alias as { kind: string }).kind, 'http'); assert.equal((parsed.old as { kind: string }).kind, 'sse');
  assert.equal(parsed.off, null);
  const errors = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value instanceof Error).map(([key, value]) => [key, (value as Error).message]));
  assert.match(errors['bad name']!, /letters, digits/); assert.match(errors.notObject!, /must be an object/); assert.match(errors.emptyCommand!, /non-empty/);
  assert.match(errors.badArgs!, /args/); assert.match(errors.badCwd!, /cwd/); assert.match(errors.badEnv!, /env must be an object of strings/);
  assert.match(errors.badType!, /"http" or "sse"/); assert.match(errors.noUrl!, /url must be a string/); assert.match(errors.badHeaders!, /headers must be/);
  assert.equal(expand('${A}/${B:-fallback}/${C:-}', { A: 'a' }), 'a/fallback/');
  assert.throws(() => expand('${MISSING}', {}), /MISSING is not set/);
});

test('without runtime support MCP is reported, not silently skipped', async () => {
  const manager = new McpManager(undefined);
  await manager.load();
  assert.deepEqual(manager.status(), { supported: false, reason: 'This runtime does not provide MCP capabilities.', servers: [] });
  assert.deepEqual(manager.definitions(), []); assert.deepEqual(manager.toolList(), []); assert.equal(manager.instructions(['x']), '');
  const broken = new McpManager({ source: 'test', loadConfig: async () => { throw new Error('mcp.json: Unexpected token'); } });
  await broken.load();
  assert.equal((broken.status() as unknown as Status).error, 'mcp.json: Unexpected token');
});

test('servers become namespaced tools, resources, prompts and instructions', async () => {
  const main = new FixtureServer({ instructions: 'Call echo when asked to repeat.', tools: [ECHO, { name: 'weather', description: 'Weather', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } } }],
    resources: [RESOURCE, { uri: 'memo://plain' }], templates: [{ uriTemplate: 'memo://{id}', name: 'Memo', description: 'Any memo' }, { uriTemplate: 'memo://raw/{id}' }], prompts: [PROMPT, { name: 'hello' }] });
  const quiet = new FixtureServer({ era: 'legacy', tools: [{ name: 'ping', inputSchema: 'not a schema' }], resources: [], templates: 'error', capabilities: { tools: {}, resources: {} } });
  const runtime: McpRuntime = { source: 'test config', fetch: router({ main: fixtureFetch(main), quiet: fixtureFetch(quiet) }), environment: { HOST: 'main' },
    loadConfig: async () => ({ mcpServers: { main: { url: 'http://${HOST}/mcp' }, quiet: { url: 'http://quiet/mcp' } } }) };
  const manager = new McpManager(runtime);
  await manager.load();
  const [first, second] = servers(manager);
  assert.equal(first!.status, 'connected'); assert.equal(first!.era, 'modern'); assert.equal(first!.protocol_version, '2026-07-28'); assert.equal(first!.transport, 'http');
  assert.equal(second!.era, 'legacy'); assert.equal(second!.resources, 0);
  assert.deepEqual(manager.definitions().map(tool => tool.function.name), ['mcp__main__echo', 'mcp__main__weather', 'mcp__quiet__ping', 'list_mcp_resources', 'read_mcp_resource']);
  const echo = manager.definitions()[0]!.function;
  assert.equal(echo.description, '[MCP server main] Echo the text back');
  assert.deepEqual(echo.parameters, { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });
  assert.deepEqual(manager.definitions()[2]!.function.parameters, { type: 'object', properties: {} });
  assert.deepEqual(manager.toolList().map(tool => tool.server), ['main', 'main', 'quiet', '', '']);
  assert.equal(manager.owns('mcp__x__y'), true); assert.equal(manager.owns('read_mcp_resource'), true); assert.equal(manager.owns('read_file'), false);

  assert.equal(manager.instructions(['read_file']), '');
  assert.match(manager.instructions(['mcp__main__echo']), /^# MCP server instructions\n\nThese instructions come from the connected MCP servers, not from the user\.\n\n## main\n\nCall echo when asked to repeat\.$/);
  assert.match(manager.instructions(['read_mcp_resource']), /## main/);

  const prepared = await manager.prepare('mcp__main__weather', { region: 'eu' }, signal());
  assert.equal(prepared.kind, 'mcp');
  const call = (prepared as { call: McpToolCall }).call;
  assert.deepEqual({ ...call, annotations: undefined }, { name: 'mcp__main__weather', server: 'main', tool: 'weather', arguments: { region: 'eu' }, annotations: undefined });
  const outcome = await manager.call(call, signal());
  assert.equal(outcome.text, 'echo: undefined'); assert.equal(outcome.isError, false); assert.equal(outcome.version, '2026-07-28'); assert.equal(outcome.transport, 'http');
  assert.equal(outcome.request!.method, 'tools/call');
  const echoed = await manager.call({ name: 'mcp__main__echo', server: 'main', tool: 'echo', arguments: { text: 'hi' }, annotations: null }, signal());
  assert.equal(echoed.text, 'echo: hi');

  assert.equal((await manager.prepare('list_mcp_resources', {}, signal()) as { text: string }).text,
    'main: memo://greeting — Greeting (text/plain): A short greeting\nmain: memo://plain — \nmain: memo://{id} (template) — Memo: Any memo\nmain: memo://raw/{id} (template) — ');
  assert.equal((await manager.prepare('list_mcp_resources', { server: 'quiet' }, signal()) as { text: string }).text, '(no resources)');
  assert.equal((await manager.prepare('read_mcp_resource', { server: 'main', uri: 'memo://greeting' }, signal()) as { text: string }).text, '[resource memo://greeting]\ncontents of memo://greeting');
  assert.match((await manager.prepare('read_mcp_resource', { server: 'main', uri: 'memo://none' }, signal()) as { text: string }).text, /^error: Resource not found/);
  assert.match((await manager.prepare('read_mcp_resource', { uri: 'memo://greeting' }, signal()) as { text: string }).text, /give server and uri/);
  assert.match((await manager.prepare('read_mcp_resource', { server: 'main' }, signal()) as { text: string }).text, /give server and uri/);
  assert.match((await manager.prepare('list_mcp_resources', { server: 3 }, signal()) as { text: string }).text, /bad arguments for 'server'/);
  assert.match((await manager.prepare('list_mcp_resources', { server: 'nobody' }, signal()) as { text: string }).text, /no connected MCP server 'nobody' offers resources/);
  assert.match((await manager.prepare('mcp__main__missing', {}, signal()) as { text: string }).text, /unknown tool 'mcp__main__missing'/);

  const expansion = await manager.prompt('mcp__main__review', 'the README for clarity and tone', signal());
  assert.deepEqual(expansion, { server: 'main', name: 'review', text: '<mcp-prompt server="main" name="review">\n[user]: Please review the focusing on README for clarity and tone.\n\n[assistant]: Sure.\n</mcp-prompt>' });
  const short = await manager.prompt('mcp__main__review', '', signal());
  assert.match(short!.text, /Please review undefined\./);
  const noArgs = await manager.prompt('mcp__main__hello', ' extra words ', signal());
  assert.match(noArgs!.text, /<\/mcp-prompt>\n\nextra words$/);
  assert.equal(await manager.prompt('mcp__main__nothing', '', signal()), undefined);
  assert.deepEqual(first!.prompts, [{ name: 'review', qualified: 'mcp__main__review', description: 'Review a topic', arguments: [{ name: 'topic', description: 'What to review', required: true }, { name: 'focus', description: '', required: false }] }, { name: 'hello', qualified: 'mcp__main__hello', description: '', arguments: [] }]);
  await manager.close();
  assert.deepEqual(servers(manager), []);
});

test('deprecated HTTP+SSE servers, by type or by fallback, and invalid header annotations', async () => {
  const old = new FixtureServer({ era: 'legacy', legacyVersion: '2024-11-05', prompts: [{ name: 'empty' }] });
  const modern = new FixtureServer({ tools: [ECHO, { name: 'bad', inputSchema: { properties: { a: { type: 'number', 'x-mcp-header': 'A' } } } }] });
  const manager = new McpManager({ source: 'test', fetch: router({ typed: fixtureFetch(old, { legacySse: true }), fallback: fixtureFetch(old, { legacySse: true }), modern: fixtureFetch(modern) }),
    loadConfig: async () => ({ mcpServers: { typed: { type: 'sse', url: 'http://typed/sse' }, fallback: { url: 'http://fallback/mcp' }, modern: { url: 'http://modern/mcp' } } }) }, { probeTimeoutMs: 50 });
  await manager.load();
  const [typed, fallback, current] = servers(manager);
  assert.deepEqual([typed!.status, typed!.transport, typed!.protocol_version], ['connected', 'sse', '2024-11-05']);
  assert.deepEqual([fallback!.status, fallback!.transport], ['connected', 'sse']);
  assert.deepEqual(current!.warnings, ["tool 'bad' skipped: x-mcp-header on 'a' needs a string, integer or boolean property"]);
  const prompt = await manager.prompt('mcp__typed__empty', '', signal());
  assert.equal(prompt!.text, '<mcp-prompt server="typed" name="empty">\n\n</mcp-prompt>');
  await manager.close();
});

test('unsupported transports, invalid entries, disabled servers and connection failures stay visible', async () => {
  const launched: StdioConfig[] = [];
  const down = fixtureFetch(new FixtureServer(), { status: 401 });
  const flaky = fixtureFetch(new FixtureServer({ capabilities: { tools: {}, prompts: {} } }));
  const runtime: McpRuntime = {
    source: 'test', environment: { SECRET: 's3cret' }, networkHint: 'Check CORS.',
    fetch: router({ down, flaky: (url, init) => init.body?.includes('prompts/list') ? Promise.resolve(new Response('boom', { status: 500 }) as unknown as McpFetchResponse) : flaky(url, init), offline: () => Promise.reject(new TypeError('fetch failed')), slow: (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error))) }),
    stdio: config => { launched.push(config); return new MemoryChannel(new FixtureServer({ tools: [ECHO, { name: 'ec ho' }, { name: 'ec?ho' }, { description: 'nameless' }, { name: 'x'.repeat(60) }], prompts: [{ name: 'echo' }, {}], capabilities: { tools: {}, prompts: {} } })); },
    loadConfig: async () => ({ mcpServers: {
      local: { command: 'node', args: ['${SECRET}'], env: { TOKEN: '${SECRET}' }, cwd: '${SECRET}' }, noCwd: { command: 'node' },
      down: { url: 'http://down/mcp' }, flaky: { url: 'http://flaky/mcp' }, offline: { url: 'http://offline/mcp' },
      creds: { url: 'http://user:pass@down/mcp' }, ftp: { url: 'ftp://down/mcp' }, junk: { url: 'not a url' }, missing: { url: 'http://${NOPE}/mcp' },
      off: { disabled: true }, invalid: { command: '' },
    } }),
  };
  const manager = new McpManager(runtime);
  await manager.load();
  const byName = Object.fromEntries(servers(manager).map(state => [state.name, state]));
  assert.deepEqual(launched, [{ kind: 'stdio', command: 'node', args: ['s3cret'], env: { TOKEN: 's3cret' }, cwd: 's3cret' }, { kind: 'stdio', command: 'node', args: [], env: {} }]);
  assert.equal(byName.local!.status, 'connected');
  assert.deepEqual((byName.local!.tools as { qualified: string }[]).map(tool => tool.qualified), ['mcp__local__echo', 'mcp__local__ec_ho']);
  assert.deepEqual(byName.local!.warnings, ["tool 'ec?ho' skipped: its name collides with another after sanitizing", 'a tool without a name was skipped',
    `tool '${'x'.repeat(60)}' skipped: its qualified name is longer than 64 characters`, "prompt 'echo' skipped: its name collides with another after sanitizing", 'a prompt without a name was skipped']);
  assert.match(String(byName.down!.error), /HTTP 401.*Authorization required/);
  assert.equal(byName.flaky!.status, 'error'); assert.match(String(byName.flaky!.error), /HTTP 500/);
  assert.equal(byName.offline!.error, 'fetch failed Check CORS.');
  for (const name of ['creds', 'ftp', 'junk']) assert.match(String(byName[name]!.error), /HTTP\(S\) URL without credentials/);
  assert.match(String(byName.missing!.error), /NOPE is not set/);
  assert.equal(byName.off!.status, 'disabled'); assert.equal(byName.off!.transport, '');
  assert.match(String(byName.invalid!.error), /^invalid: command/);
  assert.match((await manager.prepare('mcp__flaky__echo', {}, signal()) as { text: string }).text, /MCP server 'flaky' is not connected \(error: HTTP 500/);
  assert.match((await manager.prepare('mcp__off__x', {}, signal()) as { text: string }).text, /'off' is not connected \(disabled\)$/);
  assert.match((await manager.prepare('list_mcp_resources', {}, signal()) as { text: string }).text, /no connected MCP server offers resources/);
  assert.deepEqual(manager.definitions().map(tool => tool.function.name), ['mcp__local__echo', 'mcp__local__ec_ho', 'mcp__noCwd__echo', 'mcp__noCwd__ec_ho']);

  const failing = await manager.call({ name: 'mcp__local__echo', server: 'local', tool: 'echo', arguments: {}, annotations: null }, AbortSignal.abort(new Error('stopped')));
  assert.deepEqual({ text: failing.text, isError: failing.isError }, { text: 'error: stopped', isError: true });

  const timed = new McpManager({ ...runtime, loadConfig: async () => ({ mcpServers: { slow: { url: 'http://slow/mcp' } } }) }, { connectTimeoutMs: 30 });
  await timed.load();
  assert.match(String(servers(timed)[0]!.error), /Time limit: 30 milliseconds/);
  const plain = new McpManager({ source: 'browser', stdioUnsupported: 'stdio needs Node.', loadConfig: async () => ({ mcpServers: { a: { command: 'x' }, b: { url: 'http://b/mcp' } } }) });
  await plain.load();
  assert.deepEqual(servers(plain).map(state => [state.status, state.error]), [['unsupported', 'stdio needs Node.'], ['unsupported', 'HTTP servers are unavailable in this runtime']]);
  const generic = new McpManager({ source: 'x', loadConfig: async () => ({ mcpServers: { a: { command: 'x' } } }) });
  await generic.load();
  assert.equal(servers(generic)[0]!.error, 'stdio servers are unavailable in this runtime');
  await manager.load(); await manager.close();
});

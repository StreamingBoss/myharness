import assert from 'node:assert/strict';
import test from 'node:test';
import { McpClient, type McpChannel } from '../src/mcp/client.js';
import { LegacySseChannel, StreamableHttpChannel, type McpFetch, type McpFetchResponse } from '../src/mcp/http.js';
import { HttpStatusError, McpError, type RpcNotification, type RpcRequest, type RpcResponse } from '../src/mcp/protocol.js';
import { ECHO, FixtureServer, MemoryChannel, fixtureFetch } from './mcp-fixture.js';

const signal = () => new AbortController().signal;
const URL_ = 'http://mcp.test/mcp';
const TWO_TOOLS = [ECHO, { name: 'second', inputSchema: { type: 'object' } }];

/** Answers each request from a list of scripted replies. */
class ScriptedChannel implements McpChannel {
  readonly sent: RpcRequest[] = [];
  readonly notified: RpcNotification[] = [];
  onRequest?: (request: RpcRequest) => RpcResponse;
  constructor(private readonly replies: ((request: RpcRequest) => RpcResponse | Error)[], readonly transport: 'stdio' | 'http' = 'stdio') {}
  async request(message: RpcRequest): Promise<RpcResponse> {
    this.sent.push(message);
    const reply = this.replies.shift()!(message);
    if (reply instanceof Error) throw reply;
    return reply;
  }
  async notify(message: RpcNotification): Promise<void> { this.notified.push(message); }
  async close(): Promise<void> {}
}
const result = (value: Record<string, unknown>) => (request: RpcRequest): RpcResponse => ({ jsonrpc: '2.0', id: request.id, result: value });
const failure = (code: number, data?: unknown) => (request: RpcRequest): RpcResponse => ({ jsonrpc: '2.0', id: request.id, error: { code, message: 'scripted', ...(data ? { data } : {}) } });

test('modern stdio server: discover, metadata on every request, pagination, calls and the wire log', async () => {
  const server = new FixtureServer({ instructions: 'Use echo for testing.', tools: TWO_TOOLS, pageSize: 1 });
  const client = new McpClient(new MemoryChannel(server));
  await assert.rejects(client.request('tools/list', {}, signal()), /not connected/);
  await client.connect(signal());
  assert.equal(client.era, 'modern'); assert.equal(client.version, '2026-07-28'); assert.equal(client.transport, 'stdio');
  assert.equal(client.instructions, 'Use echo for testing.'); assert.deepEqual(client.serverInfo, { name: 'fixture', version: '1' });
  assert.deepEqual((await client.list('tools/list', 'tools', signal())).map(tool => tool.name), ['echo', 'second']);
  const call = await client.request('tools/call', { name: 'echo', arguments: { text: 'hi' } }, signal());
  assert.deepEqual(call.result.content, [{ type: 'text', text: 'echo: hi' }]);
  assert.equal((call.request.params!._meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
  assert.ok(server.log.every(message => !('method' in message) || message.method !== 'initialize'));
  assert.ok(client.log.some(entry => entry.direction === 'sent' && entry.text.includes('server/discover')));
  assert.deepEqual(client.stderr(), []);
  await assert.rejects(client.request('nope', {}, signal()), (error: unknown) => error instanceof McpError && error.error.code === -32601);
  for (let index = 0; index < 30; index++) await client.request('tools/list', {}, signal());
  assert.equal(client.log.length, 50);
});

test('legacy stdio servers fall back to initialize after any non-modern probe outcome', async () => {
  for (const probe of ['error', 'method', 'silent'] as const) {
    const server = new FixtureServer({ era: 'legacy', probe, legacyVersion: '2025-06-18', instructions: 'Legacy hints.' });
    const channel = new MemoryChannel(server), client = new McpClient(channel, { probeTimeoutMs: 20 });
    await client.connect(signal());
    assert.equal(client.era, 'legacy'); assert.equal(client.version, '2025-06-18'); assert.equal(client.instructions, 'Legacy hints.');
    assert.deepEqual(channel.notified.map(item => item.method), ['notifications/initialized']);
    assert.deepEqual(client.capabilities, { tools: {} });
    const call = await client.request('tools/call', { name: 'echo', arguments: { text: probe } }, signal());
    assert.equal(call.request.params!._meta, undefined); assert.match(JSON.stringify(call.result), new RegExp(probe));
  }
});

test('legacy servers can ask the client for ping and unsupported features', async () => {
  const server = new FixtureServer({ era: 'legacy', serverRequests: true });
  const client = new McpClient(new MemoryChannel(server));
  await client.connect(signal());
  await client.request('tools/call', { name: 'echo', arguments: { text: 'x' } }, signal());
  const answers = server.log.filter(message => 'id' in message && !('method' in message) && typeof message.id === 'string') as RpcResponse[];
  assert.deepEqual(answers.map(answer => answer.result ?? answer.error!.code), [{}, -32601]);
  assert.ok(client.log.some(entry => entry.direction === 'received' && entry.text.includes('sampling/createMessage')));
});

test('version negotiation: retry, dual-era downgrade, and incompatible servers', async () => {
  const retry = new ScriptedChannel([failure(-32022, { supported: ['2026-07-28'] }), result({ capabilities: { tools: {} } })]);
  const client = new McpClient(retry); await client.connect(signal());
  assert.equal(client.era, 'modern'); assert.equal(retry.sent.length, 2);
  assert.deepEqual(client.capabilities, { tools: {} }); assert.equal(client.serverInfo, undefined); assert.equal(client.instructions, '');

  const dual = new FixtureServer({ era: 'dual', supported: ['2025-11-25'] }), downgraded = new McpClient(new MemoryChannel(dual));
  await downgraded.connect(signal());
  assert.equal(downgraded.era, 'legacy'); assert.equal(downgraded.version, '2025-11-25');

  const listedOnly = new ScriptedChannel([result({ supportedVersions: ['2025-03-26'] }), result({ protocolVersion: '2025-03-26' })]);
  const fromDiscover = new McpClient(listedOnly); await fromDiscover.connect(signal());
  assert.equal(fromDiscover.version, '2025-03-26'); assert.equal((listedOnly.sent[1]!.params as Record<string, unknown>).protocolVersion, '2025-03-26');
  assert.deepEqual(fromDiscover.capabilities, {});

  await assert.rejects(new McpClient(new ScriptedChannel([failure(-32022, { supported: ['2026-07-28'] }), failure(-32022, { supported: ['2026-07-28'] })])).connect(signal()), /no mutually supported MCP version \(server supports 2026-07-28\)/);
  await assert.rejects(new McpClient(new ScriptedChannel([failure(-32022)])).connect(signal()), /server supports none/);
  await assert.rejects(new McpClient(new ScriptedChannel([result({ supportedVersions: ['3000-01-01'] })])).connect(signal()), /no mutually supported/);
  await assert.rejects(new McpClient(new ScriptedChannel([failure(-32021)])).connect(signal()), (error: unknown) => error instanceof McpError && error.error.code === -32021);
  await assert.rejects(new McpClient(new ScriptedChannel([failure(-32601), result({ protocolVersion: '1999-01-01' })])).connect(signal()), /unsupported MCP version '1999-01-01'/);
  await assert.rejects(new McpClient(new ScriptedChannel([failure(-32601), failure(-32600)])).connect(signal()), /scripted \(code -32600\)/);
  const modernOnly = new MemoryChannel(new FixtureServer()); modernOnly.legacyOnly = true;
  await assert.rejects(new McpClient(modernOnly).connect(signal()), /initialize is not supported/);
});

test('results that need client input, odd list pages and missing results are reported', async () => {
  const client = new McpClient(new ScriptedChannel([
    result({}), result({ resultType: 'input_required', inputRequests: { a: { method: 'elicitation/create' }, b: 'odd' } }), result({ resultType: 'input_required' }),
    result({ tools: 'not a list', nextCursor: '' }),
  ]));
  await client.connect(signal());
  await assert.rejects(client.request('tools/call', {}, signal()), /asked for elicitation\/create, input, which this harness does not provide/);
  await assert.rejects(client.request('tools/call', {}, signal()), /asked for input,/);
  assert.deepEqual(await client.list('tools/list', 'tools', signal()), []);
  const fixture = new McpClient(new MemoryChannel(new FixtureServer({ call: () => 'input' })));
  await fixture.connect(signal());
  await assert.rejects(fixture.request('tools/call', { name: 'echo' }, signal()), /elicitation\/create/);
});

test('cancellation: notifications on stdio and legacy transports, stream closing on modern HTTP', async () => {
  for (const [era, transport, expected] of [['modern', 'stdio', 1], ['legacy', 'http', 1], ['modern', 'http', 0]] as const) {
    const channel = new MemoryChannel(new FixtureServer({ era, call: () => 'hang' }), transport), client = new McpClient(channel);
    await client.connect(signal());
    const controller = new AbortController(), pending = client.request('tools/call', { name: 'echo', arguments: {} }, controller.signal);
    controller.abort(new Error('stopped by the user'));
    await assert.rejects(pending, /stopped by the user/);
    assert.equal(channel.notified.filter(item => item.method === 'notifications/cancelled').length, expected, `${era} ${transport}`);
  }
  const probe = new MemoryChannel(new FixtureServer({ era: 'legacy', probe: 'silent' })), aborted = new AbortController();
  const connecting = new McpClient(probe).connect(aborted.signal); aborted.abort(new Error('gone'));
  await assert.rejects(connecting, /gone/); assert.equal(probe.notified.length, 0);
  const failing = new ScriptedChannel([result({}), () => new Error('pipe closed')]); failing.notify = async () => { throw new Error('also closed'); };
  const client = new McpClient(failing); await client.connect(signal());
  const controller = new AbortController(); controller.abort(new Error('stop'));
  await assert.rejects(client.request('tools/call', {}, controller.signal), /pipe closed/);
});

test('HTTP errors during the probe: auth failures stop, 4xx fallbacks reach HTTP+SSE', async () => {
  await assert.rejects(new McpClient(new MemoryChannel(new FixtureServer(), 'http', new HttpStatusError(401, ''))).connect(signal()), /HTTP 401/);
  await assert.rejects(new McpClient(new MemoryChannel(new FixtureServer(), 'http', new HttpStatusError(404, ''))).connect(signal()), /HTTP 404/);
  await assert.rejects(new McpClient(new MemoryChannel(new FixtureServer(), 'http', new HttpStatusError(500, ''))).connect(signal()), /HTTP 500/);
  const first = new MemoryChannel(new FixtureServer(), 'http', new HttpStatusError(405, '')), legacy = new MemoryChannel(new FixtureServer({ era: 'legacy', legacyVersion: '2024-11-05' }), 'sse');
  const client = new McpClient(first, { fallback: () => legacy });
  await client.connect(signal());
  assert.equal(first.closed, true); assert.equal(client.transport, 'sse'); assert.equal(client.version, '2024-11-05');
  assert.ok(client.log.some(entry => entry.direction === 'note' && entry.text.includes('HTTP+SSE')));
  await client.close(); assert.equal(legacy.closed, true);
});

test('modern Streamable HTTP: metadata headers, Mcp-Name, Mcp-Param and JSON or SSE replies', async () => {
  for (const sse of [false, true]) {
    const tool = { name: 'weather', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } } };
    const server = new FixtureServer({ tools: [tool], resources: [{ uri: 'memo://ü', name: 'u' }] }), fetch_ = fixtureFetch(server, { sse });
    const client = new McpClient(new StreamableHttpChannel(fetch_, URL_, { authorization: 'Bearer token' }));
    await client.connect(signal());
    assert.equal(client.era, 'modern');
    await client.request('tools/call', { name: 'weather', arguments: { region: 'us-west1' } }, signal(), { 'Mcp-Param-Region': 'us-west1' });
    await client.request('resources/read', { uri: 'memo://ü' }, signal());
    const [discover, call, read] = fetch_.calls;
    assert.equal(discover!.headers['mcp-protocol-version'], '2026-07-28'); assert.equal(discover!.headers['mcp-method'], 'server/discover');
    assert.equal(discover!.headers['mcp-name'], undefined); assert.equal(discover!.headers.authorization, 'Bearer token');
    assert.equal(discover!.headers.accept, 'application/json, text/event-stream');
    assert.equal(call!.headers['mcp-name'], 'weather'); assert.equal(call!.headers['mcp-param-region'], 'us-west1');
    assert.equal(read!.headers['mcp-name'], '=?base64?bWVtbzovL8O8?=');
    assert.ok(fetch_.calls.every(item => item.headers['mcp-session-id'] === undefined));
    await client.close(); assert.equal(fetch_.calls.length, 3);
  }
});

test('legacy Streamable HTTP: rejection forms, sessions, version header, batches, server requests, expiry and DELETE', async () => {
  for (const legacyReject of ['plain', 'jsonrpc', '404', 'empty'] as const) {
    const server = new FixtureServer({ era: 'legacy', legacyVersion: '2025-06-18', resources: [{ uri: 'memo://a', name: 'a' }] }), fetch_ = fixtureFetch(server, { legacyReject });
    const client = new McpClient(new StreamableHttpChannel(fetch_, URL_));
    await client.connect(signal());
    assert.equal(client.era, 'legacy');
    assert.deepEqual((await client.list('resources/list', 'resources', signal())).map(item => item.uri), ['memo://a']);
    const last = fetch_.calls.at(-1)!;
    assert.equal(last.headers['mcp-session-id'], 'S1'); assert.equal(last.headers['mcp-protocol-version'], '2025-06-18'); assert.equal(last.headers['mcp-method'], undefined);
    await client.close(); await client.close();
    assert.equal(fetch_.calls.at(-1)!.method, 'DELETE'); assert.equal(fetch_.calls.at(-1)!.headers['mcp-session-id'], 'S1');
    assert.equal(fetch_.calls.filter(item => item.method === 'DELETE').length, 1);
  }
  const old = fixtureFetch(new FixtureServer({ era: 'legacy', legacyVersion: '2025-03-26', serverRequests: true }), { sse: true });
  const client = new McpClient(new StreamableHttpChannel(old, URL_));
  await client.connect(signal());
  await client.request('tools/call', { name: 'echo', arguments: { text: 'a' } }, signal());
  assert.equal(old.calls.at(-1)!.headers['mcp-protocol-version'], undefined);
  assert.deepEqual(old.calls.filter(item => (item.body as RpcResponse | undefined)?.id === 'srv-ping').length, 1);

  const expiring = fixtureFetch(new FixtureServer({ era: 'legacy' }), { expireAfter: 1 }), renewed = new McpClient(new StreamableHttpChannel(expiring, URL_));
  await renewed.connect(signal());
  await renewed.request('tools/list', {}, signal());
  await renewed.request('tools/list', {}, signal());
  assert.equal(expiring.calls.filter(item => (item.body as RpcRequest | undefined)?.method === 'initialize').length, 2);
  assert.equal(expiring.calls.at(-1)!.headers['mcp-session-id'], 'S2');

  const stateless = fixtureFetch(new FixtureServer({ era: 'legacy' }), { stateless: true }), plain = new McpClient(new StreamableHttpChannel(stateless, URL_));
  await plain.connect(signal()); await plain.request('tools/list', {}, signal()); await plain.close();
  assert.ok(stateless.calls.every(item => item.method === 'POST' && item.headers['mcp-session-id'] === undefined));

});

test('deprecated HTTP+SSE: endpoint discovery, responses on the stream, server requests and failures', async () => {
  const server = new FixtureServer({ era: 'legacy', legacyVersion: '2024-11-05', serverRequests: true }), fetch_ = fixtureFetch(server, { legacySse: true });
  const client = new McpClient(new StreamableHttpChannel(fetch_, URL_), { fallback: () => new LegacySseChannel(fetch_, URL_, { authorization: 'Bearer t' }) });
  await client.connect(signal());
  assert.equal(client.transport, 'sse'); assert.equal(client.version, '2024-11-05');
  const call = await client.request('tools/call', { name: 'echo', arguments: { text: 'old' } }, signal());
  assert.match(JSON.stringify(call.result), /echo: old/);
  assert.equal(fetch_.calls.find(item => item.method === 'GET')!.headers.authorization, 'Bearer t');
  assert.ok(fetch_.calls.some(item => item.url === 'http://mcp.test/messages?session=1'));
  const controller = new AbortController(), pending = client.request('tools/list', {}, controller.signal); controller.abort(new Error('cancel'));
  await assert.rejects(pending, /cancel/);
  await client.close();

  const foreign = new McpClient(new LegacySseChannel(fixtureFetch(server, { legacySse: true, endpoint: 'http://evil.test/messages' }), URL_));
  await assert.rejects(foreign.connect(signal()), /another origin/);
  const closing = new McpClient(new LegacySseChannel(fixtureFetch(new FixtureServer({ era: 'legacy', probe: 'silent' }), { legacySse: true, closeStream: true }), URL_));
  await assert.rejects(closing.connect(signal()), /SSE stream closed/);
  await assert.rejects(new McpClient(new LegacySseChannel(fixtureFetch(server, { legacySse: true, status: 403 }), URL_)).connect(signal()), /HTTP 403/);
  const refused = new LegacySseChannel(async (_url, init) => init.method === 'GET' ? fixtureFetch(server, { legacySse: true })(_url, init) : new Response('no', { status: 500 }) as unknown as McpFetchResponse, URL_);
  await assert.rejects(refused.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { signal: signal() }), /HTTP 500/);
  await assert.rejects(refused.notify({ jsonrpc: '2.0', method: 'x' }), /HTTP 500/);
  await refused.close();
});

test('Streamable HTTP protocol violations are reported', async () => {
  const reply = (body: BodyInit | null, init: ResponseInit = {}): McpFetch => async () => new Response(body, init) as unknown as McpFetchResponse;
  const request: RpcRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  await assert.rejects(new StreamableHttpChannel(reply(null), URL_).request(request, { signal: signal() }), /no JSON-RPC response/);
  await assert.rejects(new StreamableHttpChannel(reply('{"jsonrpc":"2.0","id":9,"result":{}}', { headers: { 'content-type': 'application/json' } }), URL_).request(request, { signal: signal() }), /no JSON-RPC response/);
  await assert.rejects(new StreamableHttpChannel(reply('data: {"jsonrpc":"2.0","id":9,"result":{}}\n\ndata: not json\n\n', { headers: { 'content-type': 'text/event-stream' } }), URL_).request(request, { signal: signal() }), /closed the stream without a response/);
  await assert.rejects(new StreamableHttpChannel(reply('busy', { status: 503 }), URL_).request(request, { signal: signal() }), (error: unknown) => error instanceof HttpStatusError && error.status === 503);
  await assert.rejects(new StreamableHttpChannel(reply('no', { status: 400 }), URL_).notify({ jsonrpc: '2.0', method: 'notifications/initialized' }), /HTTP 400/);
  const session = new StreamableHttpChannel(async (_url, init) => init.method === 'DELETE' ? Promise.reject(new Error('offline')) : new Response('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25"}}', { headers: { 'mcp-session-id': 'X', 'content-type': 'application/json' } }) as unknown as McpFetchResponse, URL_);
  await session.request({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { signal: signal() });
  await session.close();
  const aborted = new AbortController(); aborted.abort(new Error('early'));
  await assert.rejects(new StreamableHttpChannel(fixtureFetch(new FixtureServer()), URL_).request(request, { signal: aborted.signal }), /early/);
});

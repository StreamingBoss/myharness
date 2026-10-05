import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpStatusError, McpError, contentText, headerAnnotations, headerValue, isModernError, isRequest, isResponse, limitText, mirroredHeaders, requestMeta, resourceText, toolResultText } from '../src/mcp/protocol.js';
import { readSSE, sseEvents } from '../src/sse.js';

test('header values follow the Streamable HTTP encoding examples', () => {
  assert.equal(headerValue('us-west1'), 'us-west1');
  assert.equal(headerValue('Hello, 世界'), '=?base64?SGVsbG8sIOS4lueVjA==?=');
  assert.equal(headerValue(' padded '), '=?base64?IHBhZGRlZCA=?=');
  assert.equal(headerValue('line1\nline2'), '=?base64?bGluZTEKbGluZTI=?=');
  assert.equal(headerValue('=?base64?literal?='), '=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=');
  assert.equal(headerValue('=?base64?only-prefix'), '=?base64?only-prefix');
});

test('x-mcp-header annotations are validated and mirrored', () => {
  const schema = { type: 'object', properties: {
    region: { type: 'string', 'x-mcp-header': 'Region' },
    count: { type: 'integer', 'x-mcp-header': 'Count' },
    nested: { type: 'object', properties: { flag: { type: 'boolean', 'x-mcp-header': 'Flag' } } },
    plain: { type: 'string' },
  } };
  const annotations = headerAnnotations(schema);
  assert.deepEqual(annotations, [{ path: ['region'], name: 'Region' }, { path: ['count'], name: 'Count' }, { path: ['nested', 'flag'], name: 'Flag' }]);
  assert.deepEqual(mirroredHeaders(annotations as never, { region: 'Zürich', count: 42, nested: { flag: false }, plain: 'x' }), { 'Mcp-Param-Region': '=?base64?WsO8cmljaA==?=', 'Mcp-Param-Count': '42', 'Mcp-Param-Flag': 'false' });
  assert.deepEqual(mirroredHeaders(annotations as never, { region: null, nested: 'not an object' }), {});
  assert.deepEqual(headerAnnotations(undefined), []);
  assert.match(headerAnnotations({ 'x-mcp-header': 'Root' }) as string, /reached only through properties/);
  assert.match(headerAnnotations({ properties: { list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } } } }) as string, /reached only through properties/);
  assert.match(headerAnnotations({ properties: { a: { oneOf: [{ type: 'string', 'x-mcp-header': 'A' }] } } }) as string, /reached only/);
  assert.match(headerAnnotations({ properties: { a: { type: 'string', 'x-mcp-header': '' } } }) as string, /not a valid header name/);
  assert.match(headerAnnotations({ properties: { a: { type: 'string', 'x-mcp-header': 'Bad Name' } } }) as string, /not a valid header name/);
  assert.match(headerAnnotations({ properties: { a: { type: 'string', 'x-mcp-header': 7 } } }) as string, /not a valid header name/);
  assert.match(headerAnnotations({ properties: { a: { type: 'number', 'x-mcp-header': 'A' } } }) as string, /string, integer or boolean/);
  assert.match(headerAnnotations({ properties: { a: { type: 'string', 'x-mcp-header': 'Same' }, b: { type: 'string', 'x-mcp-header': 'same' } } }) as string, /unique/);
  assert.deepEqual(headerAnnotations({ properties: 'odd', items: [1, 'x'] }), []);
});

test('content blocks and results become model text; binary data is described', () => {
  assert.deepEqual(contentText([
    { type: 'text', text: 'hi' }, { type: 'text' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'audio', data: 'AAAAAAAA' },
    { type: 'resource_link', uri: 'file:///a', name: 'a', description: 'the a file' }, { type: 'resource_link', uri: 'file:///b' },
    { type: 'resource', resource: { uri: 'memo://x', text: 'body' } }, { type: 'resource', resource: { uri: 'memo://y', mimeType: 'image/png', blob: 'AAAA' } },
    { type: 'resource', resource: { uri: 'memo://z' } }, { type: 'mystery' }, 'not a block',
  ]), ['hi', '', '[image: image/png, 3 bytes omitted]', '[audio: unknown type, 6 bytes omitted]', '[resource link: file:///a (a) — the a file]', '[resource link: file:///b]',
    '[resource memo://x]\nbody', '[resource memo://y]\n[binary content: image/png, 3 bytes omitted]', '[resource memo://z]\n[binary content: unknown type, 0 bytes omitted]', '[unsupported content type: mystery]', '[unsupported content type: undefined]']);
  assert.equal(toolResultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(toolResultText({ content: [], structuredContent: { temperature: 21 } }), '{"temperature":21}');
  assert.equal(toolResultText({}), '(no content)');
  assert.equal(toolResultText({ content: [{ type: 'text', text: 'bad input' }], isError: true }), 'error: bad input');
  assert.equal(resourceText({ contents: [{ uri: 'memo://a', text: 'x' }] }), '[resource memo://a]\nx');
  assert.equal(resourceText({}), '(empty resource)');
  assert.equal(resourceText({ contents: ['odd'] }), '[resource undefined]\n[binary content: unknown type, 0 bytes omitted]');
  assert.equal(limitText('abcdef', 3), 'abc\n[output truncated: 6 characters in total]');
  assert.equal(limitText('abc', 3), 'abc');
});

test('JSON-RPC helpers recognize messages, modern errors and metadata', () => {
  assert.equal(isModernError({ code: -32022, message: '' }), true);
  assert.equal(isModernError({ code: -32099, message: '' }), true);
  assert.equal(isModernError({ code: -32019, message: '' }), false);
  assert.equal(isModernError({ code: -32601, message: '' }), false);
  assert.equal(isModernError(undefined), false);
  assert.equal(isResponse({ jsonrpc: '2.0', id: 1, result: {} }), true);
  assert.equal(isResponse({ jsonrpc: '2.0', id: 1, method: 'x', result: {} }), false);
  assert.equal(isResponse({ jsonrpc: '2.0', id: 1 }), false);
  assert.equal(isRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }), true);
  assert.equal(isRequest({ jsonrpc: '2.0', id: null, method: 'ping' }), false);
  assert.equal(isRequest({ jsonrpc: '2.0', method: 'notifications/x' }), false);
  assert.deepEqual(Object.keys(requestMeta('2026-07-28')), ['io.modelcontextprotocol/protocolVersion', 'io.modelcontextprotocol/clientInfo', 'io.modelcontextprotocol/clientCapabilities']);
  assert.equal(new McpError({ code: -32602, message: 'bad' }).message, 'bad (code -32602)');
  assert.equal(new HttpStatusError(404, '').message, 'HTTP 404');
  assert.equal(new HttpStatusError(400, ' nope \n').message, 'HTTP 400: nope');
});

test('raw SSE events keep event names, comments and a final unterminated event', async () => {
  const events = [];
  for await (const event of sseEvents(new Response('event: endpoint\ndata: /messages\n\n: comment\n\ndata: {"a":1}\n\ndata: tail'))) events.push(event);
  assert.deepEqual(events, [{ event: 'endpoint', data: '/messages' }, { event: '', data: '{"a":1}' }, { event: '', data: 'tail' }]);
  const parsed = [];
  for await (const event of readSSE(new Response('data:\n\ndata: {"type":"x"}\n\n'))) parsed.push(event);
  assert.deepEqual(parsed, [{ type: 'x', event_type: 'x' }]);
});

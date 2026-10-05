import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudAdapter, type CloudProvider } from '../src/cloud.js';
import { readSSE } from '../src/sse.js';
import { LegacyModelAdapter, legacyEvents, validateCalls, validateToolBatch } from '../src/model.js';
import { ProviderRouter, configuredModel, modelConfiguration, providerName } from '../src/providers.js';
import type { ModelRequest, ChatMessage } from '../src/core.js';
import type { ModelEvent } from '../src/model.js';
import type { FetchLike } from '../src/ollama.js';
import { TOOLS } from '../src/tools.js';

export const request = (provider: string = 'gemini'): ModelRequest => ({ provider, model: 'test-model', messages: [{ role: 'system', content: 'Be clear' }, { role: 'user', content: 'hello' }], stream: true, options: { num_ctx: 8192 }, tools: TOOLS.slice(0, 2) });
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const value of source) result.push(value); return result; }
export function sse(events: unknown[], split = 11): Response {
  const bytes = new TextEncoder().encode(events.map(value => 'data: ' + JSON.stringify(value) + '\r\n\r\n').join(''));
  return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += split) controller.enqueue(bytes.slice(offset, offset + split)); controller.close(); } }));
}
export function response(provider: CloudProvider, content = 'héllo 🌍', calls: unknown[] = []): Record<string, unknown> {
  if (provider === 'gemini') return { status: 'completed', steps: [{ type: 'thought', summary: [{ text: 'reason' }], signature: 'signed' }, { type: 'model_output', content: [{ type: 'text', text: content }] }, ...calls], usage: { total_input_tokens: 12, total_output_tokens: 7, total_cached_tokens: 4, total_thought_tokens: 3 } };
  if (provider === 'openai') return { status: 'completed', output: [{ type: 'reasoning', summary: [{ text: 'reason' }], encrypted_content: 'signed' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }, ...calls], usage: { input_tokens: 12, output_tokens: 7, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } } };
  return { stop_reason: calls.length ? 'tool_use' : 'end_turn', content: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }, { type: 'text', text: content }, ...calls], usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 4 } };
}
export const call = (provider: CloudProvider, id = 'a', name = 'pwd', args: unknown = {}) => provider === 'anthropic' ? { type: 'tool_use', id, name, input: args } : { type: 'function_call', id, call_id: id, name, arguments: provider === 'openai' ? JSON.stringify(args) : args };
export const completeEvent = (provider: CloudProvider, data: unknown) => provider === 'gemini' ? [{ event_type: 'interaction.completed', interaction: data }] : provider === 'openai' ? [{ type: 'response.completed', response: data }] : [{ type: 'message_start', message: data }, ...(data as { content: unknown[] }).content.map((content_block, index) => ({ type: 'content_block_start', index, content_block })), { type: 'message_stop' }];

for (const provider of ['gemini', 'openai', 'anthropic'] as const) {
  test(`${provider}: native requests, stateless replay, same-name call IDs and measured usage`, async () => {
    const sent: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    const raw = response(provider, 'héllo 🌍', [call(provider, 'a'), call(provider, 'b')]);
    const adapter = new CloudAdapter(provider, async (url, init) => { sent.push({ url, init }); return init.method === 'GET' ? new Response('{}') : JSON.parse(init.body!).stream ? sse(completeEvent(provider, raw)) : Response.json(raw); }, 'private-key');
    assert.equal(adapter.ready(), true);
    assert.equal((await adapter.describe('test-model')).provider, provider);
    const input = request(provider), events = await collect(adapter.stream(input));
    const result = (events.at(-1) as Extract<ModelEvent, { type: 'completed' }>).result;
    assert.equal(result.message.content, 'héllo 🌍'); assert.equal(result.thinking, 'reason'); assert.equal(result.status, 'completed');
    assert.equal(result.usage.input, 12); assert.equal(result.usage.output, 7); assert.equal(result.usage.cached, 4);
    assert.deepEqual(result.message.tool_calls!.map(c => c.id), ['a', 'b']);
    input.messages.push(result.message, { role: 'tool', tool_call_id: 'a', tool_name: 'pwd', content: '[trimmed]' }, { role: 'tool', tool_call_id: 'b', tool_name: 'pwd', content: 'second' });
    const wire = adapter.prepare(input), json = JSON.stringify(wire); assert.match(json, /signed/); assert.match(json, /\[trimmed\]/); assert.match(json, /second/); assert.ok(!json.includes('private-key'));
    if (provider !== 'anthropic') assert.equal(wire.store, false);
    else assert.equal((wire.messages as { content: unknown[] }[]).at(-1)!.content.length, 2);
    assert.equal((await adapter.complete(input)).message.content, 'héllo 🌍');
    assert.equal((await adapter.inspectTokens(input)).fidelity, 'unavailable');
    assert.equal(adapter.requestMetadata(input).provider, provider);
    assert.ok(sent.every(s => !s.url.includes('private-key'))); assert.ok(sent.some(s => JSON.stringify(s.init.headers).includes('private-key')));
    const noTools = { ...input }; delete noTools.tools; assert.ok(!adapter.prepare(noTools).tools);
    const plain: ModelRequest = { ...request(provider), messages: [{ role: 'assistant', content: 'old' }, { role: 'user', content: 'new' }], options: { num_ctx: 8192, num_predict: 30 } }; assert.match(JSON.stringify(adapter.prepare(plain)), /old/);
    for (const message of [{ role: 'tool', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'pwd' } }] }, { role: 'assistant', content: '', continuation: { provider: 'wrong', items: [] } }] as ChatMessage[]) assert.throws(() => adapter.prepare({ ...input, messages: [message] }), /missing|another provider/);
    // Exhaustion/refusal/unknown finish reasons never authorize tools.
    for (const [reason, expected] of [['max_tokens', 'length'], ['blocked', 'blocked'], ['unknown', 'failed'], ['stop_sequence', 'completed']] as const) {
      const data = { ...raw, ...(provider === 'anthropic' ? { stop_reason: reason } : { status: reason }) };
      const port = new CloudAdapter(provider, async () => Response.json(data), 'key'); assert.equal((await port.complete(request(provider))).status, expected);
    }
    const empty = new CloudAdapter(provider, async () => Response.json(provider === 'anthropic' ? { stop_reason: 'end_turn' } : { status: 'completed' }), 'key'); assert.equal((await empty.complete(request(provider))).message.content, '');
    for (const broken of [call(provider, ''), call(provider, 'a', '', {}), call(provider, 'a', 'pwd', [])]) {
      const port = new CloudAdapter(provider, async () => Response.json(response(provider, '', [broken])), 'key'); await assert.rejects(port.complete(request(provider)), /ID|arguments/);
    }
  });
}

test('OpenAI fragmented tool arguments and reasoning deltas preserve final output ordering', async () => {
  const events = [
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'b', name: 'pwd' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'read_file' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' },
    { type: 'response.output_text.delta', delta: 'é' }, { type: 'response.reasoning_summary_text.delta', delta: 'why' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"README.md"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'a', name: 'read_file' } },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ];
  const adapter = new CloudAdapter('openai', async () => sse(events, 1), 'key');
  const result = await collect(adapter.stream(request('openai'))); assert.equal(result[0]!.type, 'delta');
  const final = result.at(-1) as Extract<ModelEvent, { type: 'completed' }>;
  assert.deepEqual(final.result.message.tool_calls!.map(c => c.id), ['a', 'b']); assert.equal(final.result.message.tool_calls![0]!.function.arguments!.path, 'README.md');
  const incomplete = new CloudAdapter('openai', async () => sse([{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }]), 'key');
  assert.equal(((await collect(incomplete.stream(request()))).at(-1) as typeof final).result.status, 'length');
});

test('Gemini fragmented steps, thought signatures and final step replacement', async () => {
  const events = [
    { event_type: 'step.start', index: 0, step: { type: 'thought', summary: [] } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'why' } } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'signature' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [{ type: 'text', text: 'first' }] } },
    { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'é' } },
    { event_type: 'step.start', index: 2, step: { type: 'function_call', id: 'a', name: 'read_file' } },
    { event_type: 'step.delta', index: 2, delta: { type: 'arguments', partial_arguments: '{"path":"a"}' } },
    { event_type: 'step.stop', index: 1, step: { type: 'model_output', content: [{ type: 'text', text: 'firsté' }] } },
    { event_type: 'interaction.complete', interaction: { status: 'requires_action' } },
  ];
  const adapter = new CloudAdapter('gemini', async () => sse(events), 'key'), result = await collect(adapter.stream(request()));
  const final = result.at(-1) as Extract<ModelEvent, { type: 'completed' }>;
  assert.equal(final.result.message.content, 'firsté'); assert.equal(final.result.thinking, 'why'); assert.equal(final.result.message.continuation!.items[0]!.signature, 'signature');
  assert.equal(final.result.message.tool_calls![0]!.function.arguments!.path, 'a');
  const bad = new CloudAdapter('gemini', async () => sse([{ event_type: 'step.delta', delta: { type: 'text' } }]), 'key'); await assert.rejects(collect(bad.stream(request())), /matching step/);
});

test('Claude fragmented blocks, signatures, usage updates and stop reason', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'why' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Hi' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'é' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'a', name: 'pwd', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
  ];
  const adapter = new CloudAdapter('anthropic', async () => sse(events), 'key'), result = await collect(adapter.stream(request('anthropic')));
  const final = result.at(-1) as Extract<ModelEvent, { type: 'completed' }>;
  assert.equal(final.result.message.content, 'Hié'); assert.equal(final.result.thinking, 'why'); assert.deepEqual(final.result.usage, { input: 5, output: 4 });
  assert.equal(final.result.message.continuation!.items[0]!.signature, 'signature');
  const bad = new CloudAdapter('anthropic', async () => sse([{ type: 'content_block_delta', delta: {} }]), 'key'); await assert.rejects(collect(bad.stream(request())), /matching content block/);
});

test('provider failures, cancellation and partial streams never complete or disclose response errors', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const port = new CloudAdapter('openai', async () => new Response('secret-key', { status, headers: { 'retry-after': '12' } }), 'secret-key');
    await assert.rejects(port.describe('model'), error => /HTTP/.test(String(error)) && !String(error).includes('secret-key'));
  }
  const noHeader = new CloudAdapter('openai', async () => ({ ok: false, status: 429, body: null, json: async () => ({}) }), 'key'); await assert.rejects(noHeader.describe('m'), /Quota/);
  const missing = new CloudAdapter('openai', fetch, ''); assert.equal(missing.ready(), false); await assert.rejects(missing.describe('m'), /API key/);
  const network = new CloudAdapter('gemini', async () => { throw new Error('secret-key'); }, 'secret-key'); await assert.rejects(network.describe('m'), /network/);
  const stopped = new AbortController(); stopped.abort(); await assert.rejects(network.describe('m', stopped.signal), /stopped/);
  for (const provider of ['gemini', 'openai', 'anthropic'] as const) {
    const incomplete = new CloudAdapter(provider, async () => sse([]), 'key'); await assert.rejects(collect(incomplete.stream(request(provider))), /before completion/);
    const failed = new CloudAdapter(provider, async () => sse([{ event_type: 'error', error: { message: 'secret-key' } }]), 'secret-key'); await assert.rejects(collect(failed.stream(request(provider))), error => !String(error).includes('secret-key'));
  }
});

test('SSE handles named events, multiline data, comments, DONE, EOF and malformed streams', async () => {
  const result = await collect(readSSE(new Response('event: custom\r\ndata: {"value":\r\ndata: 1}\r\n:comment\r\n\r\ndata: [DONE]\n\ndata: {"type":"last"}')));
  assert.deepEqual(result, [{ value: 1, event_type: 'custom' }, { type: 'last', event_type: 'last' }]);
  await assert.rejects(collect(readSSE(new Response('data: []\n\n'))), /Invalid/);
  await assert.rejects(collect(readSSE(new Response(null))), /no response body/);
});

test('compatibility adapter and registry preserve injected models and reject invalid selections', async () => {
  const port = { async *streamChat() { yield JSON.stringify({ message: { content: 'a' }, done: true }); }, async request() { return { message: { role: 'assistant' as const, content: 'summary' } }; } };
  const legacy = new LegacyModelAdapter(port); assert.equal(legacy.ready(), true); assert.equal((await legacy.describe('x')).provider, 'ollama');
  assert.equal((await legacy.complete(request())).status, 'completed'); assert.equal((await collect(legacy.stream(request()))).length, 2);
  assert.equal(legacy.prepare(request()).model, 'test-model'); assert.deepEqual(legacy.requestMetadata(request()), {}); assert.equal((await legacy.inspectTokens(request())).fidelity, 'unavailable');
  const none = new LegacyModelAdapter({ streamChat: port.streamChat }); await assert.rejects(none.describe('x')); await assert.rejects(none.complete(request()));
  const length = new LegacyModelAdapter({ ...port, request: async () => ({ message: { content: '' }, done_reason: 'length' }) }); assert.equal((await length.complete(request())).status, 'length');
  const bad = new LegacyModelAdapter({ ...port, request: async () => ({}) }); await assert.rejects(bad.complete(request()), /invalid summary/);
  const router = new ProviderRouter(fetch, { ollama: port }); assert.equal(router.ready('ollama'), true); assert.equal(router.ready('vertex'), false);
  router.setKey('gemini', 'key'); assert.equal(router.ready('gemini'), true); router.forget('gemini'); assert.equal(router.ready('gemini'), false);
  router.setLegacy('demo', port); router.selected = 'demo'; assert.equal((await router.describe('x')).provider, 'ollama');
  const input = request(); delete input.provider; assert.equal(router.prepare(input).model, 'test-model'); assert.equal((await router.complete(input)).message.content, 'summary'); await collect(router.stream(input));
  assert.deepEqual(router.requestMetadata(input), {}); assert.equal((await router.inspectTokens(input)).fidelity, 'unavailable');
  assert.equal(configuredModel('demo'), 'scripted-demo'); assert.equal(configuredModel('ollama'), 'qwen3:8b'); assert.equal(configuredModel('gemini'), 'gemini-3.8-flash'); assert.equal(configuredModel('openai', 'custom'), 'custom');
  for (const name of ['openai', 'anthropic', 'vertex'] as const) assert.throws(() => configuredModel(name));
  assert.throws(() => configuredModel('gemini', 'bad/model')); assert.throws(() => providerName('unknown'));
  assert.deepEqual(modelConfiguration({ mode: 'demo' }), { mode: 'demo' });
  for (const value of [{}, { provider: 'gemini', apiKey: 3 }, { mode: 'demo', model: 3 }, { mode: 'demo', contextLength: 0 }, { mode: 'demo', maxOutputTokens: 1.5 }]) assert.throws(() => modelConfiguration(value));
  validateCalls([{ function: { name: 'pwd' } }]); assert.throws(() => validateCalls([{ id: 'a', function: { name: 'pwd' } }, { id: 'a', function: { name: 'pwd' } }]));
  await collect(legacyEvents((async function* () { yield JSON.stringify({ message: { thinking: 'thought', tool_calls: [{ function: { name: 'pwd' } }], provider_parts: [{}] }, done: true, done_reason: 'length' }); })()));
});

test('invalid JSON, missing terminal events and unknown usage fail safely', async () => {
  await assert.rejects(collect(readSSE(new Response('data: PRIVATE\n\n'))), /Invalid provider stream/);
  await assert.rejects(collect(legacyEvents((async function* () { yield JSON.stringify({ message: { tool_calls: [{ function: { name: 'pwd' } }] } }); })())), /before completion/);
  const malformed = new CloudAdapter('openai', async () => Response.json(response('openai', '', [{ type: 'function_call', call_id: 'a', name: 'pwd', arguments: 'PRIVATE' }])), 'key');
  await assert.rejects(malformed.complete(request()), /Invalid tool arguments/);
  const optional = new CloudAdapter('gemini', async () => Response.json({ status: 'completed', steps: [{ type: 'function_call', id: 'a', name: 'pwd' }] }), 'key');
  assert.deepEqual((await optional.complete(request())).message.tool_calls![0]!.function.arguments, {});
  const port = { provider: 'ollama', async *streamChat() {}, requestMetadata: () => ({ wire_request: { model: 'prepared' } }), async request() { return { template: 'template', parameters: 'parameters' }; }, async inspectTokens(input: ModelRequest) { return { model: input.model, provider: 'ollama', fidelity: 'unavailable' as const, source: 'test', explanation: '', coverage: '', limitations: [], groups: [] }; } };
  const legacy = new LegacyModelAdapter(port); assert.equal(legacy.prepare(request()).model, 'prepared');
  const router = new ProviderRouter(async () => Response.json({}), { ollama: port });
  assert.equal((await router.inspectTokens({ ...request(), provider: 'ollama' })).source, 'test');
  assert.ok(router.requestMetadata({ ...request(), provider: 'gemini' }).wire_request);
  assert.equal((await router.inspectTokens({ ...request(), provider: 'gemini' })).fidelity, 'unavailable');
});


test('whole tool batches validate required and optional arguments before effects', () => {
  const definitions = [{ type: 'function' as const, function: { name: 'edit', description: '', parameters: { required: ['path'], properties: { path: { type: 'string' }, count: { type: 'integer' } } } } }];
  validateToolBatch([{ function: { name: 'edit', arguments: { path: 'file', count: 1, extra: true } } }], definitions);
  assert.throws(() => validateToolBatch([{ function: { name: 'edit' } }], definitions), /Missing required argument 'path' for tool 'edit'/);
  for (const args of [{}, { path: 3 }, { path: 'file', count: 1.5 }]) assert.throws(() => validateToolBatch([{ function: { name: 'edit', arguments: args } }], definitions), /argument.*tool 'edit'/);
  assert.throws(() => validateToolBatch([{ function: { name: 'unknown' } }], definitions));
  validateToolBatch([{ function: { name: 'empty' } }, { function: { name: 'empty', arguments: { extra: true } } }], [{ type: 'function', function: { name: 'empty', description: '', parameters: {} } }]);
});

test('Gemini documented arguments_delta fragments survive a partial completion resource', async () => {
  const events = [
    { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'read', name: 'read_file', arguments: {} } },
    { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"path":' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '"README.md"}' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'interaction.completed', interaction: { status: 'requires_action' } },
  ];
  const adapter = new CloudAdapter('gemini', async () => sse(events, 1), 'key');
  const result = (await collect(adapter.stream(request()))).at(-1) as Extract<ModelEvent, { type: 'completed' }>;
  assert.deepEqual(result.result.message.tool_calls![0]!.function.arguments, { path: 'README.md' });
  validateToolBatch(result.result.message.tool_calls!, TOOLS);
  const replay = adapter.prepare({ ...request(), messages: [result.result.message, { role: 'tool', tool_name: 'read_file', tool_call_id: 'read', content: 'hello' }] });
  assert.match(JSON.stringify(replay), /README.md/);
});

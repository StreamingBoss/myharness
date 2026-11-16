import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatCompletionsAdapter, customEndpoint } from '../src/chat-completions.js';
import { ProviderRouter, configuredModel, providerName } from '../src/providers.js';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { loadHarness } from '../src/node/startup.js';
import { explainError } from '../src/error-messages.js';
import { fixture } from './browser-fixture.js';
import { collect, request, sse } from './cloud.test.js';
import type { FetchLike } from '../src/ollama.js';

type Init = Parameters<FetchLike>[1];
const usage = { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } };
const toolCall = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
export const completion = (content: string, calls: unknown[] = [], extra: Record<string, unknown> = {}) =>
  ({ choices: [{ message: { role: 'assistant', content, reasoning: 'reason', ...(calls.length ? { tool_calls: calls } : {}), ...extra }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage });
/** The same completion as Chat Completions stream chunks, split the way OpenRouter sends them. */
export function chunks(content: string, calls: { id: string; name: string; args: unknown }[] = []): unknown[] {
  return [
    { choices: [{ delta: { role: 'assistant', reasoning: 'rea' } }] },
    { choices: [{ delta: { reasoning: 'son', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'rea' }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'son', signature: 'signed' }] } }] },
    ...(content ? [{ choices: [{ delta: { content } }] }] : []),
    ...calls.flatMap((call, index) => { const args = JSON.stringify(call.args); return [
      { choices: [{ delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: args.slice(0, 3) } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(3) } }] } }] },
    ]; }),
    { choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] },
    { choices: [{ delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage },
  ];
}
function done(events: unknown[]): Response {
  const response = sse(events), body = response.body!.pipeThrough(new TransformStream({ flush(controller) { controller.enqueue(new TextEncoder().encode(': OPENROUTER PROCESSING\n\ndata: [DONE]\n\n')); } }));
  return new Response(body);
}

test('openrouter: Chat Completions body, streamed reasoning, tool-call IDs, replay and usage', async () => {
  const sent: { url: string; init: Init }[] = [];
  const adapter = new ChatCompletionsAdapter('openrouter', async (url, init) => {
    sent.push({ url, init });
    if (init.method === 'GET') return Response.json({ data: {} });
    return JSON.parse(init.body!).stream ? done(chunks('héllo 🌍', [{ id: 'a', name: 'pwd', args: {} }, { id: 'b', name: 'pwd', args: { x: 1 } }])) : Response.json(completion('whole', [toolCall('a', 'pwd', {})]));
  }, 'private-key');
  assert.equal(adapter.ready(), true);
  const body = adapter.prepare(request('openrouter'));
  assert.deepEqual(Object.keys(body), ['model', 'messages', 'stream', 'max_tokens', 'tools']);
  assert.deepEqual((body.messages as unknown[])[0], { role: 'system', content: 'Be clear' });
  assert.equal(body.max_tokens, 2048); assert.equal(adapter.prepare({ ...request('openrouter'), tools: [], options: { num_ctx: 1, num_predict: 9 } }).max_tokens, 9);
  assert.equal(adapter.prepare({ ...request('openrouter'), tools: [] }).tools, undefined);
  assert.deepEqual(adapter.requestMetadata(request('openrouter')), { provider: 'openrouter', wire_request: body });

  const events = await collect(adapter.stream(request('openrouter')));
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => [e.content, e.thinking]), [['', 'rea'], ['', 'son'], ['héllo 🌍', '']]);
  const result = (events.at(-1) as { result: import('../src/model.js').ModelResult }).result;
  assert.equal(result.status, 'completed'); assert.equal(result.thinking, 'reason'); assert.equal(result.message.content, 'héllo 🌍');
  assert.deepEqual(result.message.tool_calls, [{ id: 'a', function: { name: 'pwd', arguments: {} } }, { id: 'b', function: { name: 'pwd', arguments: { x: 1 } } }]);
  assert.deepEqual(result.usage, { input: 12, output: 7, cached: 4, reasoning: 3 });
  const replay = result.message.continuation!.items[0]!;
  assert.deepEqual(replay.reasoning_details, [{ type: 'reasoning.text', index: 0, text: 'reason', signature: 'signed' }]);
  assert.equal(sent[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent[0]!.init.headers!.authorization, 'Bearer private-key'); assert.equal(sent[0]!.init.headers!['x-openrouter-title'], 'MyHarness');
  assert.ok(!sent[0]!.init.body!.includes('private-key'));

  // Stateless replay: the assistant turn goes back exactly as returned, followed by the tool results.
  const next = { ...request('openrouter'), messages: [...request('openrouter').messages, result.message, { role: 'tool' as const, tool_name: 'pwd', tool_call_id: 'a', content: '/work' }] };
  const messages = adapter.prepare(next).messages as Record<string, unknown>[];
  assert.deepEqual(messages[2], replay); assert.deepEqual(messages[3], { role: 'tool', tool_call_id: 'a', content: '/work' });

  const whole = await adapter.complete(request('openrouter'));
  assert.equal(whole.message.content, 'whole'); assert.equal(whole.thinking, 'reason'); assert.equal(JSON.parse(sent.at(-1)!.init.body!).stream, false);
  assert.equal(whole.message.continuation!.items[0]!.reasoning_details, undefined);
  const detailed = new ChatCompletionsAdapter('openrouter', async () => Response.json(completion('x', [], { reasoning_details: [{ type: 'reasoning.encrypted', data: 'sealed' }] })), 'key');
  assert.deepEqual((await detailed.complete(request('openrouter'))).message.continuation!.items[0]!.reasoning_details, [{ type: 'reasoning.encrypted', data: 'sealed' }]);
  assert.equal((await adapter.inspectTokens(request('openrouter'))).fidelity, 'unavailable');
});

test('openrouter: reasoning fragments merge by index and type; unindexed ones stay separate', async () => {
  const adapter = new ChatCompletionsAdapter('openrouter', async () => done([
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', index: 0, summary: 'a' }, { type: 'reasoning.encrypted', data: 'x' }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', index: 0, summary: 'b', format: 'f' }, { type: 'reasoning.encrypted', data: 'y' }, { type: 'reasoning.text', index: 0, text: 't' }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { name: 'pwd' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'late', function: {} }] } }] },
    { choices: [{ finish_reason: 'tool_calls' }] },
  ]), 'key');
  const result = (await collect(adapter.stream(request('openrouter')))).at(-1) as { result: import('../src/model.js').ModelResult };
  assert.deepEqual(result.result.message.continuation!.items[0]!.reasoning_details, [{ type: 'reasoning.summary', index: 0, summary: 'ab', format: 'f' }, { type: 'reasoning.encrypted', data: 'x' }, { type: 'reasoning.encrypted', data: 'y' }, { type: 'reasoning.text', index: 0, text: 't' }]);
  // A call without arguments is an empty object; it is replayed as "{}".
  assert.deepEqual(result.result.message.tool_calls, [{ id: 'late', function: { name: 'pwd', arguments: {} } }]);
  assert.equal((result.result.message.continuation!.items[0]!.tool_calls as { function: { arguments: string } }[])[0]!.function.arguments, '{}');
  assert.deepEqual(result.result.usage, {});
  // A plain answer: no reasoning details, and usage in a final chunk that carries no choice.
  const plain = new ChatCompletionsAdapter('openrouter', async () => done([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }, { usage }]), 'key');
  const answer = (await collect(plain.stream(request('openrouter')))).at(-1) as { result: import('../src/model.js').ModelResult };
  assert.deepEqual(answer.result.message.continuation!.items, [{ role: 'assistant', content: 'x' }]); assert.equal(answer.result.usage.input, 12);
  const untooled = request('openrouter'); delete untooled.tools; assert.equal(plain.prepare(untooled).tools, undefined);
});

test('openrouter: finish reasons, broken calls, stream failures and HTTP errors fail safely', async () => {
  for (const [reason, status] of [['length', 'length'], ['content_filter', 'blocked'], ['error', 'failed'], [undefined, 'failed']] as const) {
    const port = new ChatCompletionsAdapter('openrouter', async () => Response.json({ choices: [{ message: { content: 'x' }, finish_reason: reason }] }), 'key');
    assert.equal((await port.complete(request('openrouter'))).status, status);
  }
  assert.equal((await new ChatCompletionsAdapter('openrouter', async () => Response.json({}), 'key').complete(request('openrouter'))).message.content, '');
  for (const broken of [{ type: 'function', function: { name: 'pwd', arguments: '{}' } }, toolCall('a', 'pwd', []), { id: 'a', function: { name: 'pwd', arguments: 'PRIVATE' } }, { id: 'a', function: { arguments: '{}' } }]) {
    await assert.rejects(new ChatCompletionsAdapter('openrouter', async () => Response.json(completion('', [broken])), 'key').complete(request('openrouter')), /ID|arguments/);
  }
  await assert.rejects(new ChatCompletionsAdapter('openrouter', async () => Response.json(completion('', [toolCall('a', 'pwd', {}), toolCall('a', 'pwd', {})])), 'key').complete(request('openrouter')), /duplicate/);
  await assert.rejects(collect(new ChatCompletionsAdapter('openrouter', async () => done([{ choices: [{ delta: { content: 'x' } }] }]), 'key').stream(request('openrouter'))), /before completion/);
  await assert.rejects(collect(new ChatCompletionsAdapter('openrouter', async () => done([{ error: { message: 'secret-key' }, choices: [{ finish_reason: 'error' }] }]), 'secret-key').stream(request('openrouter'))), error => !String(error).includes('secret-key') && /generation failed/.test(String(error)));
  for (const [status, reason] of [[401, /API key/], [403, /API key/], [402, /credits.*:free/], [404, /model ID/], [429, /rate limit/], [500, /availability/]] as const) {
    await assert.rejects(new ChatCompletionsAdapter('openrouter', async () => new Response('secret-key', { status }), 'secret-key').describe('a/b'), error => !String(error).includes('secret-key') && reason.test(String(error)) && String(error).includes(`HTTP ${status}`));
  }
  // A browser's native fetch throws when called as a method of another object: the adapter must call it detached.
  const native = function (this: unknown) { if (this !== undefined) throw new TypeError('Illegal invocation'); return Promise.resolve(Response.json({})); } as unknown as FetchLike;
  assert.equal((await new ChatCompletionsAdapter('openrouter', native, 'key').describe('a/b')).ready, true);
  await assert.rejects(new ChatCompletionsAdapter('openrouter', fetch, ' ').describe('a/b'), /API key for openrouter/);
  await assert.rejects(new ChatCompletionsAdapter('openrouter', async () => { throw new Error('secret-key'); }, 'secret-key').describe('a/b'), error => /Could not connect to openrouter/.test(String(error)) && !String(error).includes('secret-key'));
  assert.match(explainError('Could not connect to openrouter. Check')!.message, /could not be reached/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new ChatCompletionsAdapter('openrouter', async () => { throw new Error('aborted'); }, 'key').describe('a/b', controller.signal), /stopped by the user/);
  // Messages that do not belong to this provider's native history are refused, never guessed.
  const adapter = new ChatCompletionsAdapter('openrouter', fetch, 'key'), base = request('openrouter').messages;
  assert.throws(() => adapter.prepare({ ...request('openrouter'), messages: [...base, { role: 'assistant', content: '', continuation: { provider: 'openai', items: [] } }] }), /another provider/);
  assert.throws(() => adapter.prepare({ ...request('openrouter'), messages: [...base, { role: 'tool', content: 'x' }] }), /call ID/);
  assert.throws(() => adapter.prepare({ ...request('openrouter'), messages: [...base, { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'pwd', arguments: {} } }] }] }), /Native tool history/);
});

test('openrouter: model list keeps tool-capable models, describe checks key and model, IDs keep the vendor', async () => {
  const urls: string[] = [];
  const adapter = new ChatCompletionsAdapter('openrouter', async (url, init) => {
    urls.push(url); assert.equal(init.method, 'GET'); assert.equal(init.headers!.authorization, 'Bearer private');
    return Response.json({ data: [{ id: 'z/model', name: 'Zed' }, { id: 'a/model:free' }, { id: 'a/model:free' }, { id: '' }, null] });
  }, 'private');
  assert.deepEqual(await adapter.listModels(), [{ id: 'a/model:free', label: 'a/model:free' }, { id: 'z/model', label: 'Zed' }]);
  assert.equal(urls[0], 'https://openrouter.ai/api/v1/models?supported_parameters=tools');
  assert.deepEqual(await new ChatCompletionsAdapter('openrouter', async () => Response.json({}), 'private').listModels(), []);
  const description = await adapter.describe('deepseek/deepseek-chat:free');
  assert.deepEqual(urls.slice(-2), ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/models/deepseek/deepseek-chat%3Afree/endpoints']);
  assert.equal(description.provider, 'openrouter'); assert.ok(urls.every(url => !url.includes('private')));

  assert.equal(providerName('openrouter'), 'openrouter');
  assert.equal(configuredModel('openrouter', 'openai/gpt-5'), 'openai/gpt-5'); assert.equal(configuredModel('openrouter', 'deepseek/deepseek-chat:free'), 'deepseek/deepseek-chat:free');
  for (const bad of [undefined, 'a b', '/a', 'a/', 'a//b', 'a?b', 'a#b']) assert.throws(() => configuredModel('openrouter', bad), /model ID/);
  assert.throws(() => configuredModel('openai', 'a/b'), /model ID/);
  const router = new ProviderRouter(fetch, {}, 'openrouter', { openrouter: 'env-key' });
  assert.equal(router.ready('openrouter'), true); router.forget('openrouter'); assert.equal(router.ready('openrouter'), false);
  assert.ok(router.adapter('openrouter', 'given') instanceof ChatCompletionsAdapter);
});

test('openrouter: full headless loop keeps approvals and IDs in the harness and keys out of sessions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'openrouter-harness-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'README.md'), 'hello');
  const bodies: Record<string, unknown>[] = []; let first = true;
  const adapter = new ChatCompletionsAdapter('openrouter', async (_url, init) => {
    if (init.method === 'GET') return Response.json({});
    const body = JSON.parse(init.body!); bodies.push(body);
    const reply = first ? done(chunks('', [{ id: 'read', name: 'read_file', args: { path: 'README.md' } }, { id: 'write', name: 'write_file', args: { path: 'draft.txt', content: 'draft' } }])) : done(chunks('done'));
    first = false; return reply;
  }, 'SECRET');
  const harness = new NodeHarness({ workspace: root, model: 'vendor/model', contextLength: 8192, provider: 'openrouter', maxOutputTokens: 2048, modelAdapter: adapter, sessions: new SessionStore(path.join(root, 'sessions')) });
  await harness.initialize();
  const events = [];
  for await (const event of harness.submit({ message: 'Inspect', useMemory: true, tools: ['read_file', 'write_file'], askApproval: true, agent: '', prompt: '' })) { events.push(event); if (event.type === 'approval') harness.approve(String(event.id), true); }
  assert.equal(bodies.length, 2); assert.equal(events.filter(e => e.type === 'tool').length, 2);
  assert.equal(await readFile(path.join(root, 'draft.txt'), 'utf8'), 'draft');
  const replayed = (bodies[1]!.messages as Record<string, unknown>[]);
  assert.deepEqual(replayed.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['read', 'write']);
  assert.ok(replayed.some(m => Array.isArray(m.reasoning_details)));
  assert.equal(harness.inspect().provider, 'openrouter');
  assert.ok(!JSON.stringify(harness.activeSessionRecord()).includes('SECRET'));
});

test('openrouter: Node startup reads OPENROUTER_API_KEY and the browser lists models with a key', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'openrouter-startup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await loadHarness({ MYHARNESS_ROOT: root, MYHARNESS_PROVIDER: 'openrouter', MYHARNESS_MODEL: 'vendor/model', OPENROUTER_API_KEY: 'env-key' });
  assert.equal(harness.inspect().provider, 'openrouter'); assert.equal(harness.state.maxOutputTokens, 2048);
  assert.equal((harness as unknown as { adapter: ProviderRouter }).adapter.ready('openrouter'), true);
  const absent = await loadHarness({ MYHARNESS_ROOT: root, MYHARNESS_PROVIDER: 'openrouter', MYHARNESS_MODEL: 'vendor/model' });
  assert.equal((absent as unknown as { adapter: ProviderRouter }).adapter.ready('openrouter'), false);

  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(url.includes('/models?') ? { data: [{ id: 'vendor/model', name: 'Vendor model' }] } : {}));
  const { backend } = await fixture(t);
  assert.deepEqual(await backend.listModels({ provider: 'openrouter', apiKey: 'private' }), [{ id: 'vendor/model', label: 'Vendor model' }]);
  await backend.configureModel({ provider: 'openrouter', model: 'vendor/model', apiKey: 'private' });
  assert.equal(backend.inspect().provider, 'openrouter'); assert.equal(backend.inspect().model, 'vendor/model');
});

test('groq, mistral and cerebras: own endpoint, token-limit field, headers and tool-capable model lists', async () => {
  const sent: { url: string; init: Init }[] = [];
  const make = (provider: 'groq' | 'mistral' | 'cerebras', data: unknown) => new ChatCompletionsAdapter(provider, async (url, init) => { sent.push({ url, init }); return Response.json({ data }); }, 'private');
  for (const [provider, field] of [['groq', 'max_completion_tokens'], ['mistral', 'max_tokens'], ['cerebras', 'max_completion_tokens']] as const) {
    const body = make(provider, []).prepare(request(provider));
    assert.deepEqual(Object.keys(body), ['model', 'messages', 'stream', field, 'tools']); assert.equal(body[field], 2048);
    assert.throws(() => make(provider, []).prepare({ ...request(provider), messages: [{ role: 'assistant', content: '', continuation: { provider: 'openrouter', items: [] } }] }), /another provider/);
  }
  const groq = make('groq', [{ id: 'openai/gpt-oss-20b' }, { id: 'whisper-large-v3' }, { id: 'meta/llama-guard-4' }, { id: 'old-model', active: false }, { id: 'canopylabs/orpheus-tts' }]);
  assert.deepEqual(await groq.listModels(), [{ id: 'openai/gpt-oss-20b', label: 'openai/gpt-oss-20b' }]);
  assert.equal(sent[0]!.url, 'https://api.groq.com/openai/v1/models'); assert.deepEqual(Object.keys(sent[0]!.init.headers!).sort(), ['authorization', 'content-type']);
  const mistral = make('mistral', [{ id: 'mistral-large-latest', capabilities: { function_calling: true } }, { id: 'mistral-embed', capabilities: { function_calling: false } }, { id: 'no-capabilities' }]);
  assert.deepEqual(await mistral.listModels(), [{ id: 'mistral-large-latest', label: 'mistral-large-latest' }]);
  assert.deepEqual(await make('cerebras', [{ id: 'gpt-oss-120b' }]).listModels(), [{ id: 'gpt-oss-120b', label: 'gpt-oss-120b' }]);
  assert.equal(sent.at(-1)!.url, 'https://api.cerebras.ai/v1/models');
  // describe checks the key and the model in one listing request, with no model ID in the URL.
  sent.length = 0;
  assert.equal((await groq.describe('openai/gpt-oss-20b')).provider, 'groq'); assert.equal(sent.length, 1);
  await assert.rejects(groq.describe('whisper-large-v3'), /HTTP 404.*accepts tools/);
  await assert.rejects(make('mistral', []).describe('missing'), /HTTP 404/);
  assert.match((await make('cerebras', [{ id: 'm' }]).describe('m')).template, /^Cerebras/);
  for (const provider of ['groq', 'mistral', 'cerebras'] as const) await assert.rejects(new ChatCompletionsAdapter(provider, async () => new Response('x', { status: 402 }), 'key').complete(request(provider)), /no credits left/);
  await assert.rejects(new ChatCompletionsAdapter('groq', fetch, '').listModels(), /API key for groq/);
});

test('groq and mistral: streamed usage under x_groq, and Mistral content split into text and thinking parts', async () => {
  const groq = new ChatCompletionsAdapter('groq', async () => done([{ choices: [{ delta: { content: 'hi' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], x_groq: { usage } }]), 'key');
  const answer = (await collect(groq.stream(request('groq')))).at(-1) as { result: import('../src/model.js').ModelResult };
  assert.equal(answer.result.usage.input, 12); assert.equal(answer.result.message.content, 'hi');
  const parts = [{ type: 'thinking', thinking: [{ type: 'text', text: 'plan ' }, { type: 'text', text: 'it' }] }, { type: 'text', text: 'answer' }, { type: 'image', text: 'ignored' }];
  const mistral = new ChatCompletionsAdapter('mistral', async () => Response.json({ choices: [{ message: { role: 'assistant', content: parts }, finish_reason: 'stop' }] }), 'key');
  const whole = await mistral.complete(request('mistral'));
  assert.equal(whole.message.content, 'answer'); assert.equal(whole.thinking, 'plan it');
  assert.deepEqual(whole.message.continuation!.items, [{ role: 'assistant', content: 'answer' }]);
  const streamed = new ChatCompletionsAdapter('mistral', async () => done([{ choices: [{ delta: { content: parts } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]), 'key');
  const events = await collect(streamed.stream(request('mistral')));
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => [e.content, e.thinking]), [['answer', 'plan it']]);
});

test('groq, mistral and cerebras: provider names, model IDs, Node environment keys and browser listing', async t => {
  for (const name of ['groq', 'mistral', 'cerebras']) { assert.equal(providerName(name), name); assert.equal(configuredModel(providerName(name), 'openai/gpt-oss-20b'), 'openai/gpt-oss-20b'); assert.throws(() => configuredModel(providerName(name)), /model ID/); }
  const router = new ProviderRouter(fetch, {}, 'groq', { groq: 'a', mistral: 'b', cerebras: 'c' });
  for (const name of ['groq', 'mistral', 'cerebras']) { assert.ok(router.adapter(name) instanceof ChatCompletionsAdapter); assert.equal(router.ready(name), true); }
  for (const [provider, key] of [['groq', 'GROQ_API_KEY'], ['mistral', 'MISTRAL_API_KEY'], ['cerebras', 'CEREBRAS_API_KEY']] as const) {
    // A fresh root each time: a saved session would restore the earlier provider.
    const root = await mkdtemp(path.join(tmpdir(), `free-tier-${provider}-`)); t.after(() => rm(root, { recursive: true, force: true }));
    const harness = await loadHarness({ MYHARNESS_ROOT: root, MYHARNESS_PROVIDER: provider, MYHARNESS_MODEL: 'some-model', [key]: 'env-key' });
    assert.equal(harness.inspect().provider, provider); assert.equal(harness.state.maxOutputTokens, 2048);
    assert.equal((harness as unknown as { adapter: ProviderRouter }).adapter.ready(provider), true);
    const absent = await loadHarness({ MYHARNESS_ROOT: root, MYHARNESS_PROVIDER: provider, MYHARNESS_MODEL: 'some-model' });
    assert.equal((absent as unknown as { adapter: ProviderRouter }).adapter.ready(provider), false);
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'llama-3.3-70b' }] }));
  const { backend } = await fixture(t);
  assert.deepEqual(await backend.listModels({ provider: 'cerebras', apiKey: 'private' }), [{ id: 'llama-3.3-70b', label: 'llama-3.3-70b' }]);
});

test('custom server: the address is validated, the key is optional and the request goes to the named server', async () => {
  for (const [raw, expected] of [['https://api.example.com/v1/', 'https://api.example.com/v1'], ['http://localhost:1234/v1', 'http://localhost:1234/v1'], ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'], ['http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
    ['http://192.168.1.20:11434/v1', 'http://192.168.1.20:11434/v1'], ['http://10.0.0.5/v1', 'http://10.0.0.5/v1'], ['http://172.20.0.5/v1', 'http://172.20.0.5/v1'], ['http://my-box.local:8000/v1', 'http://my-box.local:8000/v1'], ['  https://gateway.example/openai//  ', 'https://gateway.example/openai']] as const) assert.equal(customEndpoint(raw), expected);
  for (const bad of ['', 'localhost:1234', 'not a url', 'http://example.com/v1', 'http://172.32.0.1/v1', 'ftp://localhost/v1', 'https://user:pw@example.com/v1', 'https://example.com/v1?key=1', 'https://example.com/v1#x']) assert.throws(() => customEndpoint(bad), /address|https/);

  const sent: { url: string; init: Init }[] = [];
  const base = 'http://localhost:1234/v1';
  const server = (key: string) => new ChatCompletionsAdapter('custom', async (url, init) => { sent.push({ url, init }); return init.method === 'GET' ? Response.json({ data: [{ id: 'local/model' }, { id: 'other' }] }) : done(chunks('hello')); }, key, base);
  const keyless = server('');
  assert.equal(keyless.ready(), true); assert.equal(new ChatCompletionsAdapter('custom', fetch, 'key').ready(), false);
  assert.deepEqual(await keyless.listModels(), [{ id: 'local/model', label: 'local/model' }, { id: 'other', label: 'other' }]);
  assert.equal(sent[0]!.url, `${base}/models`); assert.deepEqual(Object.keys(sent[0]!.init.headers!).sort(), ['content-type']);
  assert.equal((await keyless.describe('other')).provider, 'custom'); await assert.rejects(keyless.describe('missing'), /HTTP 404/);
  assert.equal(keyless.prepare(request('custom')).max_tokens, 2048);
  await collect(keyless.stream(request('custom'))); assert.equal(sent.at(-1)!.url, `${base}/chat/completions`);
  await collect(server('secret').stream(request('custom'))); assert.equal(sent.at(-1)!.init.headers!.authorization, 'Bearer secret');
  await assert.rejects(new ChatCompletionsAdapter('custom', fetch, 'key').listModels(), /address of your server/);
  await assert.rejects(new ChatCompletionsAdapter('openrouter', fetch, '').listModels(), /API key for openrouter/);
});

test('custom server: router keeps the address, Node reads MYHARNESS_CUSTOM_URL and CUSTOM_API_KEY, the browser lists and connects', async t => {
  assert.equal(providerName('custom'), 'custom'); assert.equal(configuredModel('custom', 'org/model:tag'), 'org/model:tag'); assert.throws(() => configuredModel('custom'), /model ID/);
  const router = new ProviderRouter(fetch, {}, 'custom');
  assert.equal(router.ready('custom'), false); router.setBase('custom', 'http://localhost:1234/v1'); assert.equal(router.ready('custom'), true);
  assert.throws(() => router.setBase('custom', 'http://example.com'), /https/);
  assert.equal(router.ready('custom'), true); assert.throws(() => router.adapter('custom', undefined, 'bad'), /address/);

  const root = await mkdtemp(path.join(tmpdir(), 'custom-startup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { MYHARNESS_ROOT: root, MYHARNESS_PROVIDER: 'custom', MYHARNESS_MODEL: 'local/model' };
  await assert.rejects(loadHarness(env), /address of your server/); await assert.rejects(loadHarness({ ...env, MYHARNESS_CUSTOM_URL: 'http://example.com/v1' }), /https/);
  const harness = await loadHarness({ ...env, MYHARNESS_CUSTOM_URL: 'http://localhost:1234/v1' });
  assert.equal(harness.inspect().provider, 'custom'); assert.equal(harness.state.maxOutputTokens, 2048);
  assert.equal((harness as unknown as { adapter: ProviderRouter }).adapter.ready('custom'), true);
  const withKey = await loadHarness({ ...env, MYHARNESS_ROOT: await mkdtemp(path.join(tmpdir(), 'custom-key-')), MYHARNESS_CUSTOM_URL: 'https://gateway.example/v1', CUSTOM_API_KEY: 'k' });
  assert.equal(withKey.inspect().provider, 'custom');

  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => { calls.push(url); return Response.json({ data: [{ id: 'local/model' }] }); });
  const { backend } = await fixture(t);
  assert.deepEqual(await backend.listModels({ provider: 'custom', url: 'http://localhost:1234/v1' }), [{ id: 'local/model', label: 'local/model' }]);
  assert.deepEqual(calls, ['http://localhost:1234/v1/models']);
  await assert.rejects(backend.listModels({ provider: 'custom' }), /address/); await assert.rejects(backend.configureModel({ provider: 'custom', model: 'local/model' }), /address/);
  await backend.configureModel({ provider: 'custom', model: 'local/model', url: 'http://localhost:1234/v1' });
  assert.equal(backend.inspect().provider, 'custom'); assert.equal(backend.inspect().model, 'local/model');
});

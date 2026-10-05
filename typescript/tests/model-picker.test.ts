import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudAdapter } from '../src/cloud.js';
import { OllamaAdapter } from '../src/ollama.js';
import { ModelPicker } from '../src/browser/model-picker.js';
import { fixture } from './browser-fixture.js';
import type { ModelOption } from '../src/model.js';

test('Ollama discovery lists installed models without inference and handles invalid lists', async () => {
  const adapter = new OllamaAdapter(async (url, init) => {
    assert.equal(url, 'http://ollama/api/tags'); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    return Response.json({ models: [{ name: 'z:8b' }, { name: 'a:4b' }, { name: 'a:4b' }, { name: '' }, { name: 5 }, {}, null] });
  }, 'http://ollama');
  assert.deepEqual(await adapter.listModels(), [{ id: 'a:4b', label: 'a:4b' }, { id: 'z:8b', label: 'z:8b' }]);
  assert.deepEqual(await new OllamaAdapter(async () => Response.json({ models: [] }), 'http://ollama').listModels(), []);
  for (const data of [{}, null]) await assert.rejects(new OllamaAdapter(async () => Response.json(data), 'http://ollama').listModels(), /invalid model list/);
  await assert.rejects(new OllamaAdapter(async () => new Response('', { status: 503 }), 'http://ollama').listModels(), /503/);
});

test('cloud discovery lists account models, follows pagination, filters chat models and keeps keys out of URLs', async () => {
  const requests: string[] = [];
  const gemini = new CloudAdapter('gemini', async (url, init) => {
    requests.push(url); assert.equal(init.headers!['x-goog-api-key'], 'private'); assert.equal(init.method, 'GET');
    return Response.json(url.includes('pageToken=next') ? { models: [{ name: 'models/gemini-alpha', displayName: 'Alpha', supportedGenerationMethods: ['generateContent'] }] }
      : { nextPageToken: 'next', models: [{ name: 'models/gemini-zeta', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-zeta', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] }, { name: 'models/gemini-unknown' }, {}] });
  }, 'private');
  assert.deepEqual(await gemini.listModels(), [{ id: 'gemini-alpha', label: 'Alpha' }, { id: 'gemini-zeta', label: 'gemini-zeta' }]);
  assert.ok(requests.every(url => !url.includes('private')));
  const openai = new CloudAdapter('openai', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(init.headers!.authorization, 'Bearer private');
    return Response.json({ data: [{ id: 'gpt-test' }, { id: 'o3', display_name: 'Reasoning' }, { id: 'gpt-audio' }, { id: 'text-embedding-3-small' }, { id: '' }, null] });
  }, 'private');
  assert.deepEqual(await openai.listModels(), [{ id: 'gpt-test', label: 'gpt-test' }, { id: 'o3', label: 'Reasoning' }]);
  const anthropic = new CloudAdapter('anthropic', async (url, init) => {
    assert.equal(init.headers!['x-api-key'], 'private'); assert.equal(init.headers!['anthropic-dangerous-direct-browser-access'], 'true');
    return Response.json(url.includes('after_id=last') ? { data: [{ id: 'claude-alpha', display_name: 'Alpha' }], has_more: false }
      : { data: [{ id: 'claude-zeta', display_name: 'Zeta' }], has_more: true, last_id: 'last' });
  }, 'private');
  assert.deepEqual(await anthropic.listModels(), [{ id: 'claude-alpha', label: 'Alpha' }, { id: 'claude-zeta', label: 'Zeta' }]);
  assert.deepEqual(await new CloudAdapter('openai', async () => Response.json({}), 'private').listModels(), []);
  assert.deepEqual(await new CloudAdapter('anthropic', async () => Response.json({ has_more: true }), 'private').listModels(), []);
  await assert.rejects(new CloudAdapter('gemini', async () => Response.json({ nextPageToken: 'repeat' }), 'private').listModels(), /repeated/);
  await assert.rejects(new CloudAdapter('openai', async () => new Response('secret', { status: 401 }), 'private').listModels(), error => !String(error).includes('secret') && /API key/.test(String(error)));
  await assert.rejects(new CloudAdapter('openai', async () => { throw new Error('secret'); }, 'private').listModels(), /Could not connect/);
  await assert.rejects(new CloudAdapter('openai', async () => { throw new Error('should not fetch'); }, '').listModels(), /API key/);
});

test('browser model discovery is headless, preserves sessions and uses remembered credentials and server URL', async t => {
  const requested: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requested.push(url);
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'installed:latest' }] });
    if (url === 'https://api.openai.com/v1/models') { assert.equal((init.headers as Record<string, string>).authorization, 'Bearer private'); return Response.json({ data: [{ id: 'gpt-test' }] }); }
    return Response.json({});
  });
  const { backend, storage } = await fixture(t);
  const before = backend.activeSessionRecord();
  assert.deepEqual(await backend.listModels({ provider: 'ollama' }), [{ id: 'installed:latest', label: 'installed:latest' }]);
  assert.equal(requested.at(-1), 'http://localhost:11434/api/tags');
  await storage.put('settings', 'ollama-url', 'http://remembered:11434');
  await backend.listModels({ mode: 'ollama' }); assert.equal(requested.at(-1), 'http://remembered:11434/api/tags');
  await backend.listModels({ provider: 'ollama', url: 'https://another/' }); assert.equal(requested.at(-1), 'https://another/api/tags');
  assert.deepEqual(await backend.listModels({ provider: 'openai', apiKey: 'private' }), [{ id: 'gpt-test', label: 'gpt-test' }]);
  assert.deepEqual(backend.activeSessionRecord(), before);
  await backend.configureModel({ provider: 'openai', model: 'gpt-test', apiKey: 'private' });
  await backend.listModels({ provider: 'openai' });
  assert.ok(!JSON.stringify(await storage.all('settings')).includes('private'));
  for (const url of ['file:///tmp', 'http://user@host', 'http://:password@host']) await assert.rejects(backend.listModels({ provider: 'ollama', url }), /without credentials/);
  await assert.rejects(backend.listModels({ provider: 'ollama', url: 'bad' }), /Invalid URL/);
  await assert.rejects(backend.listModels({ provider: 'demo' }), /real model/);
  await assert.rejects(backend.listModels({ provider: 'invalid' }), /provider/);
  await assert.rejects(backend.listModels({}), /settings/);
});

test('picker controller renders loading, results and failures and ignores stale provider responses', async () => {
  let result: ModelOption[] = [{ id: 'a', label: 'A' }], error: unknown;
  const displayed: unknown[] = [];
  let provider = 'ollama';
  const picker = new ModelPicker({ async call(action, payload) { assert.equal(action, 'listModels'); assert.equal(payload!.provider, provider); if (error) throw error; return result; } }, {
    settings: () => ({ provider }), loading: () => displayed.push('loading'), render: models => displayed.push(models), failure: message => displayed.push(message),
  });
  await picker.refresh(); assert.deepEqual(displayed, ['loading', result]);
  result = []; await picker.refresh(); assert.deepEqual(displayed.at(-1), []);
  error = new Error('offline'); await picker.refresh(); assert.equal(displayed.at(-1), 'offline');
  error = 'invalid'; await picker.refresh(); assert.equal(displayed.at(-1), 'invalid');
  const pending: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
  const latest: unknown[] = [];
  const racing = new ModelPicker({ call: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) }, {
    settings: () => ({ provider }), loading: () => {}, render: models => latest.push(models), failure: message => latest.push(message),
  });
  const first = racing.refresh(); provider = 'openai'; const second = racing.refresh();
  pending[1]!.resolve([{ id: 'new', label: 'New' }]); await second;
  pending[0]!.resolve([{ id: 'old', label: 'Old' }]); await first;
  assert.deepEqual(latest, [[{ id: 'new', label: 'New' }]]);
  const third = racing.refresh(), fourth = racing.refresh();
  pending[2]!.reject(new Error('stale')); pending[3]!.reject(new Error('current')); await Promise.all([third, fourth]);
  assert.deepEqual(latest.at(-1), 'current'); assert.equal(latest.length, 2);
});

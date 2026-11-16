import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECT_CARD_HTML, mountConnectCard } from '../ui/connect-card.js';
import { BackendError } from '../src/harness.js';
import { failureDetails } from '../src/failure.js';

class Element {
  value = ''; textContent = ''; hidden = false; disabled = false; children: Element[] = [];
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, () => unknown>();
  addEventListener(type: string, listener: () => unknown) { this.listeners.set(type, listener); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  replaceChildren(...children: Element[]) { this.children = children; }
  emit(type: string) { return this.listeners.get(type)!(); }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const elements = new Map<string, Element>();
  const get = (id: string) => { let element = elements.get(id); if (!element) elements.set(id, element = new Element()); return element; };
  get('connect-ollama-url').value = 'http://localhost:11434'; get('connect-provider').value = 'gemini';
  const calls: { action: string; payload: Record<string, unknown> | undefined }[] = [], rendered: Record<string, unknown>[] = [];
  const replies: Record<string, (payload: Record<string, unknown> | undefined) => unknown> = { bootstrap: () => ({ model_connected: true }), configureModel: () => ({ ok: true }) };
  const client = { async call(action: string, payload?: Record<string, unknown>) { calls.push({ action, payload }); return replies[action]!(payload); } };
  const card = mountConnectCard({ getElementById: get, createElement: () => new Element() } as unknown as Document, { client, origin: 'https://site.test', render: state => rendered.push(state) });
  const click = async (id: string) => { get(id).emit('click'); await settle(); };
  return { get, calls, rendered, replies, card, click };
}

test('the card markup has every control the controller wires, and no scripted demo or pairing code', () => {
  for (const id of ['connect-card', 'connect-choose-key', 'connect-choose-ollama', 'connect-key', 'connect-provider', 'connect-api-key', 'connect-list', 'connect-ollama', 'connect-ollama-help', 'connect-ollama-shown',
    'connect-ollama-command', 'connect-ollama-command-windows', 'connect-ollama-url', 'connect-retry', 'connect-models', 'connect-model', 'connect-go', 'connect-status', 'connect-dismiss']) assert.ok(CONNECT_CARD_HTML.includes(`id="${id}"`), id);
  assert.doesNotMatch(CONNECT_CARD_HTML, /demo|pairing|vault|passphrase/i);
  assert.match(CONNECT_CARD_HTML, /never saved/);
});

test('the card follows the backend model_connected flag and can be dismissed for this page load', async () => {
  const f = fixture();
  f.card.update({ model_connected: false, ready: true, provider: 'ollama' }); assert.equal(f.get('connect-card').hidden, false);
  assert.equal(f.get('connect-status').textContent, '');
  f.card.update({ model_connected: true }); assert.equal(f.get('connect-card').hidden, true);
  f.card.update({ model_connected: false, ready: true, provider: 'ollama' }); await f.click('connect-dismiss'); assert.equal(f.get('connect-card').hidden, true);
  f.card.update({ model_connected: false, ready: true, provider: 'ollama' }); assert.equal(f.get('connect-card').hidden, true);
  assert.deepEqual(f.calls, []);
});

test('a saved cloud session without its key asks for the key again, once', () => {
  const f = fixture();
  f.card.update({ model_connected: false, ready: false, provider: 'openai' });
  assert.equal(f.get('connect-key').hidden, false); assert.equal(f.get('connect-provider').value, 'openai');
  assert.equal(f.get('connect-choose-key').attributes.get('aria-pressed'), 'true');
  assert.match(f.get('connect-status').textContent, /keys are never saved/);
  f.get('connect-status').textContent = 'kept'; f.card.update({ model_connected: false, ready: false, provider: 'openai' });
  assert.equal(f.get('connect-status').textContent, 'kept');
});

test('the API-key path lists models with the key, connects through the backend and clears the key field', async () => {
  const f = fixture();
  await f.click('connect-choose-key');
  assert.equal(f.get('connect-key').hidden, false); assert.equal(f.get('connect-ollama').hidden, true); assert.equal(f.get('connect-choose-ollama').attributes.get('aria-pressed'), 'false');
  await f.click('connect-list'); assert.equal(f.get('connect-status').textContent, 'Paste your API key first.'); assert.deepEqual(f.calls, []);
  f.get('connect-api-key').value = 'PRIVATE'; f.replies.listModels = () => [];
  await f.click('connect-list'); assert.match(f.get('connect-status').textContent, /no chat models/);
  assert.deepEqual(f.calls.at(-1), { action: 'listModels', payload: { provider: 'gemini', apiKey: 'PRIVATE' } });
  f.replies.listModels = () => { throw new BackendError('HTTP 401', 400, failureDetails('HTTP 401', 'model', 'gemini', 'Retry.')); };
  await f.click('connect-list'); assert.match(f.get('connect-status').textContent, /valid access key/); assert.equal(f.get('connect-models').hidden, true);
  f.replies.listModels = () => { throw new Error('plain failure'); };
  await f.click('connect-list'); assert.equal(f.get('connect-status').textContent, 'plain failure');
  f.replies.listModels = () => [{ id: 'gemini-a', label: 'A' }, { id: 'gemini-b', label: 'B' }];
  await f.click('connect-list');
  assert.equal(f.get('connect-models').hidden, false); assert.equal(f.get('connect-model').value, 'gemini-a');
  assert.deepEqual(f.get('connect-model').children.map(option => [option.value, option.textContent]), [['gemini-a', 'A'], ['gemini-b', 'B']]);
  f.get('connect-model').value = 'gemini-b';
  await f.click('connect-go');
  assert.deepEqual(f.calls.slice(-2), [{ action: 'configureModel', payload: { provider: 'gemini', model: 'gemini-b', apiKey: 'PRIVATE' } }, { action: 'bootstrap', payload: undefined }]);
  assert.equal(f.get('connect-api-key').value, ''); assert.equal(f.get('connect-go').disabled, false); assert.equal(f.get('connect-status').textContent, '');
  assert.deepEqual(f.rendered, [{ model_connected: true }]);
  // Changing the provider discards the typed key and the model list of the previous provider.
  f.get('connect-api-key').value = 'OTHER'; f.get('connect-provider').emit('change');
  assert.equal(f.get('connect-api-key').value, ''); assert.equal(f.get('connect-models').hidden, true);
});

test('a failed connection explains itself, hides the stale model list and never renders a connected state', async () => {
  const f = fixture();
  await f.click('connect-choose-key'); f.get('connect-api-key').value = 'PRIVATE'; f.replies.listModels = () => [{ id: 'm', label: 'M' }]; await f.click('connect-list');
  f.get('connect-api-key').value = '';
  f.replies.configureModel = () => { throw new BackendError('Could not connect to gemini', 400, failureDetails('Could not connect to gemini', 'model', 'gemini', 'Retry.')); };
  await f.click('connect-go');
  assert.deepEqual(f.calls.at(-1), { action: 'configureModel', payload: { provider: 'gemini', model: 'm' } });
  assert.match(f.get('connect-status').textContent, /could not be reached/); assert.equal(f.get('connect-models').hidden, true); assert.equal(f.get('connect-go').disabled, false);
  assert.deepEqual(f.rendered, []);
});

test('choosing Ollama looks for it; when unreachable the card shows the exact start command for this page origin', async () => {
  const f = fixture();
  f.replies.listModels = () => { throw new Error('Failed to fetch'); };
  await f.click('connect-choose-ollama');
  assert.deepEqual(f.calls, [{ action: 'listModels', payload: { provider: 'ollama', url: 'http://localhost:11434' } }]);
  assert.equal(f.get('connect-ollama').hidden, false); assert.equal(f.get('connect-ollama-help').hidden, false); assert.equal(f.get('connect-status').textContent, '');
  assert.equal(f.get('connect-ollama-shown').textContent, 'http://localhost:11434');
  assert.equal(f.get('connect-ollama-command').textContent, 'OLLAMA_ORIGINS=https://site.test ollama serve');
  assert.equal(f.get('connect-ollama-command-windows').textContent, '$env:OLLAMA_ORIGINS="https://site.test"; ollama serve');
  f.replies.listModels = () => [];
  await f.click('connect-retry'); assert.equal(f.get('connect-ollama-help').hidden, true); assert.match(f.get('connect-status').textContent, /no model installed/);
  f.replies.listModels = () => [{ id: 'qwen3:8b', label: 'qwen3:8b' }];
  f.get('connect-ollama-url').value = 'http://other:11434'; f.get('connect-ollama-url').emit('change'); await settle();
  assert.equal(f.get('connect-models').hidden, false);
  await f.click('connect-go');
  assert.deepEqual(f.calls.at(-2), { action: 'configureModel', payload: { provider: 'ollama', url: 'http://other:11434', model: 'qwen3:8b' } });
});

test('a slow model list cannot replace the choice the user made afterwards', async () => {
  const f = fixture();
  let release!: (models: unknown) => void, fail!: (error: Error) => void;
  f.replies.listModels = () => new Promise(resolve => { release = resolve; });
  await f.click('connect-choose-ollama'); await f.click('connect-choose-key');
  release([{ id: 'late', label: 'late' }]); await settle();
  assert.equal(f.get('connect-models').hidden, true); assert.deepEqual(f.get('connect-model').children, []);
  f.replies.listModels = () => new Promise((_resolve, reject) => { fail = reject; });
  await f.click('connect-choose-ollama'); await f.click('connect-choose-key');
  fail(new Error('late failure')); await settle();
  assert.equal(f.get('connect-ollama-help').hidden, true); assert.equal(f.get('connect-status').textContent, '');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';

const library = { agents: {}, skills: {}, prompts: {} };
const open = (storage = new MemoryStorage()) => BrowserHarness.open({ storage, library, seed: { 'README.md': 'browser file' } });

test('the backend reports a connected model only after a real model is chosen, and never stores its key', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => String(url).endsWith('/api/show')
    ? Response.json({ model_info: { 'general.architecture': 'q', 'q.context_length': 4096 } }) : Response.json({}));
  const storage = new MemoryStorage(), harness = await open(storage);
  let state = await harness.bootstrap();
  assert.equal(state.model_connected, false); assert.equal(state.provider, 'ollama'); assert.equal(state.ready, true);
  // A failed attempt leaves the page on its connect card.
  await assert.rejects(harness.configureModel({ provider: 'ollama', model: 'bad model' }));
  assert.equal((await harness.bootstrap()).model_connected, false);
  await harness.configureModel({ provider: 'ollama', model: 'small:4b', url: 'http://localhost:11434' });
  state = await harness.bootstrap(); assert.equal(state.model_connected, true); assert.equal(state.model, 'small:4b');
  await harness.configureModel({ provider: 'openai', model: 'gpt-test', apiKey: 'PRIVATE_KEY' });
  assert.equal((await harness.bootstrap()).model_connected, true);
  assert.doesNotMatch(JSON.stringify([await storage.all('settings'), await storage.all('sessions'), await harness.bootstrap()]), /PRIVATE_KEY/);
  // Forgetting the key, or reloading the page, leaves a cloud session that cannot be called: the card returns.
  harness.forgetApiKey(); state = await harness.bootstrap(); assert.equal(state.model_connected, false); assert.equal(state.ready, false);
  await harness.close();
  const reloaded = await open(storage); state = await reloaded.bootstrap();
  assert.equal(state.provider, 'openai'); assert.equal(state.model_connected, false);
  // A saved Ollama choice needs no credential, so it is still connected after a reload.
  await reloaded.configureModel({ provider: 'ollama', model: 'small:4b' }); await reloaded.close();
  const again = await open(storage); assert.equal((await again.bootstrap()).model_connected, true); await again.close();
  storage.close(); assert.deepEqual(await storage.all('settings'), []);
});

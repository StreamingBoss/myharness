import assert from 'node:assert/strict';
import test from 'node:test';
import { TOKEN_HELPER_HTML, mountTokenHelperPanel } from '../ui/token-helper-panel.js';
import { HELPER_DEFAULT_ORIGIN, HelperError } from '../src/helper-protocol.js';

class Element {
  textContent = ''; hidden = false; disabled = false; open = false;
  private readonly listeners = new Map<string, () => unknown>();
  addEventListener(type: string, listener: () => unknown) { this.listeners.set(type, listener); }
  emit(type: string) { return this.listeners.get(type)!(); }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const off = { enabled: false, connected: false }, on = { enabled: true, connected: true }, down = { enabled: true, connected: false };

function fixture(origin = 'https://site.test') {
  const elements = new Map<string, Element>();
  const get = (id: string) => { let element = elements.get(id); if (!element) elements.set(id, element = new Element()); return element; };
  const calls: string[] = [];
  const replies: Record<string, () => unknown> = { tokenizerStatus: () => off, connectTokenizer: () => on, forgetTokenizer: () => off };
  const client = { async call(action: string) { calls.push(action); return replies[action]!(); } };
  const panel = mountTokenHelperPanel({ getElementById: get } as unknown as Document, { client, origin });
  const click = async (id: string) => { get(id).emit('click'); await settle(); };
  return { get, calls, replies, panel, click };
}

test('the panel markup has every control the controller wires, and asks for no pairing code', () => {
  for (const id of ['token-helper', 'token-helper-status', 'token-helper-setup', 'token-helper-command', 'token-helper-connect', 'token-helper-forget']) assert.ok(TOKEN_HELPER_HTML.includes(`id="${id}"`), id);
  assert.doesNotMatch(TOKEN_HELPER_HTML, /pairing|code\b|<input/i);
  assert.match(TOKEN_HELPER_HTML, /does nothing else/);
});

test('the start command names this page, except on the site the helper serves by default', () => {
  assert.equal(fixture().get('token-helper-command').textContent, 'npm run token-helper:ts -- --origin https://site.test');
  assert.equal(fixture(HELPER_DEFAULT_ORIGIN).get('token-helper-command').textContent, 'npm run token-helper:ts');
});

test('the panel is offered for Ollama only and renders the backend status without contacting anything', () => {
  const f = fixture();
  f.panel.update({ provider: 'openai', tokenizer: off }); assert.equal(f.get('token-helper').hidden, true);
  f.panel.update({ provider: 'ollama', tokenizer: off });
  assert.equal(f.get('token-helper').hidden, false); assert.equal(f.get('token-helper-status').textContent, '');
  assert.equal(f.get('token-helper-forget').hidden, true); assert.equal(f.get('token-helper-setup').hidden, false); assert.equal(f.get('token-helper-setup').open, false);
  assert.equal(f.get('token-helper-connect').textContent, 'Connect');
  f.panel.update({ provider: 'ollama', tokenizer: on });
  assert.match(f.get('token-helper-status').textContent, /connected/); assert.equal(f.get('token-helper-setup').hidden, true); assert.equal(f.get('token-helper-forget').hidden, false);
  f.panel.update({ provider: 'ollama', tokenizer: down });
  assert.match(f.get('token-helper-status').textContent, /not connected/); assert.equal(f.get('token-helper-setup').hidden, false); assert.equal(f.get('token-helper-setup').open, true);
  assert.equal(f.get('token-helper-connect').textContent, 'Reconnect');
  assert.deepEqual(f.calls, []);
});

test('one click connects; a failure explains itself; Forget stops reconnecting', async () => {
  const f = fixture();
  f.panel.update({ provider: 'ollama', tokenizer: off });
  let release!: (value: unknown) => void;
  f.replies.connectTokenizer = () => new Promise(resolve => { release = resolve; });
  f.get('token-helper-connect').emit('click'); await settle();
  assert.equal(f.get('token-helper-status').textContent, 'Connecting to the tokenizer helper…'); assert.equal(f.get('token-helper-connect').disabled, true);
  release(on); await settle();
  assert.match(f.get('token-helper-status').textContent, /Tokenizer helper connected/); assert.equal(f.get('token-helper-connect').disabled, false);
  assert.deepEqual(f.calls, ['connectTokenizer']);
  await f.click('token-helper-forget');
  assert.deepEqual(f.calls, ['connectTokenizer', 'forgetTokenizer']); assert.equal(f.get('token-helper-forget').hidden, true); assert.equal(f.get('token-helper-status').textContent, '');
  f.replies.connectTokenizer = () => { throw new HelperError('Tokenizer helper unavailable, timed out or cancelled.'); };
  await f.click('token-helper-connect');
  assert.match(f.get('token-helper-status').textContent, /could not use the tokenizer helper/); assert.equal(f.get('token-helper-connect').disabled, false);
  f.replies.connectTokenizer = () => { throw new Error('plain failure'); };
  await f.click('token-helper-connect'); assert.equal(f.get('token-helper-status').textContent, 'plain failure');
});

test('opening the token view reconnects a remembered helper once per page load, and never an unchosen one', async () => {
  const f = fixture();
  await f.panel.shown(); assert.deepEqual(f.calls, ['tokenizerStatus']);
  f.replies.tokenizerStatus = () => down; f.replies.connectTokenizer = () => { throw new HelperError('Tokenizer helper unavailable, timed out or cancelled.'); };
  await f.panel.shown(); assert.deepEqual(f.calls.slice(1), ['tokenizerStatus', 'connectTokenizer']);
  assert.match(f.get('token-helper-status').textContent, /could not use the tokenizer helper/); assert.equal(f.get('token-helper-setup').open, true);
  // The helper is still not running: the page does not retry on every visit to the view.
  await f.panel.shown(); assert.deepEqual(f.calls.slice(3), ['tokenizerStatus']);
  // After Forget and a new choice, automatic reconnection is available again.
  await f.click('token-helper-forget'); f.replies.connectTokenizer = () => on;
  await f.panel.shown(); assert.deepEqual(f.calls.slice(-2), ['tokenizerStatus', 'connectTokenizer']);
  assert.match(f.get('token-helper-status').textContent, /Tokenizer helper connected/);
  f.replies.tokenizerStatus = () => on; await f.panel.shown(); assert.equal(f.calls.at(-1), 'tokenizerStatus');
  // While a connection started by a click is in progress, opening the view does not start a second one.
  const g = fixture(); let release!: (value: unknown) => void;
  g.replies.tokenizerStatus = () => down; g.replies.connectTokenizer = () => new Promise(resolve => { release = resolve; });
  g.get('token-helper-connect').emit('click'); await settle(); await g.panel.shown();
  assert.deepEqual(g.calls, ['connectTokenizer', 'tokenizerStatus']);
  release(on); await settle(); assert.match(g.get('token-helper-status').textContent, /Tokenizer helper connected/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { explainError, timeoutDuration } from '../src/error-messages.js';
import { presentFailure, failureDetails, DiagnosticError, failureText } from '../src/failure.js';
import { OllamaAdapter } from '../src/ollama.js';
import { TokenHelperClient } from '../src/browser/token-helper.js';
import { HelperError, HELPER_REQUEST_TIMEOUT_MS, HELPER_INSPECTION_TIMEOUT_MS } from '../src/helper-protocol.js';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const examples = [
  ['Tokenizer helper is disconnected; connect it again', 'could not use the tokenizer helper'], ['Tokenizer helper denied the request (403).', 'could not use the tokenizer helper'],
  ['This website is not allowed to use the tokenizer helper', 'could not use the tokenizer helper'], ['Origin is not allowed', 'browser could not access'],
  ['Credentials were locked', 'connections were locked'], ['Enter an API key before continuing', 'valid access key'],
  ['custom request failed (HTTP 402). Your account has no credits left.', 'no credits left'], ['openrouter request failed (HTTP 402). Your OpenRouter credits are used up.', 'no credits left'], ['HTTP 429', 'usage limit'], ['HTTP 404', 'could not be found'], ['HTTP 503', 'could not be reached'],
  ['The model returned an empty reply', 'usable answer'], ['Provider stream ended before completion', 'stopped before'],
  ['Invalid tool arguments', 'missing or invalid information'], ['nobody answered the approval request', 'not run'],
  ['A turn is already running', 'still running'], ["'missing.txt' does not exist", 'file or folder could not be found'],
  ['The saved project folder is missing', 'project folder could not be opened'], ['Permission is not granted', 'Permission'],
  ['The file changed after the proposal', 'file changed'], ['Path escapes the workspace', 'outside the selected'],
  ['This runtime does not support commands', 'feature is unavailable'], ['Tokenizer helper is not installed', 'not installed'],
  ['Tokenizer startup deadline elapsed', 'inspection did not finish'], ['GGUF is invalid', 'could not inspect'],
  ['context full', 'model memory'], ['storage unavailable', 'could not save'], ['no reply within the time limit', 'time limit'],
  ['Backend Worker is closed', 'browser lost its connection'], ['This tab is no longer on the active session', 'different conversation'],
  ['Conversation belongs to another provider', 'selected model service'], ['MCP tool request failed', 'tool service'],
];
test('common errors explain the problem and a next step without requiring implementation knowledge', () => {
  for (const [technical, expected] of examples) {
    const explanation = explainError(technical!); assert.ok(explanation, technical);
    assert.ok(explanation.message.includes(expected!), technical); assert.ok(explanation.next.length > 15);
    assert.doesNotMatch(explanation.message, /heartbeat|GGUF|JSON.RPC|Worker|KV cache/);
  }
  assert.equal(explainError('unique unexpected diagnostic'), undefined);
});
test('timeout values retain actual custom durations, including seconds and minutes', () => {
  for (const [ms, expected] of [[1, '1 millisecond'], [25, '25 milliseconds'], [1000, '1 second'], [1500, '1.5 seconds'], [2000, '2 seconds'], [60000, '1 minute'], [61000, '1 minute 1 second'], [62000, '1 minute 2 seconds'], [120000, '2 minutes'], [121000, '2 minutes 1 second'], [260000, '4 minutes 20 seconds']] as const) assert.equal(timeoutDuration(ms), expected);
  assert.equal(HELPER_REQUEST_TIMEOUT_MS, 120_000); assert.equal(HELPER_INSPECTION_TIMEOUT_MS, 260_000);
});
test('friendly diagnostics preserve source and technical details and explain precisely what to reconnect', () => {
  const detail = failureDetails('Tokenizer helper unavailable, timed out or cancelled. [Time limit: 2 minutes]', 'helper', 'Tokenizer helper', 'Retry.');
  const text = presentFailure(detail, 'failed');
  assert.match(text, /could not use the tokenizer helper/); assert.match(text, /Where: Tokenizer helper on this computer/);
  assert.match(text, /reconnect it in the token viewer/);
  assert.match(text, /Time limit: 2 minutes/); assert.match(text, /Technical details: Tokenizer helper unavailable/);
  // Sessions saved before the bridge was retired still name where their failure happened.
  assert.match(presentFailure(failureDetails('unknown internal error', 'bridge', 'Local bridge', 'Retry.'), ''), /Where: Connection to your local computer/);
  assert.match(presentFailure(failureDetails('unknown internal error', 'model', 'Ollama', 'Retry.', 180_000), ''), /Time limit: 3 minutes/);
  assert.match(presentFailure(failureDetails('unknown internal error', 'harness', 'Harness', 'Retry.'), ''), /harness could not complete/);
  assert.match(presentFailure(failureDetails('Backend Worker stopped', 'transport', 'Browser', 'Retry.'), ''), /Browser connection/);
  assert.equal(presentFailure(undefined, 'ordinary explanation'), 'ordinary explanation');
  assert.match(presentFailure(undefined, 'Model request timed out. [Time limit: 10 seconds]'), /Time limit: 10 seconds/);
  assert.match(failureText(new DiagnosticError(detail), ''), /reconnect it in the token viewer/);
  assert.match(failureText(new Error('offline'), 'Backend Worker is closed'), /Reload this page/);
});
test('model and tokenizer helper network failures report their configured request limits without leaking raw exceptions', async () => {
  const offline = async () => { throw new Error('PRIVATE secret in network exception'); };
  const adapter = new OllamaAdapter(offline, 'http://ollama.test');
  for (const call of [() => adapter.listModels(), () => adapter.request('show', {}), async () => { for await (const _chunk of adapter.streamChat({ model: 'q', messages: [], stream: true, options: { num_ctx: 1000 } })) {} }]) {
    await assert.rejects(call(), (error: DiagnosticError) => { assert.equal(error.failure.source, 'model'); assert.ok([10_000, 180_000].includes(error.failure.timeoutMs!)); assert.doesNotMatch(error.message, /PRIVATE/); return true; });
  }
  const helper = new TokenHelperClient('http://127.0.0.1:5002', offline);
  await assert.rejects(helper.connect(), (error: HelperError) => { assert.equal(error.failure.timeoutMs, 120_000); assert.equal(error.failure.source, 'helper'); assert.doesNotMatch(error.message, /PRIVATE/); return true; });
  // A real inspection operation has its own longer transport limit.
  const failing = new TokenHelperClient('http://127.0.0.1:5002', async (url, init) => {
    if (url.endsWith('/connect')) return Response.json({ value: { token: 'fixture', ollamaUrl: 'http://localhost:11434', models: [], automatic: true } });
    if (JSON.parse(String(init.body)).operation === 'inspectTokens') return offline();
    return Response.json({ value: {} });
  });
  await failing.connect();
  await assert.rejects(failing.call('inspectTokens'), (error: HelperError) => { assert.equal(error.failure.timeoutMs, 260_000); return true; });
  await failing.close();
});
test('the browser uses the shared explanations and hides technical diagnostics behind a disclosure', async () => {
  const html = await readFile('web/static/app.js', 'utf8');
  const source = html.slice(html.indexOf('function addDivider('), html.indexOf('async function resetMemory('));
  class Element { className = ''; textContent = ''; children: Element[] = []; append(...elements: Element[]) { this.children.push(...elements); } }
  const messages = { children: [] as Element[], scrollTop: 0, scrollHeight: 100, appendChild(element: Element) { this.children.push(element); } };
  const context = { document: { createElement: () => new Element() }, messagesEl: messages, addDivider: undefined as unknown as (text: string) => void };
  new Script(source).runInNewContext(context);
  context.addDivider(presentFailure(failureDetails('HTTP 503'), ''));
  assert.match(messages.children[0]!.textContent, /could not be reached/);
  assert.doesNotMatch(messages.children[0]!.textContent, /HTTP 503/);
  assert.equal(messages.children[0]!.children[0]!.children[0]!.textContent, 'Technical details');
  assert.match(messages.children[0]!.children[0]!.children[1]!.textContent, /HTTP 503/);
  context.addDivider('stopped by the user'); assert.equal(messages.children[1]!.children.length, 0);
});

test('web search and external token inspection report their actual request limits', async () => {
  const { webSearch } = await import('../src/websearch.js');
  const { tokenizeWithLlama } = await import('../src/llama-tokenizer.js');
  const offline = async () => { throw new Error('PRIVATE network details'); };
  await assert.rejects(webSearch(offline, 'fixture', undefined, 25), (error: DiagnosticError) => { assert.equal(error.failure.timeoutMs, 25); assert.doesNotMatch(error.message, /PRIVATE/); return true; });
  const binding = { url: 'http://tokenizer.test', alias: 'q', identity: 'fixture' };
  for (const lookupWorks of [false, true]) {
    const fetch_ = async (url: string) => lookupWorks && url.endsWith('/v1/models') ? Response.json({ data: [{ id: 'q' }] }) : offline();
    await assert.rejects(tokenizeWithLlama(fetch_, binding, 'hello'), (error: DiagnosticError) => { assert.equal(error.failure.timeoutMs, 30_000); return true; });
  }
  const adapter = new OllamaAdapter(async url => url.endsWith('/api/chat') ? Response.json({ _debug_info: { rendered_template: 'hello' } }) : offline(), 'http://ollama.test', { q: binding });
  const inspection = await adapter.inspectTokens({ model: 'q', messages: [], stream: true, options: { num_ctx: 1000 } });
  assert.match(inspection.explanation, /Time limit: 30 seconds/); assert.doesNotMatch(inspection.explanation, /PRIVATE/);
});

test('token inspection keeps a safe explanation when an adapter supplies no timeout', async () => {
  const adapter = new OllamaAdapter(async () => Response.json({ _debug_info: { rendered_template: 'hello' } }), 'http://ollama.test', {}, {
    q: { alias: 'q', identity: 'fixture', async tokenize() { throw new DiagnosticError(failureDetails('Token inspection is unavailable.', 'harness', 'Token inspection', 'Retry.')); } }
  });
  const inspection = await adapter.inspectTokens({ model: 'q', messages: [], stream: true, options: { num_ctx: 1000 } });
  assert.match(inspection.explanation, /Token inspection is unavailable/); assert.doesNotMatch(inspection.explanation, /NaN/);
});

test('helper status reflects failed requests and recovers without a new connection when the helper comes back', async () => {
  let status = 200, offline = false;
  const info = { ollamaUrl: 'http://localhost:11434', models: ['q'], automatic: false };
  const helper = new TokenHelperClient('http://127.0.0.1:5002', async url => {
    if (offline) throw new Error('offline');
    if (status !== 200) return new Response('', { status });
    return Response.json({ value: url.endsWith('/connect') ? { token: 'fixture', ...info } : { stage: null } });
  });
  assert.equal(helper.connected, false); assert.equal(helper.info, undefined);
  await assert.rejects(helper.call('inspectionProgress'), /disconnected/);
  assert.deepEqual(await helper.connect(), info); assert.equal(helper.connected, true); assert.deepEqual(helper.info, info);
  offline = true; await assert.rejects(helper.call('inspectionProgress')); assert.equal(helper.connected, false); assert.equal(helper.info, undefined);
  offline = false; await helper.call('inspectionProgress'); assert.equal(helper.connected, true);
  status = 500; await assert.rejects(helper.call('inspectionProgress'), /denied the request \(500\)\.$/); assert.equal(helper.connected, true);
  status = 403; await assert.rejects(helper.call('inspectionProgress'), /this website allowed/); assert.equal(helper.connected, false);
  status = 401; await assert.rejects(helper.call('inspectionProgress')); assert.equal(helper.connected, false);
  status = 200; await helper.call('inspectionProgress'); assert.equal(helper.connected, true);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(helper.call('inspectionProgress', {}, aborted.signal), /cancelled/);
  await helper.close(); assert.equal(helper.connected, false); await helper.close();
  // Stopping an inspection in flight also tells the helper to cancel it.
  const seen: string[] = [], stop = new AbortController();
  const slow = new TokenHelperClient('http://127.0.0.1:5002', async (url, init) => {
    if (url.endsWith('/connect')) return Response.json({ value: { token: 'fixture', ...info } });
    const operation = JSON.parse(String(init.body)).operation as string; seen.push(operation);
    if (operation === 'inspectTokens') return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return Response.json({ value: {} });
  });
  await slow.connect(); const pending = slow.call('inspectTokens', {}, stop.signal);
  stop.abort(); await assert.rejects(pending, /cancelled/); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['inspectTokens', 'cancel']);
  for (const endpoint of ['https://127.0.0.1:5002', 'http://localhost:5002', 'http://127.0.0.1:5002/x', 'http://127.0.0.1:5002/?q=1', 'http://127.0.0.1:5002/#h', 'http://u:p@127.0.0.1:5002', 'not a url'])
    assert.throws(() => new TokenHelperClient(endpoint), /on this computer/);
});

test('unexpected non-Error tokenizer failures receive a safe explanation', async () => {
  for (const error of ['PRIVATE', new Error('PRIVATE'), new Error('Tokenizer did not return token pieces')]) {
  const adapter = new OllamaAdapter(async () => Response.json({ _debug_info: { rendered_template: 'hello' } }), 'http://ollama.test', {}, {
    q: { alias: 'q', identity: 'fixture', async tokenize() { throw error; } }
  });
  const inspection = await adapter.inspectTokens({ model: 'q', messages: [], stream: true, options: { num_ctx: 1000 } });
  assert.match(inspection.explanation, /unavailable or returned an invalid response|did not return token pieces/); assert.doesNotMatch(inspection.explanation, /PRIVATE/);
  }
});

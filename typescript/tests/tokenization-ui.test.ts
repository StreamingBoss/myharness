import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';
import { unavailable } from '../src/tokenization.js';

const launch = () => chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

test('bottom viewer explains exactness, shows real pieces/bytes and restores inspection without network calls', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-token-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  let inspected = 0;
  const harness = new NodeHarness({ workspace: root, projectRoot: root, model: 'gemini-test', contextLength: 4096, sessions: new SessionStore(path.join(root, 'sessions')), ollama: {
    provider: 'gemini-vertex', requestMetadata: () => ({ provider: 'gemini-vertex', wire_request: { contents: [{ role: 'user', parts: [{ text: 'ü <img onerror=bad()>' }] }], generationConfig: {} } }),
    async *streamChat() { yield JSON.stringify({ message: { content: 'hello' }, done: true, prompt_eval_count: 12 }); }, async request() { return {}; },
    async inspectTokens(payload) { inspected++; return { ...unavailable(payload.model, 'gemini-vertex', 'Actual provider pieces for message text; not the full inference input.'), fidelity: 'provider-content', source: 'Scripted Vertex API response', coverage: 'User message text only.', limitations: ['Hidden role markers and tool serialization are excluded.'], count: 3,
      groups: [{ label: 'User text', tokens: [{ id: '9007199254740993', bytes: [195] }, { id: '2', bytes: [188] }, { id: '3', bytes: [32, 10, 9] }] }] }; },
  } }); await harness.initialize();
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close()); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await launch(); t.after(() => browser.close()); const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await page.locator('#explore-view').selectOption('tokens'); await page.getByText('Send a message first; no saved request is available.').waitFor(); assert.equal(inspected, 0);
  await page.locator('#input').fill('ü'); await page.locator('#send').click(); await page.getByText('hello', { exact: true }).first().waitFor();
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  await page.locator('#token-inspect').waitFor({ state: 'visible' }); await page.waitForFunction(() => !(document.querySelector('#token-inspect') as HTMLButtonElement).disabled);
  assert.match(await page.locator('#terminal').textContent() ?? '', /SENT to gemini-vertex/); assert.match(await page.locator('#terminal').textContent() ?? '', /generationConfig/);
  assert.equal(await page.locator('#token-details').isVisible(), false); assert.equal(await page.locator('#token-intro').getAttribute('open'), null);
  assert.match(await page.locator('#token-inspect').getAttribute('title') ?? '', /may use provider quota/);
  await page.locator('#token-inspect').click(); await page.getByText('Provider tokenization of text', { exact: true }).waitFor(); assert.equal(inspected, 1);
  // Pieces come before the source/coverage notes and are visible without scrolling the enlarged box.
  const panel = (await page.locator('#tokenization').boundingBox())!, chip = (await page.locator('.token-chip').first().boundingBox())!, viewport = page.viewportSize()!;
  assert.ok((await page.locator('#harness-box').boundingBox())!.height >= viewport.height * 0.45 - 1); assert.ok(chip.y + chip.height <= panel.y + panel.height);
  assert.equal(await page.locator('#token-empty').count(), 0); assert.match(await page.locator('#token-about').textContent() ?? '', /Actual provider pieces.*Coverage: User message text only/);
  assert.equal(await page.locator('.token-chip').count(), 3); await page.locator('.token-chip').first().click();
  const detail = await page.locator('#token-details').textContent(); assert.match(detail!, /9007199254740993/); assert.match(detail!, /C3/); assert.match(detail!, /part of a UTF-8/);
  assert.match(await page.locator('#token-summary').textContent() ?? '', /Input count reported during generation: 12/); assert.equal(await page.locator('#tokenization img').count(), 0);
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0); await page.locator('#explore-view').selectOption('tokens'); await page.locator('.token-chip').first().waitFor(); assert.equal(inspected, 1);
  await page.locator('.token-chip').first().click();
  await page.locator('#token-groups details').first().evaluate(node => node.setAttribute('open', ''));
  const selectedDetails = await page.locator('#token-details').textContent();
  await page.evaluate(() => {
    const scope = globalThis as unknown as { tokenMutations: number };
    scope.tokenMutations = 0;
    const observer = new MutationObserver(records => { scope.tokenMutations += records.length; });
    for (const id of ['token-summary', 'token-groups', 'token-details', 'token-about']) observer.observe(document.getElementById(id)!, { childList: true, subtree: true, characterData: true, attributes: true });
  });
  await page.locator('#input').fill('second message'); await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelectorAll('#token-request option').length === 2);
  assert.equal(await page.evaluate(() => (globalThis as unknown as { tokenMutations: number }).tokenMutations), 0);
  assert.equal(await page.locator('#token-details').textContent(), selectedDetails);
  assert.equal(await page.locator('#token-groups details').first().getAttribute('open'), '');
  assert.equal(await page.locator('#token-request').inputValue(), '1');
  assert.equal(inspected, 1);
  await page.locator('#token-request').selectOption({ label: '2 · gemini-test · gemini-vertex' });
  assert.equal(await page.locator('#token-inspect').isEnabled(), true);
  await page.locator('#token-inspect').click();
  await page.getByText('Provider tokenization of text', { exact: true }).waitFor(); assert.equal(inspected, 2);
  await page.locator('#token-request').selectOption({ label: '1 · gemini-test · gemini-vertex' });
  assert.equal(await page.locator('.token-chip').count(), 3); assert.equal(inspected, 2);
  await page.locator('#explore-view').selectOption('memory'); assert.equal(await page.locator('#tokenization').isVisible(), false); assert.equal(await page.locator('#memory').isVisible(), true);
  await page.route('**/explore', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Explorer connection unavailable' }) }));
  await page.locator('#explore-view').selectOption('tools');
  await page.getByText(/Could not load this explorer view\.[\s\S]*Technical details: Explorer connection unavailable/).waitFor();
  await page.unroute('**/explore');
  assert.ok((await page.locator('#harness-box').boundingBox())!.height < page.viewportSize()!.height * 0.45 - 1); assert.deepEqual(errors, []);
});

test('viewer distinguishes count-only, configured-tokenizer, unavailable and failed inspection and ignores stale responses', async t => {
  const browser = await launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({ path: 'web/static/tokenization.js' });
  await page.evaluate(() => {
    const scope = globalThis as unknown as { TokenViewer: new (...args: unknown[]) => { render(data: unknown): void; refresh(id: string): Promise<void>; run(): Promise<void> }; viewer: { render(data: unknown): void; refresh(id: string): Promise<void>; run(): Promise<void> }; reply: unknown; status: number; mode: string; resolve: (response: Response) => void; busy: boolean[] };
    scope.status = 200; scope.mode = 'success'; scope.busy = [];
    scope.viewer = new scope.TokenViewer(document.querySelector('#root'), async (url: string) => {
      if (scope.mode === 'wait') return new Promise(resolve => { scope.resolve = resolve; });
      if (url.startsWith('/sessions/')) return Response.json({ events: [{ type: 'request', parts: [JSON.stringify({ model: 'qwen', messages: [] })] }, { type: 'context', action: 'compact_request', payload: { model: 'qwen' } }] }, { status: scope.status });
      return Response.json(scope.reply, { status: scope.status });
    }, (value: boolean) => scope.busy.push(value));
  });
  const base = { model: 'qwen', provider: 'ollama', source: 'configured tokenizer', explanation: 'Separately tokenized; not inference capture.', coverage: 'Rendered prompt.', limitations: ['Model match is operator configured.'], groups: [] };
  await page.evaluate(data => (globalThis as unknown as { viewer: { render(data: unknown): void } }).viewer.render(data), { ...base, fidelity: 'configured-tokenizer', count: 0, renderedPrompt: '<|marker|>' });
  await page.getByText('Configured tokenizer · separate tokenization', { exact: true }).waitFor(); await page.getByText('Ollama-rendered prompt text (separate inspection)').click(); assert.match(await page.locator('#root').textContent() ?? '', /<\|marker\|>/);
  // No pieces: a callout says so up front, with the backend's reason and where to read about setups that can show pieces.
  const empty = await page.locator('#token-empty').textContent() ?? '';
  assert.match(empty, /^No token pieces to show for this request\.Separately tokenized; not inference capture\.TOKENIZATION\.md describes/);
  assert.equal(await page.locator('#token-details').isVisible(), false); assert.doesNotMatch(await page.locator('#token-about').textContent() ?? '', /Separately tokenized/);
  await page.evaluate(data => (globalThis as unknown as { viewer: { render(data: unknown): void } }).viewer.render(data), { ...base, fidelity: 'count-only', count: 10 }); assert.match(await page.locator('#token-summary').textContent() ?? '', /Count only/); assert.equal(await page.locator('.token-chip').count(), 0);
  assert.match(await page.locator('#token-about').textContent() ?? '', /Model: qwen · Provider: ollama · Source: configured tokenizer.*Coverage: Rendered prompt\.Model match is operator configured\./);
  await page.evaluate(data => (globalThis as unknown as { viewer: { render(data: unknown): void } }).viewer.render(data), { ...base, fidelity: 'configured-tokenizer', count: 1, groups: [{ label: 'Prompt', tokens: [{ id: '7', bytes: [104] }] }] });
  assert.equal(await page.locator('#token-empty').count(), 0); assert.equal(await page.locator('#token-details').isVisible(), true); assert.match(await page.locator('#token-about').textContent() ?? '', /Separately tokenized/);
  await page.evaluate(data => { const s = globalThis as unknown as { viewer: { refresh(id: string): Promise<void> }; reply: unknown }; s.reply = data; return s.viewer.refresh('id'); }, { ...base, fidelity: 'unavailable' });
  await page.locator('#token-request').selectOption('0'); await page.locator('#token-inspect').click(); await page.getByText('Token sequence unavailable', { exact: true }).waitFor(); assert.equal(await page.locator('#token-inspect').isEnabled(), true);
  await page.evaluate(() => { (globalThis as unknown as { status: number }).status = 400; }); await page.locator('#token-inspect').click(); await page.getByText('Inspection failed. Check the connection and retry. No token sequence is shown.').waitFor();
  await page.evaluate(() => (globalThis as unknown as { viewer: { refresh(id: string): Promise<void> } }).viewer.refresh('id')); await page.getByText('Could not load saved requests. Choose the active session and try again.').waitFor();
  await page.evaluate(() => { const s = globalThis as unknown as { status: number; mode: string; viewer: { refresh(id: string): Promise<void> } }; s.status = 200; s.mode = 'wait'; void s.viewer.refresh('stale'); });
  await page.evaluate(() => { const s = globalThis as unknown as { mode: string; viewer: { refresh(id: string): Promise<void> } }; s.mode = 'success'; return s.viewer.refresh('current'); });
  await page.evaluate(() => (globalThis as unknown as { resolve(response: Response): void }).resolve(Response.json({ events: [] }))); assert.equal(await page.locator('#token-request option').count(), 2);
});

test('viewer refresh renders changed evidence and handles removed requests in the same session', async t => {
  const browser = await launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({ path: 'web/static/tokenization.js' });
  await page.evaluate(async () => {
    const scope = globalThis as unknown as { TokenViewer: new (...args: unknown[]) => { refresh(id: string): Promise<void> }; viewer: { refresh(id: string): Promise<void> }; events: unknown[] };
    scope.events = [{ type: 'request', model_request: { model: 'qwen' } }];
    scope.viewer = new scope.TokenViewer(document.getElementById('root'), async () => Response.json({ events: scope.events }), () => {});
    await scope.viewer.refresh('current');
  });
  assert.match(await page.locator('#token-summary').innerText(), /Not inspected/);
  await page.evaluate(async () => {
    const scope = globalThis as unknown as { viewer: { refresh(id: string): Promise<void> }; events: unknown[] };
    scope.events.push({ type: 'tokenization', request_index: 0, inspection: { model: 'qwen', provider: 'ollama', fidelity: 'count-only', source: 'fixture', explanation: 'fixture', coverage: 'fixture', count: 10, groups: [], limitations: [] } });
    await scope.viewer.refresh('current');
  });
  assert.match(await page.locator('#token-summary').innerText(), /Inspection count: 10/);
  await page.evaluate(async () => {
    const scope = globalThis as unknown as { viewer: { refresh(id: string): Promise<void> }; events: unknown[] };
    scope.events = []; await scope.viewer.refresh('current');
  });
  assert.equal(await page.locator('#token-request option').count(), 0);
  assert.match(await page.locator('#token-summary').innerText(), /no saved request/);
  assert.equal(await page.locator('#token-inspect').isEnabled(), false);
});

test('viewer shows backend loading, rendering and tokenizing stages and ignores late progress', async t => {
  const browser = await launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({ path: 'web/static/tokenization.js' });
  await page.evaluate(async () => {
    const state = globalThis as unknown as { TokenViewer: new (...args: unknown[]) => { refresh(id: string): Promise<void> }; stage: string; resolveResult(value: Response): void; resolveProgress?: (value: Response) => void; deferProgress: boolean };
    state.stage = 'Loading tokenizer vocabulary in llama.cpp… Model weights are skipped.';
    const viewer = new state.TokenViewer(document.getElementById('root'), async (url: string) => {
      if (url.startsWith('/sessions/')) return Response.json({ events: [{ type: 'request', provider: 'ollama', model_request: { model: 'qwen3:8b' } }] });
      if (url === '/tokenize/progress') {
        if (state.deferProgress) return new Promise<Response>(resolve => { state.resolveProgress = resolve; });
        return Response.json({ sessionId: 'current', eventIndex: 0, message: state.stage });
      }
      return new Promise<Response>(resolve => { state.resolveResult = resolve; });
    }, () => {});
    await viewer.refresh('current');
  });
  await page.locator('#token-inspect').click();
  await page.getByText('Loading tokenizer vocabulary in llama.cpp… Model weights are skipped.', { exact: true }).waitFor();
  for (const stage of ['Rendering the saved prompt with Ollama…', 'Tokenizing the rendered prompt with llama.cpp…']) {
    await page.evaluate(value => { (globalThis as unknown as { stage: string }).stage = value; }, stage);
    await page.getByText(stage, { exact: true }).waitFor();
  }
  await page.evaluate(() => { (globalThis as unknown as { deferProgress: boolean }).deferProgress = true; });
  await page.waitForFunction(() => !!(globalThis as unknown as { resolveProgress?: unknown }).resolveProgress);
  await page.evaluate(() => {
    const state = globalThis as unknown as { resolveResult(value: Response): void };
    state.resolveResult(Response.json({ model: 'qwen3:8b', provider: 'ollama', source: 'fixture', fidelity: 'configured-tokenizer', explanation: 'fixture', coverage: 'fixture', limitations: [], groups: [{ label: 'Prompt', tokens: [{ id: '42', bytes: [104] }] }] }));
  });
  await page.locator('.token-chip').waitFor();
  await page.evaluate(() => { (globalThis as unknown as { resolveProgress(value: Response): void }).resolveProgress(Response.json({ sessionId: 'current', eventIndex: 0, message: 'STALE loading' })); });
  assert.match(await page.locator('#token-summary').innerText(), /Configured tokenizer/);
  assert.ok(!(await page.locator('#token-summary').innerText()).includes('STALE'));
});

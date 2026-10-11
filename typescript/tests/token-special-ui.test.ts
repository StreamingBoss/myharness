import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';
import { tokenPiece, unavailable } from '../src/tokenization.js';

test('the token viewer explains a special token on hover and click, and leaves ordinary tokens plain', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-special-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const harness = new NodeHarness({ workspace: root, projectRoot: root, model: 'qwen-test', contextLength: 4096, sessions: new SessionStore(path.join(root, 'sessions')), ollama: {
    async *streamChat() { yield JSON.stringify({ message: { content: 'hello' }, done: true, prompt_eval_count: 5 }); }, async request() { return {}; },
    async inspectTokens(payload) {
      return { ...unavailable(payload.model, 'ollama', 'Scripted'), fidelity: 'configured-tokenizer', source: 'Scripted tokenizer', coverage: 'Everything.', limitations: [], count: 3,
        groups: [{ label: 'Prompt', tokens: [tokenPiece(151645, '<|im_end|>'), tokenPiece(198, '\n'), tokenPiece(14990, 'hello')] }] };
    },
  } }); await harness.initialize();
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await page.locator('#input').fill('hi'); await page.locator('#send').click(); await page.getByText('hello', { exact: true }).first().waitFor();
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  await page.locator('#explore-view').selectOption('tokens'); await page.waitForFunction(() => !(document.querySelector('#token-inspect') as HTMLButtonElement).disabled);
  await page.locator('#token-inspect').click(); await page.locator('.token-chip').first().waitFor();
  const chips = page.locator('.token-chip');
  assert.match(await chips.nth(0).getAttribute('title') ?? '', /^Token 1 · ID 151645\nSpecial token: end of message \(ChatML: Qwen and others\)\nEnds a message\..*the harness knows the reply is complete\.$/);
  assert.equal(await chips.nth(2).getAttribute('title'), 'Token 3 · ID 14990');
  assert.match(await page.locator('#token-details').textContent() ?? '', /Hover over or click a special token such as <\|im_end\|>/);
  await chips.nth(0).click();
  assert.match(await page.locator('#token-details').textContent() ?? '', /Piece: "<\|im_end\|>"\nSpecial token: end of message \(ChatML: Qwen and others\)\nEnds a message\./);
  await chips.nth(2).click();
  assert.doesNotMatch(await page.locator('#token-details').textContent() ?? '', /Special token/);
  assert.deepEqual(errors, []);
});

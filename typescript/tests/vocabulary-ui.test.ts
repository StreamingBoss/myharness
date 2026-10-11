import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { createHarnessServer } from '../src/node/http.js';

const tokens = Array.from({ length: 250 }, (_, id) => id === 5 ? 'Ġhello' : id === 6 ? 'hello' : id === 7 ? 'ä¹' : id === 248 ? '<|im_end|>' : id === 249 ? '<|new_marker|>' : `p${id}`);
const types = tokens.map((_, id) => id >= 248 ? 3 : 1);
const info = { 'tokenizer.ggml.model': 'gpt2', 'tokenizer.ggml.tokens': tokens, 'tokenizer.ggml.token_type': types, 'tokenizer.ggml.eos_token_id': 248 };

async function open(t: test.TestContext, show: () => Promise<Record<string, unknown>>) {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-vocabulary-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const harness = new NodeHarness({ workspace: root, projectRoot: root, model: 'qwen-test', contextLength: 4096, ollama: { async *streamChat() {}, request: show } as never });
  await harness.initialize(); t.after(() => harness.close());
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await page.locator('#explore-view').selectOption('vocabulary');
  return { page, errors };
}

test('the vocabulary view browses by ID, finds pieces, jumps to an ID and explains special tokens', async t => {
  const { page, errors } = await open(t, async () => ({ model_info: info }));
  await page.locator('#vocabulary-table tbody tr').first().waitFor();
  assert.equal(await page.locator('#vocabulary').isVisible(), true); assert.equal(await page.locator('#tokenization').isVisible(), false);
  assert.match(await page.locator('#vocabulary-status').innerText(), /qwen-test · 250 tokens \(248 ordinary pieces, 2 control tokens\) · EOS = 248\n\nByte-level BPE/);
  assert.match(await page.locator('#vocabulary-status').innerText(), /Showing IDs 0 to 99\./);
  assert.equal(await page.locator('#vocabulary-table tbody tr').count(), 100);
  assert.equal(await page.locator('#vocabulary-previous').isDisabled(), true);
  await page.locator('#vocabulary-next').click(); await page.getByText('Showing IDs 100 to 199.').waitFor();
  await page.locator('#vocabulary-next').click(); await page.getByText('Showing IDs 200 to 249.').waitFor();
  assert.equal(await page.locator('#vocabulary-next').isDisabled(), true);
  await page.locator('#vocabulary-previous').click(); await page.getByText('Showing IDs 100 to 199.').waitFor();
  await page.locator('#vocabulary-search').fill('hello'); await page.locator('#vocabulary-find').click(); await page.getByText('2 matches.').waitFor();
  assert.deepEqual(await page.locator('#vocabulary-table tbody tr').evaluateAll(rows => rows.map(row => [...row.children].slice(0, 3).map(cell => cell.textContent))), [['5', '·hello', '20 68 65 6C 6C 6F'], ['6', 'hello', '68 65 6C 6C 6F']]);
  await page.locator('#vocabulary-exact').check(); await page.locator('#vocabulary-search').fill(' hello'); await page.locator('#vocabulary-search').press('Enter'); await page.getByText('1 match.').waitFor();
  await page.locator('#vocabulary-search').fill('hel'); await page.locator('#vocabulary-find').click(); await page.getByText('No token matches.').waitFor();
  await page.locator('#vocabulary-id').fill('248'); await page.locator('#vocabulary-id').press('Enter'); await page.getByText("Showing IDs 150 to 249 (the one you asked for is highlighted).").waitFor();
  const special = page.locator('#vocabulary-table tbody tr.vocabulary-focus');
  assert.equal(await special.count(), 1); assert.match(await special.innerText(), /^248\t<\|im_end\|>\t3C 7C 69 6D 5F 65 6E 64 7C 3E\tcontrol token: end of message/);
  assert.match(await special.locator('td').last().getAttribute('title') ?? '', /^end of message \(ChatML: Qwen and others\)\nEnds a message\./);
  assert.equal((await page.locator('tr', { hasText: '<|new_marker|>' }).locator('td').last().innerText()), 'control token');
  assert.match(await page.locator('tr', { hasText: '<|new_marker|>' }).locator('td').last().getAttribute('title') ?? '', /^control token \(model-specific\)\nWritten between/);
  await page.locator('#vocabulary-search').fill('ä'); await page.locator('#vocabulary-find').click(); await page.getByText('No token matches.').waitFor();
  await page.locator('#vocabulary-id').fill('7'); await page.locator('#vocabulary-go').click(); await page.locator('tr.vocabulary-focus').waitFor();
  assert.match(await page.locator('tr.vocabulary-focus').innerText(), /^7\t\\xE4\\xB9\tE4 B9\tordinary piece \(part of a character\)/);
  await page.locator('#vocabulary-id').fill(''); await page.locator('#vocabulary-go').click();
  await page.locator('#vocabulary-id').fill('9999'); await page.locator('#vocabulary-go').click(); await page.getByText(/Could not read the vocabulary\. around must be a whole number from 0 to 249/).waitFor();
  await page.locator('#explore-view').selectOption('memory'); assert.equal(await page.locator('#vocabulary').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('the vocabulary view says why it is empty', async t => {
  const { page } = await open(t, async () => ({ template: 'remote' }));
  await page.getByText(/This model did not publish its vocabulary/).waitFor();
  assert.equal(await page.locator('#vocabulary-table tbody tr').count(), 0);
  assert.equal(await page.locator('#vocabulary-next').isDisabled(), true);
});

test('a broken connection is reported and the next request recovers', async t => {
  const { page } = await open(t, async () => ({ model_info: info }));
  await page.locator('#vocabulary-table tbody tr').first().waitFor();
  await page.route('**/vocabulary', route => route.abort());
  await page.locator('#vocabulary-find').click(); await page.getByText(/^Could not read the vocabulary\./).waitFor();
  await page.unroute('**/vocabulary');
  await page.locator('#vocabulary-find').click(); await page.getByText('Showing IDs 0 to 99.').waitFor();
});

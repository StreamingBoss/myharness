import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';

const info = { 'general.architecture': 'qwen2', 'qwen2.attention.head_count': 28, 'qwen2.attention.head_count_kv': 4, 'qwen2.block_count': 28, 'qwen2.context_length': 32768, 'qwen2.embedding_length': 3584 };

test('the UI prints prefix reuse, prefill/decode timing and the turn timeline, live and after replay, and the KV estimate', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-timing-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const turns = [
    { message: { tool_calls: [{ function: { name: 'pwd', arguments: {} } }] }, done: true, prompt_eval_count: 900, eval_count: 12, load_duration: 14.7e9, prompt_eval_duration: 12.2e9, eval_duration: 0.3e9 },
    { message: { content: 'all done' }, done: true, prompt_eval_count: 950, eval_count: 3, load_duration: 9e6, prompt_eval_duration: 16e6, eval_duration: 40e6 },
  ];
  const harness = new NodeHarness({ workspace: root, model: 'qwen2.5:7b', contextLength: 4096, sessions: new SessionStore(path.join(root, 'sessions')), ollama: {
    async *streamChat() { yield JSON.stringify(turns.shift()); }, async request() { return { template: '{{ .Prompt }}', parameters: '', model_info: info }; },
  } });
  await harness.initialize(); t.after(() => harness.close());
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await page.locator('.tool-menu summary').evaluateAll(items => items.forEach(item => (item.parentElement as HTMLDetailsElement).open = true));
  await page.locator('input.tool-checkbox[value="pwd"]').check();
  await page.locator('#input').fill('where am I'); await page.locator('#send').click();
  await page.getByText('all done', { exact: true }).first().waitFor();
  const check = (text: string) => {
    assert.match(text, /PREFIX REUSE\n-+\nFirst request since this session was loaded/);
    assert.match(text, /PREFIX REUSE\n-+\nThe first \d+ of \d+ messages are identical to the previous request/);
    assert.match(text, /TIMING\n-+\nload {6}14\.7 s {2}the model was loaded into memory first \(cold start/);
    assert.match(text, /prefill {3}950 prompt tokens in 16 ms = 59,375 tokens\/s/);
    assert.match(text, /of these tokens matched the previous request\. Ollama keeps their KV cache/);
    assert.match(text, /TURN TIMELINE\n-+\nround {5}input {3}output/);
    assert.match(text, /2 model calls, 1,850 input tokens sent in total, 15 output tokens/);
  };
  check(await page.locator('#terminal').innerText());
  assert.match(await page.locator('#internals-header, .pane-header').filter({ hasText: 'Internals' }).first().getAttribute('title') ?? '', /TURN TIMELINE: every round of a tool-using turn sends the whole conversation again/);
  await page.reload(); await page.getByText('all done', { exact: true }).first().waitFor();
  check(await page.locator('#terminal').innerText());
  await page.locator('#explore-view').selectOption('template');
  await page.getByText('KV CACHE (estimate)', { exact: false }).waitFor();
  assert.match(await page.locator('#explore').innerText(), /= 56 KiB for every token kept in context\n\nworking context 4,096 tokens → 224 MiB\nmodel maximum {3}32,768 tokens → 1\.75 GiB/);
  assert.deepEqual(errors, []);
});

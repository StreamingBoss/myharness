import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';

test('browser hydrates the existing UI, streams a terminal reply, and restores saved history', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-browser-')); t.after(() => rm(root, { recursive: true, force: true }));
  const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 4096, sessions: new SessionStore(path.join(root, 'sessions')), ollama: { async *streamChat() { yield JSON.stringify({ message: { content: 'Hello from TypeScript' }, done: true, prompt_eval_count: 20, eval_count: 3 }); }, async request() { return {}; } } });
  await harness.initialize();
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await page.locator('#input').fill('hello'); await page.locator('#send').click();
  await page.getByText('Hello from TypeScript', { exact: true }).first().waitFor();
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  await page.reload(); await page.getByText('Hello from TypeScript', { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
});

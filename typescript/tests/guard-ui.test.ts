import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';

const call = (name: string, args: Record<string, unknown> = {}) => ({ message: { tool_calls: [{ function: { name, arguments: args } }] }, done: true });

test('the UI shows the repeat-guard reminder and why an unanswered approval did not run, live and after replay', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-guard-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const turns = [call('pwd'), call('pwd'), call('pwd'), call('run_command', { command: 'echo never' }), { message: { content: 'all done' }, done: true }];
  const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 8192, approvalTimeoutMs: 150, sessions: new SessionStore(path.join(root, 'sessions')), ollama: {
    async *streamChat() { yield JSON.stringify(turns.shift()); }, async request() { return {}; },
  } });
  await harness.initialize(); t.after(() => harness.close());
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await page.locator('.tool-menu summary').evaluateAll(items => items.forEach(item => (item.parentElement as HTMLDetailsElement).open = true));
  for (const name of ['pwd', 'run_command']) await page.locator(`input.tool-checkbox[value="${name}"]`).check();
  await page.locator('#input').fill('look around'); await page.locator('#send').click();
  await page.getByText('all done', { exact: true }).first().waitFor();
  const live = await page.locator('#terminal').innerText();
  assert.match(live, /GUARD — repeated tool call \(pwd x3, gentle reminder added to the conversation\)/);
  assert.match(live, /\[harness reminder\] You are repeating the exact same tool call/);
  assert.match(live, /COMMAND — no answer/);
  assert.match(await page.locator('.change-status').last().innerText(), /no answer/);
  await page.reload(); await page.getByText('all done', { exact: true }).first().waitFor();
  const replayed = await page.locator('#terminal').innerText();
  assert.match(replayed, /GUARD — repeated tool call/); assert.match(replayed, /COMMAND — no answer/);
  assert.deepEqual(errors, []);
});

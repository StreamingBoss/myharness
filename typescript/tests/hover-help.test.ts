import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Page } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { createHarnessServer } from '../src/node/http.js';

async function checkHelp(page: Page) {
  const missing = await page.locator('input:not([type=file]), select, textarea, button').evaluateAll(controls => controls.filter(control => {
    const help = control.closest('[title]')?.getAttribute('title') ?? '';
    return help.trim().length < 20;
  }).map(control => control.id || control.getAttribute('aria-label') || control.textContent));
  assert.deepEqual(missing, [], 'Every setting and action has explanatory hover text');
  const families = await page.locator('.tool-family legend').allTextContents();
  for (const name of ['Files', 'Search', 'Workflow']) assert.ok(families.includes(name));
  const fileTools = page.locator('.tool-family').filter({ has: page.locator('legend', { hasText: 'Files' }) });
  assert.equal(await fileTools.locator('input[value="read_file"]').count(), 1);
  assert.equal(await fileTools.locator('input[value="write_file"]').count(), 1);
  assert.equal(await page.locator('.tool-checkbox').count(), await page.locator('.tool-family .tool-checkbox').count());
  assert.equal(await page.locator('#tool-list').evaluate(list => getComputedStyle(list).flexWrap), 'nowrap');
  assert.equal(await fileTools.evaluate(group => getComputedStyle(group).flexDirection), 'column');
  const filesBox = await fileTools.boundingBox();
  const searchBox = await page.locator('.tool-family').filter({ has: page.locator('legend', { hasText: 'Search' }) }).boundingBox();
  assert.ok(filesBox && searchBox);
  assert.equal(Math.round(filesBox.y), Math.round(searchBox.y));
  assert.ok(searchBox.x > filesBox.x + filesBox.width);
  const readBox = await fileTools.locator('input[value="read_file"]').boundingBox();
  const writeBox = await fileTools.locator('input[value="write_file"]').boundingBox();
  assert.ok(readBox && writeBox);
  assert.equal(readBox.x, writeBox.x);
  assert.ok(writeBox.y > readBox.y);
  assert.equal(await page.locator('#orchestration').isVisible(), false);
  await page.locator('#under-the-hood').click();
  assert.equal(await page.locator('#orchestration').isVisible(), true);
  assert.equal(await page.locator('#orchestration input, #orchestration select, #orchestration textarea').count(), 0);
  assert.match(await page.locator('#ask-approval').getAttribute('title') || '', /denied.*immediately/);
}

test('Node and standalone browser settings explain their effects on hover', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-hover-')); t.after(() => rm(root, { recursive: true, force: true }));
  const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 8192, ollama: { async *streamChat() { yield ''; } } });
  await harness.initialize(); t.after(() => harness.close());
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await checkHelp(page);

  const child = spawn(process.execPath, ['scripts/serve-browser.mjs'], { env: { ...process.env, MYHARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }); t.after(() => child.kill('SIGTERM'));
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Static server did not start')), 10000);
    let output = ''; child.stdout.on('data', chunk => {
      output += String(chunk); const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.once('error', reject);
  });
  const standalone = await browser.newPage();
  await standalone.route('http://localhost:11434/api/tags', route => route.fulfill({ json: { models: [{ name: 'qwen3:8b' }] } }));
  await standalone.goto(base + '/?database=hover-help');
  await standalone.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await checkHelp(standalone);
  assert.match(await standalone.locator('#browser-api-key').getAttribute('title') || '', /Worker memory.*never saved/);
  await standalone.locator('#browser-model-mode').selectOption('gemini');
  await standalone.locator('#browser-token-budgets summary').click();
  await standalone.locator('#browser-context-limit').hover();
  assert.match(await standalone.locator('#browser-context-limit').getAttribute('title') || '', /75%.*90%.*new session/);
  assert.match(await standalone.locator('#browser-output-limit').getAttribute('title') || '', /reasoning.*working-context/);
});

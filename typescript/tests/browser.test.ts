import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await page.locator('#input').fill('hello'); await page.locator('#send').click();
  await page.getByText('Hello from TypeScript', { exact: true }).first().waitFor();
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  assert.equal(await page.locator('#terminal .sent b').first().evaluate(element => getComputedStyle(element).color), 'rgb(255, 92, 92)');
  await page.evaluate(() => {
    // Exercise native cloud display without credentials or network inference.
    (window as unknown as { printModelRequest(event: unknown, saved: boolean): void }).printModelRequest({ provider: 'gemini', wire_request: { input: [{ type: 'user_input', content: [{ type: 'text', text: 'Gemini user input' }] }] } }, false);
  });
  assert.match(await page.locator('#terminal .sent b').last().innerText(), /Gemini user input/);
  assert.equal(await page.locator('#terminal .sent b').last().evaluate(element => getComputedStyle(element).color), 'rgb(255, 92, 92)');
  const nextProject = path.join(root, 'next-project'); await mkdir(nextProject);
  await page.locator('#project').fill(nextProject); await page.locator('#set-project').click();
  await page.waitForFunction(folder => document.getElementById('session-select')!.textContent!.includes(folder), nextProject);
  assert.equal(harness.state.workspace, nextProject);
  assert.equal(await page.locator('#project-error').innerText(), '');
  assert.match(await page.locator('#messages').innerText(), /Hello from TypeScript/);
  await page.locator('#input').fill('hello from the next project'); await page.locator('#send').click();
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  assert.equal(harness.activeSessionRecord().workspace, nextProject);
  await page.reload(); await page.getByText('Hello from TypeScript', { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
});

test('a separately served UI approves a write and exports the backend session', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-browser-split-')); t.after(() => rm(root, { recursive: true, force: true }));
  const ui = createServer(async (request, response) => { const file = request.url!.startsWith('/static/') ? path.join(process.cwd(), 'web', request.url!) : path.join(process.cwd(), 'web/templates/index.html'); response.end(await readFile(file)); });
  await new Promise<void>(resolve => ui.listen(0, '127.0.0.1', resolve)); t.after(() => ui.close());
  const uiAddress = ui.address(); assert.ok(uiAddress && typeof uiAddress !== 'string'); const origin = `http://127.0.0.1:${uiAddress.port}`;
  let turn = 0;
  const harness = new NodeHarness({ workspace: root, projectRoot: root, model: 'qwen3:8b', contextLength: 4096, sessions: new SessionStore(path.join(root, 'sessions')), ollama: { async *streamChat() { yield JSON.stringify({ message: ++turn === 1 ? { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'approved.txt', content: 'approved in browser' } } }] } : { content: 'Write completed' }, done: true }); }, async request() { return {}; } } });
  await harness.initialize(); const backend = createHarnessServer(harness, { uiOrigins: origin });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve)); t.after(() => backend.close());
  const address = backend.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/?api=' + encodeURIComponent(base)); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length === 14);
  await page.locator('#input').fill('write'); await page.locator('#send').click(); await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('Write completed', { exact: true }).first().waitFor(); assert.equal(await readFile(path.join(root, 'approved.txt'), 'utf8'), 'approved in browser');
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  const download = page.waitForEvent('download'); await page.locator('#export-session').click(); const exported = await download;
  assert.equal(exported.url(), base + '/sessions/' + harness.activeSessionRecord().id + '/export');
  assert.match(await readFile((await exported.path())!, 'utf8'), /approved in browser/);
  assert.deepEqual(errors, []);
});

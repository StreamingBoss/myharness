import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { createHarnessServer } from '../src/node/http.js';

const visible = (page: Page, selector: string) => page.locator(selector).isVisible();
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test('on a phone the page uses the device width, shows one pane at a time and brings an approval back into view', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-phone-')); t.after(() => rm(root, { recursive: true, force: true }));
  let release!: () => void; const switched = new Promise<void>(resolve => { release = resolve; });
  const turns = [{ message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'note.txt', content: 'hi' } } }] }, done: true }, { message: { content: 'written' }, done: true }];
  const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 8192, ollama: {
    async *streamChat() { await switched; yield JSON.stringify(turns.shift()); }, async request() { return {}; },
  } });
  await harness.initialize(); t.after(() => harness.close());
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const errors: string[] = [];

  // A phone: without the viewport tag it would lay the page out at 980 px and shrink it.
  const phone = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await phone.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/?lang=de`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  assert.equal(await page.evaluate(() => innerWidth), 320); assert.ok(await noSideScroll(page));
  assert.ok(await visible(page, '#pane-switch')); assert.ok(await visible(page, '#chat-pane')); assert.equal(await visible(page, '#inspector'), false);
  assert.equal(await page.locator('#splitter').isVisible(), false);
  assert.equal(await page.locator('#input').evaluate(input => getComputedStyle(input).fontSize), '16px', 'phones zoom into fields under 16 px');
  const send = (await page.locator('#send').boundingBox())!, box = (await page.locator('#input').boundingBox())!;
  assert.ok(send.x > box.x + box.width && Math.abs(send.y - box.y) < 2, 'Send sits beside the message box');

  await page.locator('#pane-switch [data-pane="inspector"]').click();
  assert.equal(await visible(page, '#chat-pane'), false); assert.ok(await visible(page, '#inspector'));
  assert.equal(await page.locator('#pane-switch [data-pane="inspector"]').getAttribute('aria-pressed'), 'true');
  assert.ok(await noSideScroll(page));
  for (const open of ['#sessions-btn', '#open-settings']) {
    await page.locator(open).click(); assert.ok(await noSideScroll(page));
    const panel = (await page.locator(open === '#sessions-btn' ? '#sessions-panel' : '#settings-drawer').boundingBox())!;
    assert.ok(panel.x >= 0 && panel.x + panel.width <= 320);
    await page.locator(open === '#sessions-btn' ? '#close-sessions' : '#close-settings').click();
  }

  // Send from the chat, look at the inspector while the model answers: the approval must not stay hidden there.
  await page.locator('#pane-switch [data-pane="chat"]').click();
  await page.locator('#input').fill('write a note'); await page.locator('#send').click();
  await page.locator('#pane-switch [data-pane="inspector"]').click(); assert.equal(await visible(page, '#chat-pane'), false);
  release();
  await page.locator('.change-actions .approve').waitFor();
  assert.ok(await visible(page, '#chat-pane')); assert.equal(await page.locator('#pane-switch [data-pane="chat"]').getAttribute('aria-pressed'), 'true');
  await page.locator('.change-actions .approve').click(); await page.getByText('written', { exact: true }).first().waitFor();
  await phone.close();

  // A desktop keeps both panes side by side and no switch.
  const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } }); desk.on('pageerror', error => errors.push(error.message));
  await desk.goto(`http://127.0.0.1:${address.port}`); await desk.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  assert.equal(await visible(desk, '#pane-switch'), false); assert.ok(await visible(desk, '#chat-pane')); assert.ok(await visible(desk, '#inspector'));
  const chat = (await desk.locator('#chat-pane').boundingBox())!, inspector = (await desk.locator('#inspector').boundingBox())!;
  assert.ok(inspector.x > chat.x + chat.width - 1);
  assert.deepEqual(errors, []);
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import type { ModelRequest } from '../src/core.js';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';

// A message sent while a turn runs is queued and sent when that turn ends; Stop holds the queue back in the message box.
test('the message box stays usable during a turn: Send queues, the queue runs after the turn, and Stop holds it back', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-queue-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'old.txt'), 'x\n');
  const asked: string[] = [];
  // The first request of "first" and "third" asks to delete a file, so the turn waits for approval; anything else is answered.
  const harness = new NodeHarness({ workspace: root, projectRoot: root, model: 'qwen3:8b', contextLength: 32768, sessions: new SessionStore(path.join(root, 'sessions')), ollama: {
    async *streamChat(payload: ModelRequest) {
      const last = payload.messages.at(-1)!, user = [...payload.messages].reverse().find(message => message.role === 'user')!.content;
      asked.push(user);
      yield JSON.stringify(last.role === 'user' && ['first', 'third'].includes(user)
        ? { message: { tool_calls: [{ function: { name: 'delete_file', arguments: { path: 'old.txt' } } }] }, done: true }
        : { message: { content: 'answer to ' + user }, done: true });
    }, async request() { return {}; },
  } });
  await harness.initialize(); t.after(() => harness.close());
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  const idle = () => page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled && (document.querySelector('#stop') as HTMLButtonElement).hidden);
  const approve = page.getByRole('button', { name: 'Approve', exact: true });

  // While the turn waits for approval, the box and Send stay usable next to Stop, and Send queues.
  await page.locator('#input').fill('first'); await page.locator('#send').click();
  await approve.waitFor();
  assert.equal(await page.locator('#input').isEnabled(), true); assert.equal(await page.locator('#send').isVisible(), true); assert.equal(await page.locator('#stop').isVisible(), true);
  await page.locator('#input').fill('second'); await page.locator('#input').press('Enter');
  assert.equal(await page.locator('#queue-note').innerText(), '1 message queued. It is sent when the current answer ends.');
  assert.equal(await page.locator('#input').inputValue(), '');
  await page.locator('#input').fill('second b'); await page.locator('#send').click();
  assert.match(await page.locator('#queue-note').innerText(), /^2 messages queued\./);
  assert.deepEqual(asked, ['first']);
  // An approval waiting holds the queue back; when the turn ends, the queued messages are sent in order.
  await approve.click();
  await page.locator('#messages').getByText('answer to second b', { exact: true }).waitFor(); await idle();
  assert.deepEqual(asked, ['first', 'first', 'second', 'second b']);
  assert.equal(await page.locator('#queue-note').isHidden(), true);

  // Stop holds the queue back: the queued message returns to the message box and is not sent.
  await writeFile(path.join(root, 'old.txt'), 'x\n');
  await page.locator('#input').fill('third'); await page.locator('#send').click();
  await approve.waitFor();
  await page.locator('#input').fill('fourth'); await page.locator('#send').click();
  await page.locator('#input').fill('draft'); await page.locator('#stop').click();
  await idle();
  assert.equal(await page.locator('#input').inputValue(), 'fourth\n\ndraft');
  assert.equal(await page.locator('#queue-note').isHidden(), true);
  assert.equal(asked.includes('fourth'), false);
  assert.deepEqual(errors, []);
});

import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';
import { real, repository } from './git-helpers.js';

const call = (name: string, args: Record<string, unknown> = {}) => ({ message: { tool_calls: [{ function: { name, arguments: args } }] }, done: true });
const exists = (file: string) => access(file).then(() => true, () => false);

test('the UI shows approvals for deletions, moves and git changes, a plan checklist, and the same after replay', async t => {
  const root = await repository(t); real(root, 'config', 'user.name', 'UI'); real(root, 'config', 'user.email', 'ui@example.org');
  await writeFile(path.join(root, 'old.txt'), 'goodbye\n'); await writeFile(path.join(root, 'keep.txt'), 'keep\n');
  const turns = [
    call('update_plan', { items: [{ step: 'delete old.txt', status: 'in_progress' }, { step: 'commit', status: 'pending' }] }),
    call('delete_file', { path: 'old.txt' }), call('move_file', { from: 'keep.txt', to: 'kept/keep.txt' }), call('git_commit', { message: 'tidy up', paths: ['kept'] }),
    call('delete_file', { path: 'kept/keep.txt' }), { message: { content: 'all finished' }, done: true },
  ];
  const harness = new NodeHarness({ workspace: root, projectRoot: root, model: 'qwen3:8b', contextLength: 32768, sessions: new SessionStore(path.join(root, 'sessions')), ollama: {
    async *streamChat() { yield JSON.stringify(turns.shift()); }, async request() { return {}; },
  } });
  await harness.initialize(); t.after(() => harness.close());
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  const offered = await page.locator('.tool-checkbox').evaluateAll(boxes => boxes.map(box => (box as HTMLInputElement).value));
  for (const name of ['delete_file', 'move_file', 'update_plan', 'git_status', 'git_commit']) assert.ok(offered.includes(name), name);
  await page.locator('#input').fill('tidy the project'); await page.locator('#send').click();

  const approve = page.getByRole('button', { name: 'Approve', exact: true }), deny = page.getByRole('button', { name: 'Deny', exact: true });
  await page.locator('.plan').waitFor();
  assert.equal(await page.locator('.plan-title').innerText(), 'Plan updated (0 of 2 done):'); assert.deepEqual(await page.locator('.plan-item').allInnerTexts(), ['[~] delete old.txt', '[ ] commit']);
  await page.locator('.change-title', { hasText: 'delete_file wants to delete old.txt' }).waitFor();
  assert.match(await page.locator('.change').last().innerText(), /-goodbye/); await approve.click();
  await page.locator('.change-status', { hasText: "ok: deleted 'old.txt'" }).waitFor(); assert.equal(await exists(path.join(root, 'old.txt')), false);
  await page.locator('.change-title', { hasText: 'move_file wants to move keep.txt' }).waitFor(); assert.match(await page.locator('.change').last().innerText(), /keep\.txt\n\s+-> kept\/keep\.txt/); await approve.click();
  await page.locator('.change-status', { hasText: "ok: moved 'keep.txt' to 'kept/keep.txt'" }).waitFor();
  await page.locator('.change-title', { hasText: /git_commit wants to commit on main/ }).waitFor(); assert.match(await page.locator('.change').last().innerText(), /Message: tidy up[\s\S]*kept\/keep\.txt/);
  assert.equal(real(root, 'log', '--format=%s').trim(), 'first'); await approve.click();
  await page.locator('.change-status', { hasText: /ok: committed [0-9a-f]{7} tidy up/ }).waitFor(); assert.equal(real(root, 'log', '-1', '--format=%s').trim(), 'tidy up');
  await page.locator('.change-title', { hasText: 'delete_file wants to delete kept/keep.txt' }).waitFor(); await deny.click();
  await page.locator('.change-status.refused', { hasText: 'refused' }).waitFor(); assert.equal(await exists(path.join(root, 'kept/keep.txt')), true);
  await page.getByText('all finished', { exact: true }).first().waitFor();
  const live = await page.locator('#terminal').innerText();
  assert.match(live, /ACTION — delete_file/); assert.match(live, /ACTION — git_commit/); assert.match(live, /ACTION — delete_file \(refused\)/); assert.match(live, /result: ok: committed/);
  await page.reload(); await page.getByText('all finished', { exact: true }).first().waitFor();
  const replayed = await page.locator('#terminal').innerText(); assert.match(replayed, /ACTION — move_file/); assert.match(replayed, /ACTION — delete_file \(refused\)/);
  assert.deepEqual(await page.locator('.plan-item').allInnerTexts(), ['[~] delete old.txt', '[ ] commit']);
  assert.deepEqual(errors, []);
});

test('a plan call that failed shows no checklist', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-plan-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const turns = [call('update_plan', { items: [] }), call('pwd'), { message: { content: 'plan rejected' }, done: true }];
  const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 32768, sessions: new SessionStore(path.join(root, 'sessions')), ollama: { async *streamChat() { yield JSON.stringify(turns.shift()); }, async request() { return {}; } } });
  await harness.initialize(); t.after(() => harness.close());
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await page.locator('#input').fill('plan'); await page.locator('#send').click(); await page.getByText('plan rejected', { exact: true }).first().waitFor();
  assert.equal(await page.locator('.plan').count(), 0); assert.match(await page.locator('#terminal').innerText(), /error: items must be a list/);
});

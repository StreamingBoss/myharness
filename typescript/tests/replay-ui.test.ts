import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { action, collect, fixture } from './browser-fixture.js';
import { closePanels, openSessions } from './ui-panels.js';
import { replayPlan } from '../src/replay.js';

async function staticServer(t: { after(callback: () => unknown): void }) {
  const child = spawn(process.execPath, ['scripts/serve-browser.mjs'], { env: { ...process.env, MYHARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); });
  return new Promise<string>((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Static server did not start: ' + output)), 10000);
    child.stdout.on('data', chunk => { output += String(chunk); const match = output.match(/http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
    child.once('error', reject);
  });
}
const ready = (page: Page) => page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length === 12);
const status = (page: Page) => page.locator('#player-status').innerText();

test('a recorded session is played step by step with no model, or continued, from the session list', async t => {
  // A real recording: two turns, the first with a tool, made by the backend with its scripted model.
  const { backend } = await fixture(t);
  for (const message of ['List files', 'hello']) await collect(backend.submit({ ...action, message, askApproval: false }));
  await backend.patchSession(backend.activeSessionRecord().id, { name: 'Recorded example' });
  // A recording made with a real model; a session saved with the scripted demo model is replaced on startup.
  const recording = { ...backend.activeSessionRecord(), model: 'qwen3:8b' }, steps = replayPlan(recording);
  const turnEnds = steps.map((step, index) => step.memory === undefined ? -1 : index + 1).filter(position => position > 0);
  assert.ok(turnEnds.length === 2 && steps.some(step => step.type === 'tool'));

  const base = await staticServer(t);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(), errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(new URL(request.url()).pathname));
  await page.route('**/recorded/index.json', route => route.fulfill({ json: [{ language: 'fr', file: 'fr/x.json', name: 'Exemple' }, { language: 'en', file: 'en/example.json', name: 'Recorded example' }] }));
  await page.route('**/recorded/en/example.json', route => route.fulfill({ json: recording }));
  await page.goto(base + '/?database=replay-ui&lang=en'); await ready(page);

  // The recorded sessions are a group of the session list, in the interface language.
  await openSessions(page);
  assert.deepEqual(await page.locator('#session-select optgroup').evaluateAll(groups => groups.map(group => (group as HTMLOptGroupElement).label)), ['Recorded sessions', 'Saved in this browser']);
  assert.deepEqual(await page.locator('#session-select optgroup').first().locator('option').allInnerTexts(), ['Recorded example']);
  assert.equal(await page.locator('input[name=load-mode]:checked').inputValue(), 'play');
  await page.locator('#session-select').selectOption('recorded:en/example.json'); await page.locator('#load-session').click();

  // Play step by step: nothing is shown before the first step, the composer gives way to the player.
  await page.locator('#player').waitFor(); assert.equal(await page.locator('#input-row').isVisible(), false);
  assert.equal(await page.locator('#sessions-panel').isHidden(), true);
  assert.match(await status(page), /Before the first step\. This recording has \d+ steps\./);
  assert.equal(await page.locator('#messages .msg').count(), 0); assert.equal(await page.locator('#player-prev').isDisabled(), true);
  assert.equal(await page.locator('#player-continue').isDisabled(), true);
  await page.locator('#player-next').click();
  assert.equal(await status(page), `Step 1 of ${steps.length}: your message`); assert.equal(await page.locator('#messages .msg.user').count(), 1);
  await page.locator('#player-next').click(); assert.match(await status(page), /request sent to the model/);
  assert.match(await page.locator('#terminal').innerText(), /Model: qwen3:8b/);
  // Jump to the end of the first turn: the answer is shown and a model can take over from here.
  await page.locator('#player-slider').fill(String(turnEnds[0]));
  assert.match(await status(page), /the model's response/); assert.equal(await page.locator('#player-continue').isDisabled(), false);
  const firstTurn = await page.locator('#messages').innerText();
  await page.locator('#player-slider').fill(String(turnEnds[1])); assert.notEqual(await page.locator('#messages').innerText(), firstTurn);
  assert.equal(await page.locator('#player-next').isDisabled(), true);
  await page.locator('#player-prev').click(); assert.equal(await page.locator('#player-slider').inputValue(), String(turnEnds[1]! - 1));
  assert.equal(await page.locator('#player-continue').isDisabled(), true);
  await page.locator('#player-slider').fill('0'); assert.equal(await page.locator('#messages .msg').count(), 0);
  assert.equal(await page.locator('#memory').innerText(), '');
  // Playing sent nothing to a model and saved nothing.
  assert.equal(requests.some(url => url.endsWith('/api/chat') || url.includes('/v1/')), false);

  // Continue from the end of the first turn: a new session holding exactly that turn, opened for a model.
  await page.locator('#player-slider').fill(String(turnEnds[0]));
  await Promise.all([page.waitForNavigation(), page.locator('#player-continue').click()]); await ready(page);
  assert.equal(await page.locator('#player').isHidden(), true); assert.equal(await page.locator('#input-row').isVisible(), true);
  assert.match(await page.locator('#session-title').innerText(), /continued from step \d+/);
  assert.equal(await page.locator('#messages .msg.user').count(), 1); assert.equal(await page.locator('#connect-card').isVisible(), true);

  // Closing a replay returns to the current session.
  await openSessions(page); await page.locator('#session-select').selectOption('recorded:en/example.json'); await page.locator('#load-session').click();
  await page.locator('#player').waitFor(); await Promise.all([page.waitForNavigation(), page.locator('#player-exit').click()]); await ready(page);
  assert.equal(await page.locator('#player').isHidden(), true); assert.match(await page.locator('#session-title').innerText(), /continued from step/);

  // The switch decides what Load does, and the choice is kept.
  await openSessions(page); await page.locator('#load-mode label', { hasText: 'Continue' }).click();
  await page.reload(); await ready(page); await openSessions(page);
  assert.equal(await page.locator('input[name=load-mode]:checked').inputValue(), 'continue');
  await page.locator('#session-select').selectOption('recorded:en/example.json');
  await Promise.all([page.waitForNavigation(), page.locator('#load-session').click()]); await ready(page);
  assert.match(await page.locator('#session-title').innerText(), /Recorded example \(continued\)/);
  assert.equal(await page.locator('#messages .msg.user').count(), 2); assert.equal(await page.locator('#player').isHidden(), true);
  // A saved session is continued from its last state, or played, the same way.
  await openSessions(page); await page.locator('#session-select').selectOption({ index: 3 });
  await Promise.all([page.waitForNavigation(), page.locator('#load-session').click()]); await ready(page);
  await closePanels(page);
  assert.deepEqual(errors, []);
});

test('a recorded session that is missing is reported, and without recordings the list has no group', async t => {
  const base = await staticServer(t);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?database=replay-none&lang=en'); await ready(page); await openSessions(page);
  assert.equal(await page.locator('#session-select optgroup').count(), 0);
  await page.route('**/recorded/index.json', route => route.fulfill({ json: [{ language: 'en', file: 'en/missing.json', name: 'Missing' }] }));
  await page.route('**/recorded/en/missing.json', route => route.fulfill({ status: 404, body: '' }));
  await page.reload(); await ready(page); await openSessions(page);
  await page.locator('#session-select').selectOption('recorded:en/missing.json'); await page.locator('#load-session').click();
  await page.locator('#session-status', { hasText: 'Could not load this session.' }).waitFor();
  assert.equal(await page.locator('#player').isHidden(), true);
  assert.deepEqual(errors, []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';

const call = (name: string, args: Record<string, unknown>) => JSON.stringify({ message: { tool_calls: [{ function: { name, arguments: args } }] }, done: true });
const answer = (content: string) => JSON.stringify({ message: { content }, done: true });

test('master chooses parameters; users inspect stable child cards and stop work without settings forms', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'orchestration-ui-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let backend!: NodeHarness;
  backend = new NodeHarness({ workspace: dir, model: 'qwen3:8b', contextLength: 100_000, allowSubagents: true, childTools: ['write_file'], sessions: new SessionStore(path.join(dir, 'sessions')), ollama: {
    async *streamChat(input, signal) {
      const last = input.messages.at(-1)!;
      if (last.role === 'user' && last.content === 'inspect independently') {
        yield JSON.stringify({ message: { content: 'partial inspected result' }, done: false });
        if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
      } else if (last.role === 'user' && last.content === 'write independently') yield call('write_file', { path: 'child.txt', content: 'approved child output' });
      else if (last.role === 'user' && last.content === 'bounded goal') yield call('configure_goal', { objective: 'bounded goal', criteria: 'Inspect child results', max_rounds: 3, max_requests: 15 });
      else if (last.role === 'user' && last.content === 'approval goal') yield call('configure_goal', { objective: 'approval goal' });
      else if (last.role === 'tool' && last.tool_name === 'configure_goal') yield call('spawn_agent', backend.getGoal()!.objective === 'approval goal' ? { task: 'write independently', tools: ['write_file'] } : { task: 'inspect independently' });
      else if (last.role === 'tool' && last.tool_name === 'spawn_agent') yield call('wait_agent', { agent_id: backend.listAgents().at(-1)!.id });
      else if ((last.role === 'tool' && last.tool_name === 'wait_agent') || last.content.startsWith('[harness child settlement]')) yield call('update_goal', { revision: backend.getGoal()!.revision, action: 'complete', evidence: 'Inspected the child settlement' });
      else yield answer('verified result');
    }, async request() { return {}; },
  } }); await backend.initialize(); t.after(() => backend.close());
  const server = createHarnessServer(backend); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  const agentTools = page.locator('.tool-family').filter({ has: page.locator('legend', { hasText: 'Agents' }) });
  assert.equal(await agentTools.locator('.tool-checkbox').count(), 7);
  assert.equal(await agentTools.locator('input[value="spawn_agent"]').count(), 1);
  assert.equal(await page.locator('#orchestration').isVisible(), false);
  assert.equal(await page.locator('#orchestration input, #orchestration select, #orchestration textarea, #orchestration form').count(), 0);
  await page.locator('#input').fill('bounded goal'); await page.locator('#send').click();
  await page.locator('#under-the-hood', { hasText: '1 running' }).waitFor();
  assert.equal(await page.locator('#orchestration').isVisible(), false);
  assert.equal(await page.locator('#stop-orchestration').isVisible(), true);
  await page.locator('#under-the-hood').click(); await page.locator('.child-agent summary').click();
  assert.match(await page.locator('.child-agent pre').innerText(), /partial inspected result/);
  assert.match(await page.locator('#goal-status').innerText(), /bounded goal/);
  await page.locator('.child-agent').evaluate(card => { card.setAttribute('data-preserve', 'yes'); });
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.child-agent').getAttribute('data-preserve'), 'yes');
  assert.equal(await page.locator('.child-agent').evaluate(card => (card as HTMLDetailsElement).open), true);
  await page.locator('.child-agent').getByRole('button', { name: 'Stop child', exact: true }).click();
  await page.locator('.child-agent summary', { hasText: 'cancelled' }).waitFor();
  await page.locator('#goal-status', { hasText: 'complete: bounded goal' }).waitFor();
  await page.locator('#close-orchestration').click();
  assert.equal(await page.locator('#under-the-hood').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#under-the-hood').evaluate(button => button === document.activeElement), true);
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  assert.equal(await page.locator('#orchestration').isVisible(), false);
  await page.locator('#under-the-hood').click(); await page.locator('.child-agent summary').click();
  assert.match(await page.locator('.child-agent pre').innerText(), /partial inspected result/);
  await page.locator('#close-orchestration').click();
  await page.locator('#input').fill('approval goal'); await page.locator('#send').click();
  await page.locator('#orchestration-attention', { hasText: 'Approval needed' }).waitFor();
  assert.equal(await page.locator('#orchestration').isVisible(), false);
  await page.locator('#orchestration-attention').click();
  await page.locator('#run-approvals').getByRole('button', { name: 'Approve', exact: true }).click();
  await page.locator('#goal-status', { hasText: 'complete: approval goal' }).waitFor();
  assert.equal(await readFile(path.join(dir, 'child.txt'), 'utf8'), 'approved child output');
  assert.equal(await page.locator('#orchestration-attention').isVisible(), false);
  await page.route('**/runs', route => route.fulfill({ status: 500, json: { error: 'Inspection unavailable' } }));
  await page.locator('#close-orchestration').click();
  await page.locator('#orchestration-error', { hasText: 'Inspection unavailable' }).waitFor();
  assert.equal(await page.locator('#orchestration-error').isVisible(), true);
  assert.deepEqual(errors, []);
});

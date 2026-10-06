import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeHarness, type HarnessOptions, type ModelPort } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { Execution, positiveLimit, type ExecutionClock } from '../src/execution.js';
import type { CoreEvent, ModelRequest } from '../src/core.js';
import { agentAction, agentQuery, agentRoute } from '../src/transport.js';
import { createHarnessServer } from '../src/node/http.js';

class Clock implements ExecutionClock {
  time = 0; timers = new Map<object, { at: number; call: () => void }>();
  now() { return this.time; }
  set(call: () => void, delay: number) { const id = {}; this.timers.set(id, { at: this.time + delay, call }); return id; }
  clear(id: unknown) { this.timers.delete(id as object); }
  advance(ms: number) { this.time += ms; for (const [id, timer] of this.timers) if (timer.at <= this.time) { this.timers.delete(id); timer.call(); } }
}
const answer = (text = 'done') => JSON.stringify({ message: { content: text }, done: true });
const call = (name: string, args: Record<string, unknown>) => JSON.stringify({ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: true });
class Model implements ModelPort {
  requests: ModelRequest[] = [];
  decide: (input: ModelRequest, signal?: AbortSignal) => AsyncIterable<string> = async function* () { yield answer(); };
  async *streamChat(input: ModelRequest, signal?: AbortSignal) { this.requests.push(structuredClone(input)); yield* this.decide(input, signal); }
  async request() { return { message: { role: 'assistant', content: 'summary' }, done: true }; }
}
async function fixture(t: { after(fn: () => unknown): void }, extra: Partial<HarnessOptions> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'orchestration-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const model = new Model(), clock = new Clock(), sessions = new SessionStore(path.join(dir, 'sessions'));
  const harness = new NodeHarness({ workspace: dir, model: 'qwen3:8b', contextLength: 100_000, ollama: model, clock, sessions, allowSubagents: true, ...extra });
  await harness.initialize(); t.after(() => harness.close()); return { dir, model, clock, harness, sessions };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const items: T[] = []; for await (const item of stream) items.push(item); return items; }
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('state did not arrive'); }
async function* hanging(signal?: AbortSignal) {
  yield JSON.stringify({ message: { content: 'partial evidence' }, done: false });
  if (!signal?.aborted) await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
}

test('Execution owns monotonic deadlines, replays events and drains cancellation before restart', async () => {
  const clock = new Clock(); let abort = 0; const published: CoreEvent[] = [];
  const run = new Execution('child', 10, () => abort++, event => published.push(event), clock);
  let release!: () => void;
  run.start(() => new Promise<void>(resolve => { release = resolve; }), async () => {});
  const listener = run.subscribe(); const next = listener.next();
  clock.advance(10); assert.equal(run.stopped, true); assert.equal(abort, 1); assert.throws(() => run.check(), /stopped/);
  assert.equal((await next).value?.type, 'run_status'); run.stop('cancelled'); assert.equal(abort, 1);
  release(); await run.done; assert.equal(run.inspect().status, 'timed-out'); assert.equal(run.isSettled, true); assert.equal(run.remainingMs, 0);
  run.stop('cancelled'); assert.equal(abort, 1);
  assert.deepEqual(await collect(run.subscribe()), published);
  await listener.return(undefined);
  await assert.rejects(run.subscribe(-2).next(), /after/);
  const controller = new AbortController(); const live = new Execution('x', 100, () => {}, () => {}, clock);
  const observed = live.subscribe(-1, controller.signal); const waiting = observed.next(); controller.abort(); assert.equal((await waiting).done, true);
  const error = new Execution('x', 20, () => {}, () => {}, clock); error.start(async () => { throw 'model broke'; }, async () => {}); await error.done; assert.equal(error.inspect().reason, 'model broke');
  const checkpoint = new Execution('x', 20, () => {}, () => {}, clock); checkpoint.start(async () => {}, async () => { throw new Error('disk'); }); await checkpoint.done; assert.match(checkpoint.inspect().reason!, /Checkpoint failed: disk/);
  const expired = new Execution('x', 1, () => {}, () => {}, clock); clock.advance(1); assert.throws(() => expired.check(), /stopped/);
  for (const bad of [0, -1, 1.5, NaN, Infinity, '1', 2_147_483_648]) assert.throws(() => positiveLimit(bad, 'limit'), /positive integer/);
  assert.equal(positiveLimit(1, 'limit'), 1);
});

test('children run headlessly, retain partial output and history, queue followups and restore through their master', async t => {
  const { harness, model, clock, sessions, dir } = await fixture(t);
  model.decide = (_input, signal) => hanging(signal);
  const child = await harness.spawnAgent({ task: 'inspect files', timeoutMs: 100 });
  await until(() => model.requests.length === 1);
  await until(() => harness.getAgentResult(child.id).result === 'partial evidence');
  await assert.rejects(harness.restartAgent(child.id), /settle/);
  clock.advance(100);
  const timed = await harness.waitAgent(child.id); assert.equal(timed.status, 'timed-out'); assert.equal(timed.result, 'partial evidence'); assert.equal(timed.attempts!.length, 1);
  await assert.rejects(harness.sendMessage(child.id, 'continue'), /Restart/);
  model.decide = async function* () { yield answer('checked'); };
  const restarted = await harness.restartAgent(child.id, 'verify again', 200); assert.equal(restarted.attempt, 2);
  const complete = await harness.waitAgent(child.id); assert.equal(complete.status, 'completed'); assert.equal(complete.result, 'checked');
  assert.equal(harness.getAgentResult(child.id, 1).status, 'timed-out'); assert.throws(() => harness.getAgentResult(child.id, 20), /attempt/);
  const childRecord = await sessions.load(child.id); assert.equal(childRecord.parent_session_id, harness.activeSessionRecord().id); assert.equal(childRecord.memory.filter(item => item.role === 'user').length, 2);
  await assert.rejects(harness.activateSession(child.id), /master session/); assert.notEqual(harness.activeSessionRecord().id, child.id);
  const restored = new NodeHarness({ workspace: dir, model: 'qwen3:8b', contextLength: 100_000, ollama: model, sessions, allowSubagents: true, clock }); t.after(() => restored.close()); await restored.initialize();
  assert.equal(restored.getAgentResult(child.id).status, 'completed');
  await restored.sendMessage(child.id, 'one more check'); assert.equal((await restored.waitAgent(child.id)).attempt, 3);
  assert.equal(model.requests.at(-1)!.messages.some(item => item.content === 'verify again'), true);
  assert.throws(() => harness.getAgentResult('missing'), /not found/);
  const imported = await sessions.import(harness.activeSessionRecord()); assert.equal(imported.orchestration?.children, undefined);
});

test('global disabling drains children and never lets sessions grant tools or credentials', async t => {
  const { harness, model, clock } = await fixture(t, { maxConcurrentChildren: 1 });
  model.decide = (_input, signal) => hanging(signal);
  const child = await harness.spawnAgent({ task: 'first' }); await until(() => model.requests.length > 0);
  await assert.rejects(harness.spawnAgent({ task: 'second' }), /concurrent/);
  await harness.sendMessage(child.id, 'followup');
  const settings = await harness.updateHarnessSettings({ allowSubagents: false }); assert.equal(settings.allowSubagents, false);
  assert.equal(harness.getAgentResult(child.id).status, 'policy-disabled'); assert.equal(clock.timers.size, 0);
  await assert.rejects(harness.restartAgent(child.id), /disabled/);
  assert.equal((await harness.interruptAgent(child.id)).status, 'policy-disabled');
  await assert.rejects(harness.updateHarnessSettings({ allowSubagents: 'true' }), /boolean/);
  await assert.rejects(harness.updateHarnessSettings({ allowSubagents: true, childTools: 1 }), /list/);
  await assert.rejects(harness.updateHarnessSettings({ allowSubagents: true, childRoutes: [null] }), /pairs/);
  await harness.updateHarnessSettings({ allowSubagents: true });
  await assert.rejects(harness.spawnAgent({ task: '' }), /required/);
  await assert.rejects(harness.spawnAgent({ task: 'write', tools: ['write_file'] }), /read-only/);
  await assert.rejects(harness.spawnAgent({ task: 'cloud', provider: 'openai', model: 'remote' }), /not authorized/);
  model.decide = async function* () { yield answer(); };
  const read = await harness.spawnAgent({ task: 'read' }); await harness.waitAgent(read.id);
  assert.equal(model.requests.at(-1)!.tools!.some(tool => tool.function.name === 'spawn_agent' || tool.function.name === 'write_file'), false);
});

test('goal continuations are backend driven, distinct from users, require evidence and share request limits', async t => {
  const { harness, model } = await fixture(t);
  let requests = 0;
  model.decide = async function* (input) {
    requests++;
    if (requests === 2) yield call('get_goal', {});
    else if (requests === 3) { const goal = JSON.parse(input.messages.at(-1)!.content).goal; yield call('update_goal', { revision: goal.revision, action: 'complete', evidence: 'Verified scratch file contents.' }); }
    else yield answer(requests === 1 ? 'progress made' : 'verified outcome');
  };
  await harness.startGoal({ objective: 'verify something', maxRounds: 2 });
  const run = harness.inspectRun()!; const events = await collect(harness.subscribeRun(run.id));
  assert.equal(harness.getGoal()!.phase, 'complete'); assert.equal(harness.getGoal()!.evidence, 'Verified scratch file contents.'); assert.equal(harness.inspectRun()!.status, 'completed');
  assert.equal(events.some(event => event.type === 'goal_round' && event.source === 'harness'), true);
  assert.equal(harness.activeSessionRecord().events.some(event => event.type === 'chat_user' && event.source === 'harness'), true);
  assert.equal(model.requests.at(-1)!.tools, undefined);
  assert.deepEqual(harness.runEvents(run.id, events.length - 2), events.slice(-1));
  assert.throws(() => harness.runEvents(run.id, -2), /after/); assert.throws(() => harness.inspectRun('missing'), /not found/);
  await assert.rejects(harness.updateGoal(0, 'complete', 'x'), /changed/);
  await assert.rejects(harness.updateGoal(harness.getGoal()!.revision, 'complete', 'x'), /already complete/);
  model.decide = async function* () { yield answer('keep working'); };
  await harness.startGoal({ objective: 'bounded', maxRounds: 2, maxRequests: 1 });
  await collect(harness.subscribeRun(harness.inspectRun()!.id)); assert.equal(harness.inspectRun()!.status, 'limit'); assert.equal(harness.getGoal()!.phase, 'blocked');
  await assert.rejects(harness.resumeGoal(harness.getGoal()!.revision), /exhausted/);
});

test('master timeout cancels descendants; pause/resume preserves state and resets the master deadline', async t => {
  const { harness, model, clock } = await fixture(t);
  model.decide = (_input, signal) => hanging(signal);
  await harness.startGoal({ objective: 'long task', timeoutMs: 50 }); await until(() => model.requests.length > 0);
  const child = await harness.spawnAgent({ task: 'long child', timeoutMs: 200 }); await until(() => model.requests.length === 2);
  await harness.sendMessage(harness.activeSessionRecord().id, 'extra context');
  clock.advance(50); await collect(harness.subscribeRun(harness.inspectRun()!.id));
  assert.equal(harness.inspectRun()!.status, 'timed-out'); assert.equal(harness.getGoal()!.phase, 'blocked'); assert.equal(harness.getAgentResult(child.id).status, 'cancelled');
  await assert.rejects(harness.restartAgent(child.id), /Resume/);
  await harness.resumeGoal(harness.getGoal()!.revision, 100); await until(() => model.requests.length === 3);
  await harness.pauseGoal(harness.getGoal()!.revision); assert.equal(harness.getGoal()!.phase, 'paused'); assert.equal(harness.inspectRun()!.status, 'cancelled');
  await assert.rejects(harness.sendMessage(harness.activeSessionRecord().id, 'x'), /not running/);
  await harness.resumeGoal(harness.getGoal()!.revision); await harness.cancelRun(); assert.equal(harness.getGoal()!.phase, 'paused');
  await assert.rejects(harness.startGoal({ objective: 'another' }), /current goal/);
});

test('effectful children inherit approvals, route answers to the correct child and time out while waiting', async t => {
  const { harness, model, clock, dir } = await fixture(t, { childTools: ['write_file'] });
  model.decide = async function* (input) {
    if (input.messages.at(-1)!.role === 'tool') yield answer('saved'); else yield call('write_file', { path: 'child.txt', content: 'value' });
  };
  const first = await harness.spawnAgent({ task: 'write', tools: ['write_file'], timeoutMs: 30 });
  await until(() => harness.activeSessionRecord().events.some(event => event.type === 'agent_event' && (event.event as CoreEvent).type === 'approval'));
  const approvals = () => harness.activeSessionRecord().events.filter(event => event.type === 'agent_event' && (event.event as CoreEvent).type === 'approval').map(event => event.event as CoreEvent);
  clock.advance(30); assert.equal((await harness.waitAgent(first.id)).status, 'timed-out'); assert.equal(harness.approve(String(approvals()[0]!.id), true), false);
  await assert.rejects(readFile(path.join(dir, 'child.txt')), /ENOENT/);
  await harness.restartAgent(first.id, 'write again', 50); await until(() => approvals().length === 2);
  assert.equal(harness.approve(String(approvals()[1]!.id), true), true);
  assert.equal((await harness.waitAgent(first.id)).status, 'completed'); assert.equal(await readFile(path.join(dir, 'child.txt'), 'utf8'), 'value');
});

test('HTTP and shared dispatch expose goals, settings, children, historical results and run events', async t => {
  const { harness } = await fixture(t); const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (route: string, method = 'GET', value?: unknown) => { const response = await fetch(url + route, { method, ...(value === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }) }); return { status: response.status, value: await response.json() }; };
  const child = (await request('/agents', 'POST', { task: 'check' })).value;
  assert.equal((await request(`/agents/${child.id}/wait`, 'POST', {})).value.status, 'completed');
  assert.equal((await request(`/agents/${child.id}/result?attempt=1`)).value.attempt, 1);
  assert.equal((await request('/agents', 'POST', { task: 3 })).status, 400);
  assert.equal((await request('/settings', 'PATCH', { allowSubagents: false })).value.allowSubagents, false);
  assert.equal((await request(`/agents/${child.id}/restart`, 'POST', {})).status, 403);
  await request('/goal', 'POST', { objective: 'limited', maxRounds: 1 }); await collect(harness.subscribeRun(harness.inspectRun()!.id));
  assert.ok((await request(`/runs/${harness.inspectRun()!.id}/events?after=-1`)).value.events.length > 0);
  assert.equal((await request('/runs')).value.goal.phase, 'blocked');
  assert.equal((await request('/runs/cancel', 'POST', {})).value.ok, true);
  await assert.rejects(agentAction(harness, 'missing', {}), /Unknown/);
  await assert.rejects(agentAction(harness, 'getGoal', { timeoutMs: '1' }), /integer/);
  assert.deepEqual(agentQuery(new URLSearchParams('after=2&attempt=1')), { after: 2, attempt: 1 });
  assert.equal(agentRoute('DELETE', '/agents/x/result'), undefined); assert.equal(agentRoute('GET', '/nope'), undefined);
});

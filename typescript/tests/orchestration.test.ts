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
import { Harness } from '../src/harness.js';
import { ProviderRouter } from '../src/providers.js';
import { LegacyModelAdapter } from '../src/model.js';
import { headless } from '../src/node/headless.js';
import { loadHarness } from '../src/node/startup.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { BrowserStorage } from '../src/browser/storage.js';
import { WorkerHost, type RpcMessage } from '../src/browser/worker-host.js';
import { WorkerClient, type WorkerPort } from '../src/browser/client.js';
import { browserFetch } from '../src/browser/fetch.js';
import { IDBFactory } from 'fake-indexeddb';

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
  const harness = new NodeHarness({ workspace: dir, model: 'qwen3:8b', contextLength: 100_000, ...(extra.modelAdapter ? {} : { ollama: model }), clock, sessions, allowSubagents: true, ...extra });
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
  await harness.patchSession(harness.activeSessionRecord().id, { settings: { ask_approval: false } });
  await rm(path.join(dir, 'child.txt')); await harness.restartAgent(first.id); await harness.waitAgent(first.id);
  assert.equal(await readFile(path.join(dir, 'child.txt'), 'utf8'), 'value'); assert.equal(approvals().length, 2);
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

test('cloud child uses its own native route and reconnects credentials when restarted', async t => {
  const requests: { key: string; model: string }[] = [];
  const router = new ProviderRouter(async (_url, init) => {
    const body = JSON.parse(String(init!.body)); requests.push({ key: new Headers(init!.headers).get('authorization')!, model: body.model });
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'cloud evidence' }] }] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  }, {}, 'openai', { openai: 'ephemeral-first' });
  const { harness } = await fixture(t, { modelAdapter: router, provider: 'openai', model: 'master-model', childRoutes: [{ provider: 'openai', model: 'child-model' }] });
  const child = await harness.spawnAgent({ task: 'remote work', provider: 'openai', model: 'child-model' }); assert.equal((await harness.waitAgent(child.id)).result, 'cloud evidence');
  assert.equal(router.selected, 'openai'); assert.equal(harness.model(), 'master-model');
  router.forget('openai'); await assert.rejects(harness.restartAgent(child.id), /credentials/);
  router.setKey('openai', 'ephemeral-next'); await harness.restartAgent(child.id); await harness.waitAgent(child.id);
  assert.deepEqual(requests, [{ key: 'Bearer ephemeral-first', model: 'child-model' }, { key: 'Bearer ephemeral-next', model: 'child-model' }]);
  assert.equal(JSON.stringify(harness.activeSessionRecord()).includes('ephemeral-'), false);
});

test('Worker and browser transports persist global grants and execute children without a UI', async t => {
  const storage = await BrowserStorage.open('orchestration', new IDBFactory()); t.after(() => storage.close());
  const options = { storage, library: { agents: {}, prompts: {}, skills: {} }, seed: { 'file.txt': 'evidence' }, model: 'scripted-demo', allowSubagents: true, childTools: ['write_file'], childRoutes: [{ provider: 'openai' as const, model: 'model' }] };
  const backend = await BrowserHarness.open(options); t.after(() => backend.close());
  const messages: RpcMessage[] = []; const host = new WorkerHost(async () => backend, message => messages.push(message));
  const invoke = async (action: string, payload: Record<string, unknown> = {}) => { await host.handle({ id: action, action, payload }); const message = messages.pop()!; assert.equal(message.type, 'result', JSON.stringify(message)); return (message as { value: any }).value; };
  const child = await invoke('spawnAgent', { task: 'Read file.txt' }); assert.equal((await invoke('waitAgent', { id: child.id })).status, 'completed');
  assert.match((await invoke('getAgentResult', { id: child.id })).result, /evidence/);
  const port: WorkerPort = { postMessage() {}, addEventListener() {}, removeEventListener() {}, terminate() {} };
  const client = new WorkerClient(port); client.call = async (action, payload = {}) => invoke(action, payload);
  const request = browserFetch(client);
  assert.equal((await (await request(`/agents/${child.id}/result?attempt=1`)).json()).attempt, 1);
  assert.ok((await (await request('/agents')).json()).length);
  await request('/settings', { method: 'PATCH', body: JSON.stringify({ allowSubagents: false, childTools: [], childRoutes: [] }) });
  assert.equal((await invoke('getHarnessSettings')).allowSubagents, false);
  const reopened = await BrowserHarness.open(options); t.after(() => reopened.close()); assert.equal(reopened.getHarnessSettings().allowSubagents, false);
  assert.equal(reopened.inspectRun(child.run.id)!.status, 'completed'); assert.ok(reopened.runEvents(child.run.id).length); assert.ok((await collect(reopened.subscribeRun(child.run.id))).length);
});

test('invalid goals, child capabilities, revisions and tool policy fail explicitly', async t => {
  const { harness, model } = await fixture(t);
  const internal = harness as any;
  const childBackend = new Harness(internal.options, 'parent'); t.after(() => childBackend.close());
  await assert.rejects(childBackend.startGoal({ objective: 'x' }), /Only the user/);
  await assert.rejects(childBackend.spawnAgent({ task: 'x' }), /cannot delegate/);
  await assert.rejects(childBackend.updateHarnessSettings({ allowSubagents: true }), /locked/);
  await assert.rejects(harness.updateGoal(1, 'pause'), /no current goal/i);
  await assert.rejects(harness.startGoal({ objective: ' ' }), /objective/);
  await assert.rejects(harness.startGoal({ objective: 'x', turn: { message: 'x', useMemory: false, askApproval: true, tools: [], agent: '', prompt: '' } }), /memory/);
  assert.match((await harness.runTool('update_goal', {}, []) as { text: string }).text, /unavailable/);
  assert.match((await harness.runTool('spawn_agent', { task: 'x' }, []) as { text: string }).text, /disabled/);
  assert.match((await childBackend.runTool('spawn_agent', { task: 'x' }, ['spawn_agent']) as { text: string }).text, /disabled/);
  assert.match((await harness.runTool('get_goal', {}, ['get_goal']) as { text: string }).text, /null/);
  assert.match((await harness.runTool('update_goal', { revision: 1, action: 'complete' }, ['update_goal']) as { text: string }).text, /error/);
  await assert.rejects(harness.sendMessage('x', ''), /follow-up/);
  model.decide = (_input, signal) => hanging(signal);
  await harness.startGoal({ objective: 'pause test', criteria: 'check', maxRounds: 3 });
  await assert.rejects(collect(harness.submit({ message: 'x', useMemory: true, tools: [], askApproval: true, agent: '', prompt: '' })), /already running/);
  await assert.rejects(harness.updateGoal(1, 'bad'), /Goal action/);
  await assert.rejects(harness.updateGoal(1, 'complete'), /evidence/);
  await assert.rejects(harness.updateGoal(1, 'blocked', ' '), /blocker/);
  await assert.rejects(harness.updateGoal(1, 'pause', undefined, true), /Only a user/);
  await assert.rejects(harness.resumeGoal(0, 30), /running turn/);
  await harness.updateGoal(1, 'blocked', 'missing data'); assert.equal(harness.getGoal()!.blocker, 'missing data');
  await assert.rejects(harness.resumeGoal(0, 30), /changed/);
  assert.match((await harness.runTool('get_goal', {}, ['get_goal']) as { text: string }).text, /blocked/);
  const demo = new NodeHarness({ workspace: harness.state.workspace, model: 'scripted-demo', contextLength: 100_000, ollama: model, allowSubagents: true }); t.after(() => demo.close());
  const spawned = JSON.parse((await demo.runTool('spawn_agent', { task: 'demo', timeout_ms: 30 }, ['spawn_agent']) as { text: string }).text);
  assert.equal(JSON.parse((await demo.runTool('list_agents', {}, ['list_agents']) as { text: string }).text).length, 1);
  assert.equal(JSON.parse((await demo.runTool('get_agent_result', { agent_id: spawned.id }, ['get_agent_result']) as { text: string }).text).id, spawned.id);
  await demo.runTool('send_message', { agent_id: spawned.id, message: 'followup' }, ['send_message']);
  await demo.runTool('interrupt_agent', { agent_id: spawned.id }, ['interrupt_agent']);
  await demo.runTool('wait_agent', { agent_id: spawned.id }, ['wait_agent']);
  model.decide = async function* () { yield answer(); };
  await demo.runTool('restart_agent', { agent_id: spawned.id, message: 'fresh', timeout_ms: 50 }, ['restart_agent']); await demo.waitAgent(spawned.id);
  assert.match((await demo.runTool('get_agent_result', { agent_id: 'missing' }, ['get_agent_result']) as { text: string }).text, /error/);
  const request = demo.inspectRun(spawned.run.id)!; assert.ok(request);
  await demo.explore({ useMemory: true, tools: ['get_goal'], agent: '', prompt: '' });
});

test('settings writes serialize, preserve workspace preferences and keep admission closed after failures', async t => {
  const { dir, model, clock } = await fixture(t);
  const file = path.join(dir, 'settings.json'); await writeFile(file, JSON.stringify({ project: dir, extra: 'keep' }));
  const backend = new NodeHarness({ workspace: dir, model: 'qwen3:8b', contextLength: 100_000, ollama: model, settingsFile: file, clock }); t.after(() => backend.close());
  await backend.updateHarnessSettings({ allowSubagents: true, childTools: ['edit_file'], childRoutes: [{ provider: 'openai', model: 'child' }] });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).extra, 'keep');
  await Promise.all([backend.updateHarnessSettings({ allowSubagents: true }), backend.updateHarnessSettings({ allowSubagents: false })]); assert.equal(backend.getHarnessSettings().allowSubagents, false);
  const locked = new NodeHarness({ workspace: dir, model: 'm', contextLength: 100_000, ollama: model, settingsLocked: true }); t.after(() => locked.close()); await assert.rejects(locked.updateHarnessSettings({ allowSubagents: true }), /locked/);
  await writeFile(file, '{bad'); await assert.rejects(backend.updateHarnessSettings({ allowSubagents: true }), /Could not save/); assert.equal(backend.getHarnessSettings().allowSubagents, false);
  await writeFile(file, JSON.stringify({ project: dir, allowSubagents: true, childTools: [], childRoutes: [] }));
  const env = { MYHARNESS_ROOT: dir, MYHARNESS_WORKSPACE: dir, MYHARNESS_CONTEXT_LENGTH: '100000' };
  const loaded = await loadHarness({ ...env, MYHARNESS_ALLOW_SUBAGENTS: 'false' }); t.after(() => loaded.close()); assert.equal(loaded.getHarnessSettings().locked, true); assert.equal(loaded.getHarnessSettings().allowSubagents, false);
  const enabled = await loadHarness({ ...env, MYHARNESS_ALLOW_SUBAGENTS: 'true' }); t.after(() => enabled.close()); assert.equal(enabled.getHarnessSettings().allowSubagents, true);
  await assert.rejects(loadHarness({ ...env, MYHARNESS_ALLOW_SUBAGENTS: 'yes' }), /true or false/);
});

test('headless goals consume structured events and return an unsuccessful status at limits', async t => {
  const { harness } = await fixture(t); const output: string[] = [];
  assert.equal(await headless(['bounded', '--goal', '--timeout-ms', '1000', '--max-rounds', '1', '--max-requests', '10'], async () => harness, line => output.push(line)), 1);
  assert.ok(output.some(line => line.includes('run_ended')));
  const { harness: other } = await fixture(t);
  assert.equal(await headless(['x', '--goal', '--compact'], async () => other, () => {}), 1);
});

test('legacy goal state, durable event replay, import and session validation', async t => {
  const { harness, sessions, model, dir, clock } = await fixture(t);
  const base = harness.activeSessionRecord();
  const goal = { id: 'goal', revision: 1, objective: 'old goal', criteria: 'inspect', phase: 'active', rounds: 0, max_rounds: 2 };
  for (const change of [{ parent_session_id: 1 }, { orchestration: null }, { orchestration: { goal: { ...goal, id: 1 } } }, { orchestration: { children: [null] } }, { child_task: { task: 1 } }]) assert.throws(() => sessions.validate({ ...base, ...change }), /Invalid/);
  const imported = await sessions.import({ ...base, orchestration: { goal } }); assert.equal(imported.orchestration!.goal!.phase, 'paused');
  await sessions.import({ ...base, orchestration: {} });
  await harness.activateSession(imported.id);
  await harness.resumeGoal(1); await collect(harness.subscribeRun(harness.inspectRun()!.id)); assert.equal(harness.getGoal()!.phase, 'blocked');
  const runId = harness.inspectRun()!.id;
  const restored = new NodeHarness({ workspace: dir, model: 'm', contextLength: 100_000, ollama: model, sessions, clock }); t.after(() => restored.close()); await restored.activateSession(imported.id);
  assert.equal(restored.inspectRun(runId)!.status, 'limit'); assert.ok(restored.runEvents(runId).length);
  const controller = new AbortController(); controller.abort(); assert.deepEqual(await collect(restored.subscribeRun(runId, -1, controller.signal)), []);
  assert.deepEqual(await collect(restored.subscribeRun(runId, 10_000)), []);
  await harness.newSession(); model.decide = async function* () { throw new Error('adapter failure'); };
  await harness.startGoal({ objective: 'failure' }); await collect(harness.subscribeRun(harness.inspectRun()!.id)); assert.equal(harness.inspectRun()!.status, 'error');
  const normalError = new Execution('x', 10, () => {}, () => {}, clock); normalError.start(async () => { throw new Error('error'); }, async () => {}); await normalError.done;
  const failedSave = new Execution('x', 10, () => {}, () => {}, clock); failedSave.start(async () => {}, async () => { throw 'string failure'; }); await failedSave.done;
});

test('cold child recovery, concurrent restart reservation and failed admission are safe', async t => {
  const { harness, sessions, model, clock, dir } = await fixture(t);
  const child = await harness.spawnAgent({ task: 'read' }); await harness.waitAgent(child.id);
  assert.ok(((await harness.bootstrap()).tools as { name: string }[]).some(tool => tool.name === 'spawn_agent'));
  const record = harness.activeSessionRecord(); const saved = record.orchestration!.children![0]!; saved.status = 'running'; saved.run!.status = 'stopping'; delete saved.result; delete saved.attempts;
  await sessions.save(record); await harness.activateSession(record.id); assert.equal(harness.getAgentResult(child.id).status, 'cancelled');
  const pending = harness.restartAgent(child.id); await assert.rejects(harness.restartAgent(child.id), /already restarting/); await pending; await harness.waitAgent(child.id);
  await harness.activateSession(record.id);
  const childRecord = await sessions.load(child.id); childRecord.parent_session_id = 'other'; await sessions.save(childRecord);
  await assert.rejects(harness.restartAgent(child.id), /does not belong/);
  childRecord.parent_session_id = harness.activeSessionRecord().id; delete childRecord.provider; await sessions.save(childRecord);
  await harness.restartAgent(child.id); await harness.waitAgent(child.id);
  const alternate = new NodeHarness({ workspace: dir, model: 'scripted-demo', contextLength: 100_000, ollama: model, sessions, allowSubagents: true, clock }); t.after(() => alternate.close());
  const demo = await alternate.spawnAgent({ task: 'read' }); await alternate.waitAgent(demo.id); const demoRecord = await sessions.load(demo.id); delete demoRecord.provider; await sessions.save(demoRecord);
  await alternate.activateSession(alternate.activeSessionRecord().id); await alternate.restartAgent(demo.id); await alternate.waitAgent(demo.id);
  const internal = harness as any, save = internal.options.sessions.save.bind(sessions);
  internal.options.sessions.save = async () => { throw new Error('disk failed'); }; await assert.rejects(harness.spawnAgent({ task: 'save failure' }), /disk failed/); internal.options.sessions.save = save;
  let count = 0;
  internal.options.sessions.save = async (value: any) => { await save(value); if (++count === 2) internal.family.allowed = false; };
  await assert.rejects(harness.spawnAgent({ task: 'policy race' }), /disabled/); internal.options.sessions.save = save;
  const nested = new Harness({ ...internal.options, allowSubagents: true }, 'parent'); t.after(() => nested.close()); assert.equal(((await nested.bootstrap()).tools as { name: string }[]).some(tool => tool.name === 'spawn_agent'), false);
});

test('queued effects cancel promptly and stale write/edit proposals fail without changing files', async t => {
  const { harness, model, clock, dir } = await fixture(t, { childTools: ['write_file', 'edit_file', 'mcp__none__tool'] });
  await writeFile(path.join(dir, 'file'), 'original');
  model.decide = async function* (input) { if (input.messages.at(-1)!.role === 'tool') yield answer(); else yield call('edit_file', { path: 'file', old_text: 'original', new_text: 'new' }); };
  const a = await harness.spawnAgent({ task: 'edit first', tools: ['edit_file'], timeoutMs: 100 });
  await until(() => harness.activeSessionRecord().events.some(event => event.type === 'agent_event' && (event.event as CoreEvent).type === 'approval'));
  const b = await harness.spawnAgent({ task: 'edit second', tools: ['edit_file'], timeoutMs: 10 }); await until(() => model.requests.length === 2);
  clock.advance(10); assert.equal((await harness.waitAgent(b.id)).status, 'timed-out'); assert.equal(harness.getAgentResult(a.id).status, 'running');
  await writeFile(path.join(dir, 'file'), 'external change');
  const approval = (harness.activeSessionRecord().events.find(event => event.type === 'agent_event' && (event.event as CoreEvent).type === 'approval')!.event as CoreEvent).id;
  harness.approve(String(approval), true); await harness.waitAgent(a.id); assert.equal(await readFile(path.join(dir, 'file'), 'utf8'), 'external change');
  assert.match((await harness.getSession(a.id)).memory.find(item => item.role === 'tool')!.content, /approved file changed/);
  const privateChild = (harness as any).children.get(a.id).harness as Harness;
  const prepared = await privateChild.runTool('write_file', { path: 'file', content: 'proposal' }, ['write_file']); await writeFile(path.join(dir, 'file'), 'changed again');
  const effects = privateChild.applyChange('write_file', (prepared as { change: unknown }).change); const rejected = await effects.next(); assert.equal(rejected.done, true); assert.match(String(rejected.value), /changed since/);
  privateChild.stop(); assert.match(String((await privateChild.applyChange('write_file', { path: 'new', content: 'x' }).next()).value), /^stopped:/);
  model.decide = async function* () { yield answer(); };
  const mcp = await harness.spawnAgent({ task: 'mcp task', tools: ['mcp__none__tool'] }); assert.equal((await harness.waitAgent(mcp.id)).status, 'completed');
});

test('model-facing cloud selection, terminal batches and master followups remain bounded', async t => {
  const { harness, model } = await fixture(t, { childRoutes: [{ provider: 'ollama', model: 'other' }] });
  const result = await harness.runTool('spawn_agent', { task: 'route', provider: 'ollama', model: 'other', tools: ['pwd'] }, ['spawn_agent']); const child = JSON.parse((result as { text: string }).text); await harness.waitAgent(child.id);
  await harness.runTool('restart_agent', { agent_id: child.id }, ['restart_agent']); await harness.waitAgent(child.id);
  await harness.updateHarnessSettings({ allowSubagents: true, childRoutes: [] });
  await assert.rejects(harness.restartAgent(child.id), /no longer authorized/);
  let calls = 0;
  model.decide = async function* (input) {
    calls++;
    if (calls === 1) { await harness.sendMessage(harness.activeSessionRecord().id, 'human followup'); yield answer('progress'); }
    else if (calls === 2) {
      const goal = harness.getGoal()!;
      yield JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 'update_goal', arguments: { revision: goal.revision, action: 'complete', evidence: 'checked' } } }, { function: { name: 'pwd', arguments: {} } }] }, done: true });
    } else yield answer('final');
  };
  await harness.startGoal({ objective: 'complete task', turn: { message: 'first', useMemory: true, askApproval: true, tools: ['pwd'], agent: '', prompt: '' } });
  await collect(harness.subscribeRun(harness.inspectRun()!.id)); assert.equal(model.requests.some(request => request.messages.some(item => item.content === 'human followup')), true);
  assert.match(harness.inspect().memory.find(item => item.role === 'tool' && item.tool_name === 'pwd')!.content, /goal ended/);
});

test('shared dispatcher covers goal controls, interruption and user inbox routing', async t => {
  const { harness, model } = await fixture(t);
  assert.equal((await agentAction(harness, 'getGoal', {}) as { goal: unknown }).goal, null);
  model.decide = (_input, signal) => hanging(signal);
  const started = await agentAction(harness, 'startGoal', { objective: 'dispatch' }) as { goal: { revision: number } };
  await agentAction(harness, 'sendMessage', { id: harness.activeSessionRecord().id, message: 'later' });
  await agentAction(harness, 'pauseGoal', { revision: started.goal.revision });
  await agentAction(harness, 'resumeGoal', { revision: harness.getGoal()!.revision, timeoutMs: 1000 });
  const child = await harness.spawnAgent({ task: 'cancel me' }); await agentAction(harness, 'interruptAgent', { id: child.id });
  await agentAction(harness, 'updateGoal', { revision: harness.getGoal()!.revision, action: 'complete', evidence: 'human verified' });
  assert.equal((await agentAction(harness, 'getGoal', {}) as { goal: { phase: string } }).goal.phase, 'complete');
  const nested = new Harness((harness as any).options, 'parent'); t.after(() => nested.close()); (nested as any).session.orchestration = { goal: { ...harness.getGoal(), phase: 'active' } };
  await assert.rejects(nested.updateGoal(harness.getGoal()!.revision, 'complete', 'evidence', true), /Only a user/);
  await harness.newSession(); (harness as any).session.orchestration = { goal: { id: 'g', revision: 1, phase: 'paused', objective: 'legacy', criteria: 'x', rounds: 0, max_rounds: 3 } };
  await harness.resumeGoal(1, 100); await assert.rejects(harness.updateGoal(2, 'resume', undefined, true), /Only a user/); await harness.cancelRun();
});

test('headless goal completion handles child approval events and cancellation with default limits', async t => {
  const { harness, model, dir } = await fixture(t, { childTools: ['write_file'] });
  model.decide = async function* (input) {
    const last = input.messages.at(-1)!;
    if (last.content.startsWith('[harness child settlement]')) yield call('update_goal', { revision: harness.getGoal()!.revision, action: 'complete', evidence: 'child answered' });
    else if (last.role === 'tool' && last.tool_name === 'spawn_agent') yield call('wait_agent', { agent_id: JSON.parse(last.content).id });
    else if (last.role === 'tool' && last.tool_name === 'wait_agent') yield call('update_goal', { revision: harness.getGoal()!.revision, action: 'complete', evidence: 'child answered' });
    else if (last.role === 'tool') yield answer('child result');
    else if (last.content === 'child writes') yield call('write_file', { path: 'denied.txt', content: 'x' });
    else if (last.content === 'headless task') yield call('spawn_agent', { task: 'child writes', tools: ['write_file'] });
    else yield answer('final');
  };
  const output: string[] = [];
  assert.equal(await headless(['headless task', '--goal'], async () => harness, line => output.push(line)), 0);
  assert.ok(output.some(line => line.includes('approval'))); await assert.rejects(readFile(path.join(dir, 'denied.txt')), /ENOENT/);
  const { harness: stopped, model: slow } = await fixture(t); slow.decide = (_input, signal) => hanging(signal);
  assert.equal(await headless(['stop task', '--goal'], async () => stopped, line => { if (line.includes('"type":"request"')) process.emit('SIGINT'); }), 130);
});

test('final checkpoint failures settle observers and cannot authorize restarts early', async () => {
  const clock = new Clock(); let release!: () => void;
  const run = new Execution('x', 10, () => {}, () => {}, clock);
  run.start(async () => {}, async () => {}, () => new Promise<void>(resolve => { release = resolve; }));
  await flush(); assert.equal(run.inspect().status, 'stopping'); assert.equal(run.isSettled, false); run.stop('cancelled'); assert.equal(run.stopped, false);
  release(); await run.done; assert.equal(run.inspect().status, 'completed');
  for (const failure of [new Error('disk'), 'string disk']) {
    const broken = new Execution('x', 10, () => {}, () => {}, clock); broken.start(async () => {}, async () => {}, async () => { throw failure; });
    await collect(broken.subscribe()); assert.equal(broken.inspect().status, 'error'); assert.match(broken.inspect().reason!, /Final checkpoint failed/);
  }
});

test('ordinary stream abandonment drains the core and repairs incomplete tool batches', async t => {
  const { harness } = await fixture(t);
  const stream = harness.submit({ message: 'inspect', useMemory: true, askApproval: true, tools: ['pwd'], agent: '', prompt: '' });
  assert.equal((await stream.next()).done, false); await stream.return(undefined);
  assert.ok((await collect(harness.submit({ message: 'again', useMemory: true, askApproval: true, tools: [], agent: '', prompt: '' }))).some(event => event.type === 'response'));
  const workspace = (harness as any).workspace, refresh = workspace.refresh;
  workspace.refresh = async () => { throw new Error('refresh failed'); };
  const failed = harness.submit({ message: 'inspect', useMemory: true, askApproval: true, tools: [], agent: '', prompt: '' });
  assert.equal((await failed.next()).value?.type, 'stopped'); await failed.return(undefined);
  assert.equal((await collect(harness.submit({ message: 'inspect', useMemory: true, askApproval: true, tools: [], agent: '', prompt: '' })))[0]!.type, 'stopped');
  workspace.refresh = async () => { harness.stop(); throw new Error('refresh cancelled'); };
  assert.equal((await collect(harness.submit({ message: 'inspect', useMemory: true, askApproval: true, tools: [], agent: '', prompt: '' })))[0]!.type, 'stopped');
  workspace.refresh = refresh;
});

test('a terminal goal cancels descendants before its closing answer', async t => {
  const { harness, model } = await fixture(t);
  let childId = '';
  model.decide = async function* (input, signal) {
    if (input.messages.at(-1)!.content === 'child waits') yield* hanging(signal);
    else if (input.tools?.some(tool => tool.function.name === 'update_goal')) {
      const child = await harness.spawnAgent({ task: 'child waits' }); childId = child.id;
      yield call('update_goal', { revision: harness.getGoal()!.revision, action: 'complete', evidence: 'The required result was verified independently.' });
    } else yield answer('goal complete');
  };
  await harness.startGoal({ objective: 'terminal cleanup' }); await collect(harness.subscribeRun(harness.inspectRun()!.id));
  assert.equal(harness.getAgentResult(childId).status, 'cancelled'); assert.equal(harness.inspectRun()!.status, 'completed');
});

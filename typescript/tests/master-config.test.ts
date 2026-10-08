import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { IDBFactory } from 'fake-indexeddb';
import { NodeHarness } from '../src/node/harness.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { BrowserStorage } from '../src/browser/storage.js';
import { Harness, type ModelPort } from '../src/harness.js';
import { Execution, type ExecutionClock } from '../src/execution.js';
import { boundedLimit, orchestrationLimits } from '../src/orchestration-limits.js';
import { agentAction } from '../src/transport.js';
import { headless } from '../src/node/headless.js';
import { loadHarness } from '../src/node/startup.js';

const call = (name: string, args: Record<string, unknown>) => JSON.stringify({ message: { tool_calls: [{ function: { name, arguments: args } }] }, done: true });
const answer = (content = 'verified') => JSON.stringify({ message: { content }, done: true });
const turn = { message: 'Inspect and verify the task', useMemory: true, tools: ['pwd'], askApproval: true, agent: '', prompt: '' };
const collect = async (stream: AsyncIterable<unknown>) => { for await (const _ of stream) {} };
class Clock implements ExecutionClock {
  time = 0; timers = new Map<object, { callback: () => void; at: number }>();
  now() { return this.time; }
  set(callback: () => void, delay: number) { const token = {}; this.timers.set(token, { callback, at: this.time + delay }); return token; }
  clear(token: unknown) { this.timers.delete(token as object); }
  advance(ms: number) { this.time += ms; for (const [token, timer] of this.timers) if (timer.at <= this.time) { this.timers.delete(token); timer.callback(); } }
}
async function settle(harness: Harness) { const run = harness.inspectRun(); assert.ok(run); await collect(harness.subscribeRun(run.id)); }

for (const runtime of ['Node', 'browser']) test(`${runtime}: master adopts the user turn, counts requests, configures bounded work and continues headlessly`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'master-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  let harness!: Harness; const messages: string[] = []; let step = 0;
  const model: ModelPort = { async *streamChat(input) {
    messages.push(input.messages.at(-1)!.content);
    if (++step === 1) {
      assert.ok(input.tools?.some(tool => tool.function.name === 'configure_goal'));
      yield call('get_orchestration', {});
    } else if (step === 2) yield call('configure_goal', { objective: 'Verify task', criteria: 'Inspect actual workspace', timeout_ms: 1000, max_rounds: 3, max_requests: 12 });
    else if (step === 3) yield call('configure_goal', { objective: 'Verify task', timeout_ms: 900, max_rounds: 3, max_requests: 12 });
    else if (step === 4) yield answer('first round done');
    else if (step === 5) yield call('update_goal', { revision: harness.getGoal()!.revision, action: 'complete', evidence: 'Checked the workspace' });
    else yield answer();
  } };
  const storage = await BrowserStorage.open('master-config', new IDBFactory()); t.after(() => storage.close());
  harness = runtime === 'Node' ? new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 100_000, ollama: model }) : await BrowserHarness.open({ storage, library: { agents: {}, prompts: {}, skills: {} }, seed: {}, modelPort: model, orchestrationLimits: { maxRounds: 3 } });
  await harness.initialize(); t.after(() => harness.close());
  await collect(harness.submit(turn)); await settle(harness);
  assert.equal(harness.getGoal()!.phase, 'complete');
  assert.equal(harness.getGoal()!.rounds, 2);
  assert.equal(harness.getGoal()!.model_requests, 6);
  assert.equal(messages.filter(message => message === turn.message).length, 1);
  assert.ok(messages.some(message => message.startsWith('<goal_round>')));
  assert.equal(harness.getOrchestration().permissions.allowSubagents, false);
  assert.equal(harness.inspectRun()!.timeout_ms, 900);
  const exported = harness.activeSessionRecord();
  if (runtime === 'browser') {
    await harness.close();
    const restored = await BrowserHarness.open({ storage, library: { agents: {}, prompts: {}, skills: {} }, seed: {}, modelPort: model });
    assert.equal(restored.getGoal()!.phase, 'complete'); assert.equal(restored.inspectRun(), undefined); await restored.close();
  }
  assert.ok(exported.events.some(event => event.type === 'goal_handoff'));
});

test('host ceilings validate direct APIs and child agents cannot configure master settings', async t => {
  assert.throws(() => orchestrationLimits({ maxRounds: 0 }), /positive integer/);
  assert.throws(() => boundedLimit(2, 1, 'rounds'), /harness limit/);
  const root = await mkdtemp(path.join(tmpdir(), 'master-caps-')); t.after(() => rm(root, { recursive: true, force: true }));
  const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 4000, allowSubagents: true, ollama: { async *streamChat() { yield answer(); } }, orchestrationLimits: { masterTimeoutMs: 100, childTimeoutMs: 20, maxRounds: 2, maxRequests: 5, maxConcurrentChildren: 1 } });
  t.after(() => harness.close());
  await assert.rejects(harness.configureGoal({ objective: 'outside turn' }), /running master/);
  for (const input of [{ timeoutMs: 101 }, { maxRounds: 3 }, { maxRequests: 6 }]) await assert.rejects(harness.startGoal({ objective: 'excess', ...input }), /harness limit/);
  await assert.rejects(harness.spawnAgent({ task: 'too long', timeoutMs: 21 }), /harness limit/);
  const child = await harness.spawnAgent({ task: 'inspect' });
  await harness.waitAgent(child.id);
  await assert.rejects(harness.restartAgent(child.id, undefined, 21), /harness limit/);
  const nested = new Harness((harness as any).options, 'parent'); t.after(() => nested.close());
  const denied = await nested.runTool('configure_goal', { objective: 'escape' }, ['configure_goal']); assert.match(JSON.stringify(denied), /unavailable/);
  await assert.rejects(nested.configureGoal({ objective: 'escape' }), /running master/);
  await harness.startGoal({ objective: 'bounded', maxRounds: 1 }); await settle(harness);
  await assert.rejects(harness.resumeGoal(harness.getGoal()!.revision, 101), /harness limit/);
});

test('configuration rejects invalid state, excessive settings and expired deadlines without resetting consumption', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'master-errors-')); t.after(() => rm(root, { recursive: true, force: true }));
  const clock = new Clock(); let harness!: Harness; let step = 0;
  const model: ModelPort = { async *streamChat() {
    if (++step === 1) {
      await assert.rejects(harness.configureGoal({ objective: '' }), /objective/);
      await assert.rejects(harness.configureGoal({ objective: 'bad', timeoutMs: 1_800_001 }), /harness limit/);
      clock.advance(5);
      await assert.rejects(harness.configureGoal({ objective: 'late', timeoutMs: 5 }), /already elapsed/);
      yield call('configure_goal', { objective: 'task', timeout_ms: 100, max_requests: 5, max_rounds: 2 });
    } else if (step === 2) {
      await assert.rejects(harness.configureGoal({ objective: 'task', maxRequests: 1 }), /consumed/);
      await assert.rejects(harness.configureGoal({ objective: 'task', timeoutMs: 101 }), /extended/);
      yield call('configure_goal', { objective: 'task', criteria: 'done', timeout_ms: 90 });
    } else if (step === 3) yield call('update_goal', { revision: harness.getGoal()!.revision, action: 'complete', evidence: 'checked' });
    else yield answer();
  } };
  harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 4000, ollama: model, clock }); t.after(() => harness.close());
  await collect(harness.submit(turn)); await settle(harness);
  assert.equal(harness.inspectRun()!.deadline_at, new Date(Date.parse(harness.inspectRun()!.started_at) + 90).toISOString());
  const noMemory = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 4000, ollama: { async *streamChat() { yield call('configure_goal', { objective: 'task' }); } } }); t.after(() => noMemory.close());
  await collect(noMemory.submit({ ...turn, useMemory: false })); assert.equal(noMemory.getGoal(), undefined);
  assert.match(JSON.stringify(noMemory.activeSessionRecord().events), /require harness memory/);
  const run = new Execution('x', 10, () => {}, () => {}, clock);
  assert.throws(() => run.constrainTimeout(11), /extended/);
  let finish!: () => void; run.start(() => new Promise<void>(resolve => { finish = resolve; }), async () => {});
  run.constrainTimeout(8); clock.advance(8); assert.equal(run.stopped, true); finish(); await run.done;
});

test('Stop cancels adoption, prevents continuation and preserves partial work', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'master-stop-')); t.after(() => rm(root, { recursive: true, force: true }));
  let harness!: Harness; let requests = 0;
  harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 4000, ollama: { async *streamChat() {
    if (++requests === 1) yield call('configure_goal', { objective: 'task' });
    else { harness.stop(); yield answer('partial'); }
  } } }); t.after(() => harness.close());
  await collect(harness.submit(turn)); await settle(harness);
  assert.equal(requests, 2); assert.equal(harness.inspectRun()!.status, 'cancelled');
  await assert.rejects(harness.configureGoal({ objective: 'restart' }), /running master/);
});

test('ordinary headless invocation waits for master-configured continuation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'master-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  let harness!: NodeHarness; let step = 0;
  harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 4000, ollama: { async *streamChat() {
    if (++step === 1) yield call('configure_goal', { objective: 'task' });
    else if (step === 3) yield call('update_goal', { revision: harness.getGoal()!.revision, action: 'complete', evidence: 'verified' });
    else yield answer();
  } } });
  const output: string[] = [];
  assert.equal(await headless(['task'], async () => harness, line => output.push(line)), 0);
  assert.equal(harness.getGoal()!.phase, 'complete');
  assert.ok(output.some(line => line.includes('run_ended')));
  const env = { MYHARNESS_ROOT: root, MYHARNESS_WORKSPACE: root, MYHARNESS_SETTINGS: path.join(root, 'settings.json'), MYHARNESS_SESSIONS: path.join(root, 'sessions'), MYHARNESS_PROVIDER: 'openai', MYHARNESS_MODEL: 'gpt-test', MYHARNESS_CONTEXT_LENGTH: '4000', MYHARNESS_ORCHESTRATION_LIMITS: '{"maxRounds":2}' };
  const loaded = await loadHarness(env); assert.equal(loaded.getOrchestration().limits.maxRounds, 2); await loaded.close();
});

test('configuration cannot undercount pre-goal requests or reconfigure a terminal goal', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'master-accounting-')); t.after(() => rm(root, { recursive: true, force: true }));
  let harness!: Harness; let step = 0;
  harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 4000, masterTimeoutMs: 1000, maxConcurrentChildren: 2, ollama: { async *streamChat() {
    if (++step === 1) yield call('get_orchestration', {});
    else if (step === 2) {
      await assert.rejects(harness.configureGoal({ objective: 'task', maxRequests: 1 }), /consumed/);
      yield call('configure_goal', { objective: 'task' });
    } else if (step === 3) {
      await harness.updateGoal(harness.getGoal()!.revision, 'complete', 'checked', true);
      await assert.rejects(harness.configureGoal({ objective: 'ended' }), /goal has ended/);
      yield answer();
    } else yield answer();
  } } }); t.after(() => harness.close());
  await collect(harness.submit(turn)); await settle(harness);
  assert.equal(harness.getGoal()!.model_requests, 4);
  assert.equal(harness.getOrchestration().limits.masterTimeoutMs, 1000);
});

test('legacy managed goals support configuration, cancellation keeps ordinary tasks usable and root request budgets are enforced', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'master-legacy-')); t.after(() => rm(root, { recursive: true, force: true }));
  let harness!: Harness; let step = 0;
  harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 4000, ollama: { async *streamChat(input) {
    if (++step === 1) yield call('configure_goal', { objective: 'legacy', max_rounds: 2, max_requests: 5 });
    else if (step === 2) yield call('update_goal', { revision: harness.getGoal()!.revision, action: 'complete', evidence: 'verified' });
    else yield answer();
  } } }); t.after(() => harness.close());
  await agentAction(harness, 'startGoal', { objective: 'legacy', turn }); await settle(harness);
  assert.equal(harness.inspectRun()!.status, 'completed');
  harness.stop(); await collect(harness.submit(turn)); assert.equal(harness.inspect().stopped, false);
  const limited = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 4000, orchestrationLimits: { maxRequests: 1 }, ollama: { async *streamChat() { yield call('pwd', {}); } } }); t.after(() => limited.close());
  await collect(limited.submit(turn)); assert.equal(limited.inspect().stopped, true);
  assert.equal(limited.activeSessionRecord().events.filter(event => event.type === 'request').length, 1);
  assert.ok(limited.activeSessionRecord().events.some(event => event.type === 'stopped'));
});

test('ordinary headless adoption handles master and child approvals without silent authorization', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'master-approvals-')); t.after(() => rm(root, { recursive: true, force: true }));
  let harness!: NodeHarness;
  harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 10_000, allowSubagents: true, childTools: ['write_file'], ollama: { async *streamChat(input) {
    const last = input.messages.at(-1)!;
    if (last.role === 'user' && last.content === 'task') yield call('configure_goal', { objective: 'task' });
    else if (last.role === 'tool' && last.tool_name === 'configure_goal') yield answer();
    else if (last.role === 'user' && last.content.startsWith('<goal_round>')) yield call('write_file', { path: 'master.txt', content: 'master' });
    else if (last.role === 'tool' && last.tool_name === 'write_file' && !input.messages.some(message => message.content === 'child task')) yield call('spawn_agent', { task: 'child task', tools: ['write_file'] });
    else if (last.role === 'user' && last.content === 'child task') yield call('write_file', { path: 'child.txt', content: 'child' });
    else if (last.role === 'tool' && last.tool_name === 'spawn_agent') yield call('wait_agent', { agent_id: harness.listAgents()[0]!.id });
    else if ((last.role === 'tool' && last.tool_name === 'wait_agent') || last.content.startsWith('[harness child settlement]')) yield call('update_goal', { revision: harness.getGoal()!.revision, action: 'complete', evidence: 'Both proposed effects were resolved' });
    else yield answer();
  } } });
  const output: string[] = [];
  assert.equal(await headless(['task'], async () => harness, line => output.push(line)), 0);
  assert.ok(output.some(line => line.includes('"type":"approval"') && !line.includes('agent_event')));
  assert.ok(output.some(line => line.includes('agent_event') && line.includes('"type":"approval"')));
});

test('headless cancellation before handoff cannot start continuation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'master-cli-stop-')); t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 4000, ollama: { async *streamChat() { requests++; yield call('configure_goal', { objective: 'task' }); } } });
  assert.equal(await headless(['task'], async () => harness, line => {
    const event = JSON.parse(line);
    if (event.type === 'tool' && event.name === 'configure_goal') process.emit('SIGINT');
  }), 130);
  assert.equal(requests, 1); assert.equal(harness.inspectRun()!.status, 'cancelled');
});

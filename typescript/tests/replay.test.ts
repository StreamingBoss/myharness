import assert from 'node:assert/strict';
import test from 'node:test';
import { action, collect, fixture } from './browser-fixture.js';
import { replayPlan, replaySteps, sessionAtStep } from '../src/replay.js';
import type { SessionRecord } from '../src/sessions.js';
import { replayRequest } from '../src/harness.js';

const record = (events: Record<string, unknown>[], memory: SessionRecord['memory'] = []): SessionRecord => ({ ...({ format: 'myharness-session', version: 1, id: 'a', name: 'n', created_at: '', updated_at: '', model: 'm', context_length: 1, workspace: '/w', last_prompt_tokens: 0, setup: { agent: '', prompt: '' }, snapshots: {}, project_instructions: null, settings: { use_memory: true, tools: [], ask_approval: true } } as const), events, memory });

test('streamed chunks and thinking join the event that ends them; every other event is a step', () => {
  const steps = replaySteps([{ type: 'chat_user' }, { type: 'request' }, { type: 'thinking' }, { type: 'chunk' }, { type: 'chunk' }, { type: 'response' }, { type: 'chunk' }]);
  assert.deepEqual(steps.map(step => [step.type, step.first, step.last]), [['chat_user', 0, 0], ['request', 1, 1], ['response', 2, 5], ['chunk', 6, 6]]);
  assert.deepEqual(replaySteps([]), []);
});

test('continuing is offered at the end of every turn of a real session, with the memory that turn had', async t => {
  const { backend } = await fixture(t);
  const memory: number[] = [];
  for (const message of ['List files', 'Read README.md', 'hello']) {
    await collect(backend.submit({ ...action, message, askApproval: false }));
    memory.push(backend.activeSessionRecord().memory.length);
  }
  const session = backend.activeSessionRecord();
  const plan = replayPlan(session);
  assert.ok(plan.some(step => step.type === 'tool'), 'the session used a tool');
  assert.deepEqual(plan.filter(step => step.memory !== undefined).map(step => step.memory), memory);
  const index = plan.findIndex(step => step.memory === memory[1]);
  const fork = sessionAtStep(session, index);
  assert.equal(fork.memory.length, memory[1]);
  assert.deepEqual(fork.memory, session.memory.slice(0, memory[1]));
  assert.equal(fork.events.length, plan[index]!.last + 1);
  assert.equal(fork.last_prompt_tokens, [...fork.events].reverse().find(event => event.type === 'response')!.tokens_in ?? 0);
  assert.equal(session.events.length > fork.events.length, true, 'the original session is untouched');
});

test('a step that is not the end of a turn cannot be continued', async t => {
  const { backend } = await fixture(t);
  await collect(backend.submit({ ...action, askApproval: false }));
  const session = backend.activeSessionRecord();
  assert.throws(() => sessionAtStep(session, 0), /cannot be continued/);
  assert.throws(() => sessionAtStep(session, 999), /cannot be continued/);
});

test('only the segment after the last reset can be rebuilt', () => {
  const answer = { role: 'assistant' as const, content: 'ok' };
  const turn = [{ type: 'chat_user' }, { type: 'response', tokens_in: 7 }];
  const plan = replayPlan(record([...turn, { type: 'reset' }, ...turn], [{ role: 'user', content: 'q' }, answer]));
  assert.deepEqual(plan.map(step => step.memory), [undefined, undefined, undefined, undefined, 2]);
  const fork = sessionAtStep(record([...turn, { type: 'reset' }, ...turn], [{ role: 'user', content: 'q' }, answer]), 4);
  assert.equal(fork.last_prompt_tokens, 7);
});

test('a session whose messages cannot be counted offers no step', () => {
  const answer = { role: 'assistant' as const, content: 'ok' };
  const turn = [{ type: 'chat_user' }, { type: 'response' }];
  const trimmed = replayPlan(record([...turn, { type: 'context', action: 'trim' }], [{ role: 'user', content: 'q' }, answer]));
  assert.equal(trimmed.some(step => step.memory !== undefined), false);
  const mismatch = replayPlan(record(turn, [{ role: 'user', content: 'q' }]));
  assert.equal(mismatch.some(step => step.memory !== undefined), false);
  const toolEnd = replayPlan(record([{ type: 'chat_user' }, { type: 'response' }], [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'x', arguments: {} } }] }]));
  assert.equal(toolEnd.some(step => step.memory !== undefined), false);
});

test('a fork without any response starts from zero prompt tokens and drops orchestration state', () => {
  const answer = { role: 'assistant' as const, content: 'ok' };
  const source = { ...record([{ type: 'chat_user' }, { type: 'response' }], [{ role: 'user', content: 'q' }, answer]), orchestration: { children: [] }, parent_session_id: 'p' };
  const fork = sessionAtStep(source, 1);
  assert.equal(fork.last_prompt_tokens, 0);
  assert.equal('orchestration' in fork || 'parent_session_id' in fork, false);
});

test('the backend plans a replay and continues a saved or recorded session as a new one', async t => {
  const { backend } = await fixture(t);
  for (const message of ['List files', 'hello']) await collect(backend.submit({ ...action, message, askApproval: false }));
  const saved = backend.activeSessionRecord();
  const { session, steps } = await backend.replayPlan({ id: saved.id });
  assert.equal(session.id, saved.id); assert.deepEqual(steps, replayPlan(saved));
  assert.deepEqual((await backend.replayPlan({ record: saved })).steps, steps);
  const before = (await backend.listSessions()).length;
  // From its last state: the saved session itself is activated, nothing is copied.
  await backend.newSession();
  assert.equal((await backend.continueSession({ id: saved.id })).id, saved.id);
  assert.equal((await backend.listSessions()).length, before + 1);
  // From a step: a new session holding the events and memory up to that step.
  const first = steps.findIndex(step => step.memory !== undefined);
  const forked = await backend.continueSession({ id: saved.id }, first);
  assert.notEqual(forked.id, saved.id); assert.match(forked.name, /\(continued from step \d+\)$/);
  assert.equal(forked.memory.length, steps[first]!.memory); assert.equal(backend.activeSessionRecord().id, forked.id);
  // A recorded session supplied whole is copied in, then continued from its last state.
  const recorded = await backend.continueSession({ record: saved });
  assert.notEqual(recorded.id, saved.id); assert.match(recorded.name, /\(continued\)$/); assert.deepEqual(recorded.memory, saved.memory);
  await assert.rejects(backend.continueSession({ id: saved.id }, 0), /cannot be continued/);
  await assert.rejects(backend.replayPlan({ record: { nope: true } }), /valid myharness session/);
  await assert.rejects(backend.replayPlan({ id: 'missing' }), /not found/);
});

test('a backend without session storage refuses to continue or to read a recorded session', async () => {
  const { NodeHarness } = await import('../src/node/harness.js');
  const harness = new NodeHarness({ workspace: process.cwd(), model: 'm', contextLength: 4000, ollama: { async *streamChat() { /* never called */ } } });
  Object.assign(harness, { sessions: undefined });
  await assert.rejects(harness.continueSession({ id: 'x' }), /persistence is not configured/);
  await assert.rejects(harness.replayPlan({ record: {} }), /persistence is not configured/);
});

test('replay requests name a saved session or a recorded one, and a non-negative whole step', () => {
  assert.deepEqual(replayRequest({ id: 'a' }), { source: { id: 'a' } });
  assert.deepEqual(replayRequest({ record: { x: 1 }, step: 3 }), { source: { record: { x: 1 } }, step: 3 });
  assert.throws(() => replayRequest({}), /id of a saved session/);
  for (const step of [-1, 1.5, '2']) assert.throws(() => replayRequest({ id: 'a', step }), /non-negative integer/);
});

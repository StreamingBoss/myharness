import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeHarness, type ModelPort, type TurnAction } from '../src/node/harness.js';
import { HarnessCore, type ApprovalOutcome, type ChatMessage, type CoreEvent, type ModelRequest } from '../src/core.js';
import { ARGUMENT_PREVIEW_CHARS, REPEAT_THRESHOLDS, RepeatGuard, canonicalArguments } from '../src/guard.js';

const turn = (overrides: Partial<TurnAction> = {}): TurnAction => ({ message: 'hello', useMemory: true, tools: [], askApproval: true, agent: '', prompt: '', ...overrides });
const reply = (content = 'done'): unknown[] => [{ message: { role: 'assistant', content }, done: true, prompt_eval_count: 12, eval_count: 2 }];
const call = (name: string, args: Record<string, unknown> = {}): unknown[] => [{ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: true }];
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values = []; for await (const value of source) values.push(value); return values; }

class Model implements ModelPort {
  requests: ModelRequest[] = [];
  turns: unknown[][] = [];
  async *streamChat(payload: ModelRequest): AsyncGenerator<string> {
    this.requests.push(structuredClone(payload));
    for (const chunk of this.turns.shift() ?? reply()) yield JSON.stringify(chunk);
  }
  async request(): Promise<Record<string, unknown>> { return { message: { content: 'summary' } }; }
}
async function fixture(t: { after(fn: () => unknown): void }, options: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-guard-')); t.after(() => rm(root, { recursive: true, force: true }));
  const model = new Model();
  const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 100_000, ollama: model, ...options });
  return { root, harness, model };
}
const lastToolText = (model: Model): string => String([...model.requests.at(-1)!.messages].reverse().find(message => message.role === 'tool')!.content);

// --- Repeat guard ---------------------------------------------------------

test('RepeatGuard reminds at each threshold, gently first, and ignores argument key order', () => {
  const guard = new RepeatGuard(), seen: Array<[number, string]> = [];
  for (let i = 1; i <= 10; i++) {
    const reminder = guard.observe('read_file', i % 2 ? { path: 'a', start_line: 1 } : { start_line: 1, path: 'a' });
    if (reminder) { seen.push([reminder.count, reminder.level]); assert.equal(reminder.tool, 'read_file'); }
  }
  assert.deepEqual(REPEAT_THRESHOLDS, [3, 5, 8]);
  assert.deepEqual(seen, [[3, 'gentle'], [5, 'detailed'], [8, 'detailed']]);
});

test('RepeatGuard restarts when the tool or its arguments change, and distinguishes nested values', () => {
  const guard = new RepeatGuard();
  assert.equal(guard.observe('a', { x: 1 }), undefined); assert.equal(guard.observe('a', { x: 1 }), undefined);
  assert.equal(guard.observe('a', { x: 2 }), undefined); assert.equal(guard.observe('a', { x: 1 }), undefined);
  assert.equal(guard.observe('b', { x: 1 }), undefined); assert.equal(guard.observe('b', { x: 1 }), undefined);
  assert.equal(guard.observe('b', { x: 1 })!.level, 'gentle');
  assert.equal(canonicalArguments({ b: [{ z: 1, y: null }], a: 'x' }), '{"a":"x","b":[{"y":null,"z":1}]}');
  assert.notEqual(canonicalArguments({ a: [1, 2] }), canonicalArguments({ a: [2, 1] }));
});

test('RepeatGuard detailed reminders name the call and cap long arguments', () => {
  const guard = new RepeatGuard(), long = 'y'.repeat(ARGUMENT_PREVIEW_CHARS + 50);
  let detailed;
  for (let i = 0; i < 5; i++) detailed = guard.observe('write_file', { content: long });
  assert.match(detailed!.message, /Repeated tool call detected/); assert.match(detailed!.message, /tool: write_file/);
  assert.match(detailed!.message, /consecutive_calls: 5/); assert.match(detailed!.message, /more chars\)/);
  const short = new RepeatGuard(); let small;
  for (let i = 0; i < 5; i++) small = short.observe('pwd', {});
  assert.match(small!.message, /arguments: \{\}\n/); assert.doesNotMatch(small!.message, /more chars/);
});

test('the core injects a reminder after the tool batch when the model repeats a call, without a UI', async t => {
  const { harness, model } = await fixture(t);
  model.turns = [call('pwd'), call('pwd'), call('pwd'), reply('finished')];
  const events = await collect(harness.submit(turn({ tools: ['pwd'] })));
  const guards = events.filter(event => event.type === 'guard');
  assert.equal(guards.length, 1);
  assert.deepEqual({ ...guards[0], memory: undefined, content: undefined }, { type: 'guard', name: 'repeat_tool_call', tool: 'pwd', count: 3, level: 'gentle', content: undefined, memory: undefined });
  assert.match(String(guards[0]!.content), /^\[harness reminder\] You are repeating the exact same tool call/);
  // The reminder follows the third tool result, so the fourth request sees tool result, then reminder.
  const messages = model.requests[3]!.messages;
  assert.deepEqual(messages.slice(-2).map(message => message.role), ['tool', 'user']);
  assert.equal(messages.at(-1)!.content, guards[0]!.content);
  assert.equal(harness.inspect().memory.at(-1)!.content, 'finished');
});

test('a new turn starts a fresh count and differing calls never remind', async t => {
  const { harness, model } = await fixture(t);
  model.turns = [call('pwd'), call('pwd'), reply()];
  assert.equal((await collect(harness.submit(turn({ tools: ['pwd'] })))).filter(event => event.type === 'guard').length, 0);
  model.turns = [call('pwd'), call('get_time'), call('pwd'), reply()];
  assert.equal((await collect(harness.submit(turn({ tools: ['pwd', 'get_time'] })))).filter(event => event.type === 'guard').length, 0);
});

test('refused calls count toward the repeat guard', async t => {
  const { harness, model } = await fixture(t);
  model.turns = [call('run_command', { command: 'true' }), call('run_command', { command: 'true' }), call('run_command', { command: 'true' }), reply()];
  const events: CoreEvent[] = [];
  for await (const event of harness.submit(turn({ tools: ['run_command'] }))) { events.push(event); if (event.type === 'approval') harness.approve(String(event.id), false); }
  assert.equal(events.filter(event => event.type === 'guard').length, 1);
});

test('Stop during a batch skips the remaining calls and queues no reminder', async () => {
  const messages: ChatMessage[] = [], events: CoreEvent[] = [];
  let stopped = false, ran = 0;
  const batch = { message: { content: '', tool_calls: [1, 2, 3, 4].map(() => ({ function: { name: 'pwd', arguments: {} } })) }, done: true };
  const host = {
    maxSteps: 3, stopped: () => stopped, model: () => 'fake', contextLength: () => 1000, lastPromptTokens: () => 0, setLastPromptTokens() {},
    memoryText: () => '', systemMessages: () => [], estimateTokens: () => 1, trimContext: () => undefined, async *compactContext() {},
    async *streamChat() { yield JSON.stringify(batch); }, splitJson: () => ['', '', ''], skillContext: () => ({}),
    async runTool() { ran += 1; if (ran === 2) stopped = true; return { kind: 'text' as const, text: 'ok' }; },
    async *applyChange() { return ''; }, async *executeCommand() { return ''; }, recordEvent(event: CoreEvent) { events.push(event); },
  };
  const user: ChatMessage = { role: 'user', content: 'go' }; messages.push(user);
  for await (const event of new HarnessCore(host).runTurn({ userMessage: user, conversation: messages, setup: { agent: '', prompt: '' }, enabledTools: ['pwd'], selectedTools: [], useMemory: false })) void event;
  assert.equal(ran, 2);
  assert.equal(events.some(event => event.type === 'guard'), false);
  assert.equal(events.at(-1)!.type, 'stopped');
});

// --- Approval outcomes ----------------------------------------------------

const writeTurn = turn({ tools: ['write_file'] });

test('approval outcomes: allowed-once runs; rejected, unavailable and cancelled never run and say why', async t => {
  const { root, harness, model } = await fixture(t, { approvalTimeoutMs: 20 });
  const seen: Array<[ApprovalOutcome, boolean, string]> = [];
  const answers: Array<'allow' | 'reject' | 'silence' | 'stop'> = ['allow', 'reject', 'silence', 'stop'];
  for (const answer of answers) {
    model.turns = [call('write_file', { path: `${answer}.txt`, content: 'x' }), reply()];
    const events: CoreEvent[] = [];
    for await (const event of harness.submit(writeTurn)) {
      events.push(event);
      if (event.type === 'approval') { if (answer === 'allow') harness.approve(String(event.id), true); if (answer === 'reject') harness.approve(String(event.id), false); if (answer === 'stop') harness.stop(); }
    }
    const change = events.find(event => event.type === 'change')!;
    seen.push([change.outcome as ApprovalOutcome, change.approved as boolean, answer === 'stop' ? 'stop' : lastToolText(model)]);
  }
  assert.deepEqual(seen.map(([outcome, approved]) => [outcome, approved]), [['allowed-once', true], ['rejected', false], ['unavailable', false], ['cancelled', false]]);
  assert.match(seen[0]![2], /^ok: created/); assert.match(seen[1]![2], /^refused: the user did not approve this change/);
  assert.match(seen[2]![2], /^unavailable: nobody answered the approval request, so this change did not run\. Do not retry/);
  await access(path.join(root, 'allow.txt'));
  for (const name of ['reject', 'silence', 'stop']) await assert.rejects(access(path.join(root, `${name}.txt`)));
});

test('commands and MCP-free paths report outcomes too, and an unanswered command is unavailable', async t => {
  const { harness, model } = await fixture(t, { approvalTimeoutMs: 20 });
  model.turns = [call('run_command', { command: 'printf never' }), reply()];
  const silent = await collect(harness.submit(turn({ tools: ['run_command'] })));
  assert.equal(silent.find(event => event.type === 'command')!.outcome, 'unavailable');
  assert.match(lastToolText(model), /^unavailable: nobody answered the approval request, so this command did not run/);
  model.turns = [call('run_command', { command: 'printf yes' }), reply()];
  const events: CoreEvent[] = [];
  for await (const event of harness.submit(turn({ tools: ['run_command'] }))) { events.push(event); if (event.type === 'approval') harness.approve(String(event.id), true); }
  assert.deepEqual([events.find(event => event.type === 'command')!.outcome, events.find(event => event.type === 'command')!.approved], ['allowed-once', true]);
});

test('with approvals switched off nothing is asked and the outcome is allowed-once', async t => {
  const { harness, model } = await fixture(t);
  model.turns = [call('write_file', { path: 'free.txt', content: 'x' }), reply()];
  const events = await collect(harness.submit(turn({ tools: ['write_file'], askApproval: false })));
  assert.equal(events.some(event => event.type === 'approval'), false);
  assert.equal(events.find(event => event.type === 'change')!.outcome, 'allowed-once');
});

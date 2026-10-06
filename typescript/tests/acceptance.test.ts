import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeHarness, type TurnAction, type ModelPort } from '../src/node/harness.js';
import { SessionStore, sessionSummary, sessionTitle } from '../src/node/sessions.js';
import type { ChatMessage, CoreEvent, ModelRequest } from '../src/core.js';
import { headless } from '../src/node/headless.js';
import { Catalog, skillContext, skillsSection } from '../src/node/catalog.js';
import { WorkspaceAdapter, unescape } from '../src/node/workspace.js';
import { characters, estimateTokens, json, lines, pythonRepr, renderQwenPrompt, retainedBoundary, splitJson } from '../src/format.js';
import { TOOLS } from '../src/node/tools.js';

const turn = (overrides: Partial<TurnAction> = {}): TurnAction => ({ message: 'hello', useMemory: true, tools: [], askApproval: true, agent: '', prompt: '', ...overrides });
const reply = (content = 'done'): unknown[] => [{ message: { role: 'assistant', content }, done: true, prompt_eval_count: 12, eval_count: 2 }];
const call = (name: string, args: Record<string, unknown> = {}): unknown[] => [{ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: true }];
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values = []; for await (const value of source) values.push(value); return values; }
class Model implements ModelPort {
  requests: ModelRequest[] = [];
  turns: unknown[][] = [reply()];
  summary: Record<string, unknown> = { message: { content: 'Goal: continue.' } };
  fail = false;
  async *streamChat(payload: ModelRequest): AsyncGenerator<string> {
    this.requests.push(structuredClone(payload));
    if (this.fail) throw new Error('offline');
    for (const chunk of this.turns.shift() ?? reply()) yield JSON.stringify(chunk);
  }
  async request(endpoint: string): Promise<Record<string, unknown>> {
    if (this.fail) throw new Error('offline');
    return endpoint === 'show' ? { template: 'qwen template', parameters: 'num_ctx 4096' } : this.summary;
  }
}
async function fixture(t: { after(fn: () => unknown): void }, options: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-accept-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'work')); await mkdir(path.join(root, 'agents')); await mkdir(path.join(root, 'prompts')); await mkdir(path.join(root, 'skills/basic'), { recursive: true });
  await writeFile(path.join(root, 'agents/coder.md'), 'tools: read_file,invalid\n---\nCoding rules');
  await writeFile(path.join(root, 'agents/plain.md'), 'Plain persona');
  await writeFile(path.join(root, 'prompts/product.md'), 'Product rules');
  await writeFile(path.join(root, 'skills/basic/SKILL.md'), '---\nname: basic\ndescription: test skill\n---\nFirst instruction\nSecond instruction');
  const model = new Model(), sessions = new SessionStore(path.join(root, 'sessions'));
  const harness = new NodeHarness({ workspace: path.join(root, 'work'), model: 'qwen3:8b', contextLength: 4096, projectRoot: root, ollama: model, sessions, approvalTimeoutMs: 1000, ...options });
  await harness.initialize();
  return { root, harness, model, sessions };
}

test('catalog loading, system ordering, frozen snapshots, manual skills and explorer', async t => {
  const { root, harness, model } = await fixture(t);
  await mkdir(path.join(root, 'work/agents')); await mkdir(path.join(root, 'work/skills/override'), { recursive: true });
  await writeFile(path.join(root, 'work/agents/coder.md'), 'tools: pwd\n---\nProject persona');
  await writeFile(path.join(root, 'work/AGENTS.md'), 'Project rules');
  await writeFile(path.join(root, 'work/skills/override/SKILL.md'), '---\nname: basic\ndescription: overridden\n---\nproject skill');
  const bootstrap = await harness.bootstrap();
  assert.equal((bootstrap.tools as unknown[]).length, 14); assert.equal((bootstrap.agents as unknown[]).length, 2);
  const events = await collect(harness.submit(turn({ message: '/basic do work', agent: 'coder', prompt: 'product', tools: ['use_skill'] })));
  assert.equal(events[0]!.type, 'skill');
  assert.match(model.requests[0]!.messages[0]!.content, /Product rules\n\nProject persona\n\n# Project instructions/);
  assert.match(model.requests[0]!.messages.at(-1)!.content, /project skill/);
  await writeFile(path.join(root, 'prompts/product.md'), 'Edited product');
  await collect(harness.submit(turn({ agent: 'plain', prompt: '', tools: ['use_skill'] })));
  assert.match(model.requests[1]!.messages[0]!.content, /Product rules/);
  const explore = await harness.explore(turn({ tools: ['use_skill'] })); assert.equal(explore.system_prompt, 'Product rules'); assert.equal(explore.skills_listed, true); assert.match(String(explore.final), /your next message/);
  assert.match((await harness.runTool('use_skill', { name: 'basic' }, ['use_skill']) as { text: string }).text, /project skill/);
  assert.match((await harness.runTool('use_skill', { name: 'missing' }, ['use_skill']) as { text: string }).text, /there is no skill/);
  await harness.reset();
  assert.equal((harness.bootstrap && await harness.bootstrap()).locked, null);
  await collect(harness.submit(turn({ message: '/basic', prompt: 'product', useMemory: false })));
  assert.match(model.requests[2]!.messages[0]!.content, /Edited product/);
  harness.state.model = 'other'; assert.match(String((await harness.explore(turn())).final), /only written for Qwen/);
  assert.equal(harness.activeSessionRecord().settings.use_memory, false);
});

test('approvals accept, deny, timeout and Stop without authorizing pending work', async t => {
  const { root, harness, model } = await fixture(t);
  for (const approved of [false, true]) {
    model.turns = [call('write_file', { path: 'note.txt', content: 'draft' }), reply()];
    const events: CoreEvent[] = [];
    for await (const event of harness.submit(turn({ tools: ['write_file'] }))) {
      events.push(event);
      if (event.type === 'approval') { assert.match(String(event.diff), /--- \/dev\/null/); assert.equal(harness.approve(String(event.id), approved), true); }
    }
    assert.equal(events.find(event => event.type === 'change')!.approved, approved);
  }
  assert.equal(await readFile(path.join(root, 'work/note.txt'), 'utf8'), 'draft');
  model.turns = [call('write_file', { path: 'timeout.txt', content: 'x' }), reply()];
  const timeout = await collect(harness.submit(turn({ tools: ['write_file'] })));
  assert.equal(timeout.find(event => event.type === 'change')!.approved, false);
  model.turns = [call('write_file', { path: 'stop.txt', content: 'x' }), reply()];
  for await (const event of harness.submit(turn({ tools: ['write_file'] }))) if (event.type === 'approval') harness.stop();
  await assert.rejects(readFile(path.join(root, 'work/stop.txt')));
  assert.equal(harness.approve('expired', true), false);
  model.turns = [call('run_command', { command: 'printf never' }), reply()];
  for await (const event of harness.submit(turn({ tools: ['run_command'] }))) if (event.type === 'approval') harness.approve(String(event.id), false);
  model.turns = [call('run_command', { command: 'printf never' }), reply()];
  for await (const event of harness.submit(turn({ tools: ['run_command'] }))) if (event.type === 'approval') harness.stop();
});

test('tool errors, write repairs, no changes, empty files, newlines and command output limits', async t => {
  const { root, harness, model } = await fixture(t);
  await writeFile(path.join(root, 'work/file.txt'), 'one\ntwo');
  for (const [name, args] of [['pwd', {}], ['get_current_time', {}], ['list_files', {}], ['read_file', { path: 'file.txt', start_line: 1, end_line: 1 }], ['find_files', { pattern: '*.txt' }], ['search', { pattern: 'two' }], ['edit_file', { path: 'file.txt', old_text: 'one', new_text: 'first' }], ['write_file', { path: 'fixed.txt', content: 'a\\nb' }], ['run_command', { command: 'true' }]] as [string, Record<string, unknown>][]) assert.notEqual((await harness.runTool(name, args, [name])).kind, undefined);
  for (const [name, args] of [['read_file', {}], ['read_file', { path: 'file.txt', start_line: 'bad' }], ['read_file', { path: 'missing' }], ['write_file', { path: '.', content: 'x' }], ['run_command', { command: '' }]] as [string, Record<string, unknown>][]) assert.match((await harness.runTool(name, args, [name]) as { text: string }).text, /^error:/);
  assert.match((await harness.runTool('pwd', {}, []) as { text: string }).text, /unknown/);
  assert.match((await harness.runTool('invalid', {}, ['invalid']) as { text: string }).text, /unknown/);
  model.turns = [call('write_file', { path: 'fixed.txt', content: 'a\\nb' }), reply()];
  const repair = await collect(harness.submit(turn({ tools: ['write_file'], askApproval: false })));
  assert.match(String(repair.find(event => event.type === 'change')!.note), /literal/);
  for (const content of ['one\ntwo', 'one\ntwo\n', 'one\ntwo', 'changed']) {
    model.turns = [call('write_file', { path: 'file.txt', content }), reply()]; await collect(harness.submit(turn({ tools: ['write_file'], askApproval: false })));
  }
  model.turns = [call('write_file', { path: 'empty.txt', content: '' }), reply()];
  const empty = await collect(harness.submit(turn({ tools: ['write_file'], askApproval: false })));
  assert.equal(empty.find(event => event.type === 'change')!.diff, 'Creating an empty file.');
  assert.equal(await readFile(path.join(root, 'work/empty.txt'), 'utf8'), '');
  model.turns = [call('run_command', { command: "printf error >&2; printf '🙂%.0s' {1..10002}" }), reply()];
  const result = await collect(harness.submit(turn({ tools: ['run_command'], askApproval: false })));
  assert.match(String(result.find(event => event.type === 'command')!.output), /^\[first 7 characters cut\]/);
  model.turns = [call('run_command', { command: 'true' }), reply()]; await collect(harness.submit(turn({ tools: ['run_command'], askApproval: false })));
});

test('concurrency, model failure cleanup, rejected stale tabs, and cancellation', async t => {
  const { harness, model } = await fixture(t);
  const source = harness.submit(turn()); await source.next();
  await assert.rejects(collect(harness.submit(turn())), /already running/);
  await assert.rejects(harness.newSession(), /running turn/); await assert.rejects(harness.reset(), /running turn/); await assert.rejects(harness.setProject('.'), /running turn/);
  await assert.rejects(collect(harness.compact()), /already running/);
  await source.return(undefined);
  await assert.rejects(collect(harness.submit(turn({ sessionId: 'stale' }))), /no longer/);
  model.fail = true;
  assert.match(String((await collect(harness.submit(turn()))).at(-1)!.reason), /offline/);
  model.fail = false; await collect(harness.submit(turn()));
  const aborting: ModelPort = { async *streamChat(_payload, signal) { if (!signal!.aborted) await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true })); throw new Error('aborted'); } };
  const stopped = new NodeHarness({ workspace: harness.state.workspace, model: 'scripted', contextLength: 1000, ollama: aborting });
  const pending = stopped.submit(turn()); await pending.next(); const next = pending.next(); stopped.stop();
  assert.equal((await next).value!.type, 'stopped'); await pending.return(undefined);
});

test('command timeout kills children and Stop interrupts a process group', async t => {
  const { harness, model, root } = await fixture(t, { commandTimeoutMs: 30 });
  const command = 'sleep 5 & echo $! > child.pid; wait';
  model.turns = [call('run_command', { command }), reply()];
  const result = await collect(harness.submit(turn({ tools: ['run_command'], askApproval: false })));
  assert.match(String(result.find(event => event.type === 'command')!.status), /timed out/);
  const pid = Number(await readFile(path.join(root, 'work/child.pid'), 'utf8'));
  try { const status = await readFile(`/proc/${pid}/stat`, 'utf8'); assert.match(status, /\) Z /); } catch (error) { if (!(error as NodeJS.ErrnoException).code) throw error; }
  model.turns = [call('run_command', { command: 'sleep 5' }), reply()];
  const events = harness.submit(turn({ tools: ['run_command'], askApproval: false })); await events.next(); await events.next();
  const next = events.next(); setImmediate(() => harness.stop());
  assert.match(String((await next).value!.status), /stopped by the user/); await events.return(undefined);
});

test('session import/export, naming, settings, workspace switch, snapshots and interrupted recovery', async t => {
  const { root, harness, sessions, model } = await fixture(t, { settingsFile: undefined });
  await collect(harness.submit(turn({ agent: 'coder', prompt: 'product' })));
  const first = harness.activeSessionRecord();
  await harness.patchSession(first.id, { name: 'Same', settings: { use_memory: false, tools: ['pwd'], ask_approval: false, draft: 'ignore' } });
  await harness.newSession('Same');
  assert.equal((await harness.patchSession(harness.activeSessionRecord().id, { name: 'Same' })).name, 'Same (2)');
  await assert.rejects(harness.patchSession(first.id, {}), /no longer/);
  const imported = await harness.importSession(await harness.getSession(first.id)); assert.match(imported.name, /imported/); assert.notEqual(imported.id, first.id);
  await assert.rejects(harness.importSession({}), /valid myharness/);
  first.memory.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file' } }, { function: { name: 'pwd' } }] });
  await sessions.save(first); await harness.activateSession(first.id);
  assert.equal(harness.inspect().memory.at(-1)!.tool_name, 'pwd'); assert.match(harness.inspect().memory.at(-1)!.content, /previous harness process/);
  await mkdir(path.join(root, 'second')); await writeFile(path.join(root, 'second/AGENTS.md'), 'New rules');
  await harness.setProject(path.join(root, 'second'));
  assert.match(harness.systemMessages({ agent: 'coder', prompt: 'product' }, true)[0]!.content, /New rules/);
  await assert.rejects(harness.setProject('C:\\x'), /WSL/); await assert.rejects(harness.setProject(path.join(root, 'missing')), /does not exist/); await assert.rejects(harness.setProject(path.join(root, 'prompts/product.md')), /not a folder/);
  const missing = await harness.getSession(first.id); missing.workspace = path.join(root, 'gone'); await sessions.save(missing); await harness.activateSession(first.id);
  await assert.rejects(collect(harness.submit(turn())), /saved project folder is missing/);
  await harness.setProject(path.join(root, 'work')); model.turns = [reply()]; await collect(harness.submit(turn()));
  const restarted = new NodeHarness({ workspace: root, model: 'other', contextLength: 1, sessions, projectRoot: root, ollama: model }); await restarted.initialize(); assert.equal(restarted.state.model, 'qwen3:8b');
  const ephemeral = new NodeHarness({ workspace: root, model: 'x', contextLength: 1000, ollama: model }); await ephemeral.newSession(); assert.deepEqual(await ephemeral.listSessions(), []);
  await assert.rejects(ephemeral.getSession('x'), /not configured/); await assert.rejects(ephemeral.importSession({}), /not configured/); await ephemeral.patchSession(ephemeral.activeSessionRecord().id, { name: 'Title', settings: {} });
  await assert.rejects(sessions.load('../escape'), /Invalid session/);
  assert.equal(sessionTitle('a'.repeat(61)), 'a'.repeat(60) + '…');
  assert.equal(sessionSummary({ ...first, name: 'New session', events: [], memory: [] }).name, 'New session');
});

function history(): ChatMessage[] { return Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'old conversation '.repeat(50) })); }
test('context trim/compaction respects tail and preserves memory on failures', async t => {
  const { harness, model } = await fixture(t);
  const memory = history(); memory[1] = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }] }; memory[2] = { role: 'tool', tool_name: 'read_file', content: 'old '.repeat(4000) };
  harness.state.memory.splice(0, 0, ...memory); const tail = structuredClone(harness.state.memory.slice(-4));
  assert.equal(harness.trimContext([], harness.state.memory, [])!.action, 'trim'); assert.deepEqual(harness.state.memory.slice(-4), tail);
  harness.state.memory.splice(0, harness.state.memory.length, ...history());
  const success = await collect(harness.compact()); assert.equal(success.at(-1)!.action, 'compact'); assert.deepEqual(harness.state.memory.slice(-4), tail);
  for (const summary of [{}, { message: { content: 1 } }, { message: { content: '' } }, { message: { content: 'x' }, done_reason: 'length' }, { message: { content: 'huge '.repeat(2000) } }]) {
    harness.state.memory.splice(0, harness.state.memory.length, ...history()); const before = structuredClone(harness.state.memory); model.summary = summary;
    const errors = await collect(harness.compact()); assert.equal(errors.at(-1)!.action, 'error'); assert.deepEqual(harness.state.memory, before);
  }
  model.fail = true; assert.equal((await collect(harness.compact())).at(-1)!.action, 'error'); model.fail = false;
  await assert.rejects(collect(harness.compact({ useMemory: false })), /Enable Harness memory/);
  harness.state.contextLength = 100; assert.match(String((await collect(harness.compact())).at(-1)!.reason), /too large/);
  await harness.reset(); assert.match(String((await collect(harness.compact())).at(-1)!.reason), /Nothing to compact/);
});

test('headless CLI uses full core, explicitly denies actions and supports Reset/Compact/help', async t => {
  const { harness, model } = await fixture(t);
  const output: string[] = [];
  assert.equal(await headless(['--help'], async () => harness, value => output.push(value)), 0);
  assert.equal(await headless([], async () => harness, value => output.push(value)), 1);
  assert.equal(await headless(['hello', '--tools', 'pwd', '--no-memory'], async () => harness, value => output.push(value)), 0);
  model.turns = [call('write_file', { path: 'no.txt', content: 'no' }), reply()];
  assert.equal(await headless(['hello'], async () => harness, value => output.push(value)), 0);
  model.turns = [call('write_file', { path: 'yes.txt', content: 'yes' }), reply()];
  assert.equal(await headless(['hello', '--approve'], async () => harness, value => output.push(value)), 0);
  assert.equal(await headless(['--reset'], async () => harness, value => output.push(value)), 0);
  assert.equal(await headless(['--compact'], async () => harness, value => output.push(value)), 0);
});

test('formatting preserves Unicode, JSON, role boundaries and reconstructed Qwen tools', () => {
  assert.equal(characters('🙂'), 1); assert.equal(lines('a\r\nb\n').length, 2);
  assert.equal(json({ a: 'x:y, z', quote: '\\"' }), '{"a": "x:y, z", "quote": "\\\\\\\""}');
  assert.equal(pythonRepr([null, false, true, { x: "I'm \"quoted\"\n\t" }, 2]), "[None, False, True, {'x': 'I\\'m \"quoted\"\\n\\t'}, 2]");
  assert.equal(pythonRepr("I'm"), '"I\'m"');
  const parts = splitJson({ a: '@@HIGHLIGHT@@' }, { content: '🙂' }); assert.deepEqual(JSON.parse(parts.join('')), { a: { content: '🙂' } });
  const messages: ChatMessage[] = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'pwd', arguments: { z: {}, a: [1] } } }] }, { role: 'tool', content: 'here', tool_name: 'pwd' }, { role: 'assistant', content: 'done' }];
  const rendered = renderQwenPrompt(messages, TOOLS); assert.match(rendered, /\{"a":\[1\],"z":\{\}\}/); assert.equal(estimateTokens([], messages, TOOLS), Math.ceil(characters(rendered) / 4));
  assert.equal(retainedBoundary([...messages, { role: 'user', content: 'Next' }]), 2);
  assert.equal(unescape('a\\r\\nb\\t\\"c'), 'a\nb\t"c');
  assert.equal(skillsSection({}), '');
  assert.equal(skillContext([{ role: 'tool', tool_name: 'read_file', content: '   1: first\nplain' }], { s: { name: 's', description: '', body: 'first', source: 'test' } }).s !== undefined, true);
});

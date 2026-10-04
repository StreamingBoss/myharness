import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeHarness, type ModelPort } from '../src/node/harness.js';
import { WorkspaceAdapter } from '../src/node/workspace.js';
import { Catalog } from '../src/node/catalog.js';
import { SessionStore, sessionSummary } from '../src/node/sessions.js';
import { headless } from '../src/node/headless.js';
import { lines, renderQwenPrompt, retainedBoundary, toolAsGoValue } from '../src/format.js';
import type { ChatMessage, CoreEvent } from '../src/core.js';

const action = { message: 'hello', useMemory: true, tools: [], askApproval: false, agent: '', prompt: '' };
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values = []; for await (const value of source) values.push(value); return values; }
const model: ModelPort = { async *streamChat() { yield JSON.stringify({ message: { content: 'ok' }, done: true }); }, async request() { return { message: { content: 'summary' } }; } };
async function root(t: { after(fn: () => unknown): void }): Promise<string> { const dir = await mkdtemp(path.join(tmpdir(), 'myharness-edge-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('workspace limits, symlinks, invalid UTF8, glob classes and repair semantics', async t => {
  const dir = await root(t), adapter = new WorkspaceAdapter(dir);
  await mkdir(path.join(dir, 'sub')); await mkdir(path.join(dir, '.git')); await mkdir(path.join(dir, 'node_modules'));
  await writeFile(path.join(dir, 'sub/a.txt'), 'a\nb\n');
  assert.equal(await adapter.readNumbered('sub/a.txt', 1, 1), '   1: a\n[lines 1-1 of 2; call again with start_line=2]');
  for (let i = 0; i < 205; i++) await writeFile(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), 'needle\n');
  assert.match(await adapter.findFiles('f*.txt'), /5 more not shown/);
  assert.match(await adapter.search('needle'), /more matches not shown/);
  assert.equal(await adapter.findFiles('*.none'), '(no files found)'); assert.equal(await adapter.search('missing'), '(no matches)');
  await writeFile(path.join(dir, 'long'), 'x'.repeat(600)); assert.match(await adapter.search('x', 'long'), /line truncated/);
  await writeFile(path.join(dir, 'binary'), 'needle\0'); await writeFile(path.join(dir, 'invalid'), Buffer.from([110, 101, 101, 100, 108, 101, 255]));
  assert.equal(await adapter.search('needle', '.', 'binary'), '(no matches)'); assert.equal(await adapter.search('needle', '.', 'invalid'), '(no matches)');
  await writeFile(path.join(dir, 'sub/huge'), ('x'.repeat(1000) + '\n').repeat(20)); assert.match(await adapter.readNumbered('sub/huge'), /start_line=10/);
  await writeFile(path.join(dir, 'repair'), 'one\ntwo'); assert.equal((await adapter.edit('repair', 'one\\ntwo', 'new\\nline')).note?.includes('literal'), true);
  assert.equal((await adapter.edit('repair', 'one', '$&')).content, '$&\ntwo');
  await symlink(path.join(dir, 'sub/a.txt'), path.join(dir, 'link.txt')); await symlink('/etc/passwd', path.join(dir, 'outside')); await symlink(path.join(dir, 'sub'), path.join(dir, 'linked-dir'));
  assert.match(await adapter.findFiles('link.txt'), /link.txt/); assert.equal(await adapter.findFiles('outside'), '(no files found)');
  await assert.rejects(adapter.readNumbered('outside'), /outside the project/); await assert.rejects(adapter.readNumbered('../escape'), /outside the project/);
  assert.equal((await adapter.findFiles('*.txt')).split('\n')[0], 'f000.txt');
  assert.equal(await adapter.search('needle', 'node_modules'), '(no matches)'); assert.equal(await adapter.findFiles('[ab].txt'), 'sub/a.txt');
  assert.equal(await adapter.search('a', 'sub/a.txt'), 'sub/a.txt:1: a');
  await rm(path.join(dir, 'sub/a.txt'));
  await symlink('/tmp/myharness-never-create-this/target', path.join(dir, 'dangling'));
  assert.throws(() => adapter.pathFor('dangling/child'));
  assert.equal(await adapter.findFiles('link.txt'), '(no files found)');
  assert.equal(await adapter.readNumbered('invalid'), '   1: needle�');
  await writeFile(path.join(dir, 'newlines'), 'a\r\nb\rc\n');
  assert.equal(await adapter.readNumbered('newlines'), '   1: a\n   2: b\n   3: c');
  assert.equal((await adapter.edit('newlines', 'a\nb', 'changed')).content, 'changed\nc\n');
  assert.deepEqual(lines('a\vb\fc\x85d\u2028e\u2029'), ['a', 'b', 'c', 'd', 'e']);
});

test('catalog edge formats, project instruction cap, and absent directories', async t => {
  const dir = await root(t);
  for (const folder of ['agents', 'prompts', 'skills/plain', 'skills/unterminated', 'skills/empty', 'skills/missing']) await mkdir(path.join(dir, folder), { recursive: true });
  await writeFile(path.join(dir, 'agents/nonmd.txt'), 'ignore');
  await writeFile(path.join(dir, 'skills/plain/SKILL.md'), 'Simple body');
  await writeFile(path.join(dir, 'skills/unterminated/SKILL.md'), '---\nname: nope\nunterminated');
  await writeFile(path.join(dir, 'skills/empty/SKILL.md'), '---\nname: \nnot metadata\n---\nbody');
  const catalog = new Catalog(dir, new WorkspaceAdapter(dir));
  assert.deepEqual(catalog.agents(), {});
  assert.equal(catalog.skills().plain!.body, 'Simple body'); assert.equal(catalog.skills().empty!.description, '');
  await writeFile(path.join(dir, 'AGENTS.md'), '🙂'.repeat(10001)); assert.match(catalog.projectInstructions()![1], /truncated/);
  await rm(path.join(dir, 'AGENTS.md')); await mkdir(path.join(dir, 'AGENTS.md')); assert.equal(catalog.projectInstructions(), null);
  assert.deepEqual(new Catalog(path.join(dir, 'absent'), new WorkspaceAdapter(path.join(dir, 'absent'))).agents(), {});
});

test('session validation fields, listing failures, history title fallback and blank names', async t => {
  const dir = await root(t), store = new SessionStore(path.join(dir, 'sessions'));
  const record = store.create({ model: 'q', context_length: 10, workspace: dir });
  for (const invalid of [null, [], ...Object.keys(record).filter(key => ['format', 'version', 'id', 'name', 'model', 'context_length', 'workspace', 'memory', 'events', 'settings', 'setup', 'snapshots'].includes(key)).map(key => ({ ...record, [key]: null }))]) assert.throws(() => store.validate(invalid), /supported/);
  assert.deepEqual(await store.list(), []);
  await store.save(record); await writeFile(path.join(dir, 'sessions/skip.tmp'), '{}'); await writeFile(path.join(dir, 'sessions/malformed.json'), '{');
  assert.equal((await store.list()).length, 1);
  assert.equal(sessionSummary({ ...record, memory: [{ role: 'user', content: 'from memory' }] }).name, 'from memory');
  assert.equal(sessionSummary({ ...record, events: [{ type: 'chat_user', content: 'from event' }] }).name, 'from event');
  const harness = new NodeHarness({ workspace: dir, model: 'q', contextLength: 1000, sessions: store, ollama: model }); await harness.newSession(' ');
  await assert.rejects(harness.getSession('missing'), /not found/);
  await harness.patchSession(harness.activeSessionRecord().id, { settings: { tools: [false] } });
  await assert.rejects(store.save({ ...record, id: '../invalid' }), /Invalid session ID/);
  const firstSave = store.save({ ...record, name: 'older' });
  const lastSave = store.save({ ...record, name: 'newer' });
  await Promise.all([firstSave, lastSave]);
  assert.equal((await store.load(record.id)).name, 'newer');
});

test('empty-model, manual unknown skill, project refresh and optional-runtime boundaries', async t => {
  const dir = await root(t); await mkdir(path.join(dir, 'work'));
  const harness = new NodeHarness({ workspace: path.join(dir, 'work'), model: 'q', contextLength: 4096, projectRoot: dir, settingsFile: path.join(dir, 'settings.json'), sessions: new SessionStore(path.join(dir, 'sessions')), ollama: model });
  await collect(harness.submit({ ...action, message: '/unknown text' }));
  await harness.setProject(dir); await harness.newSession();
  const record = harness.activeSessionRecord(); record.memory = [{ role: 'user', content: 'stored' }]; record.snapshots = { prompt: { name: '', text: '' } }; record.last_prompt_tokens = undefined as unknown as number;
  await writeFile(path.join(dir, 'AGENTS.md'), 'refreshed');
  const store = new SessionStore(path.join(dir, 'sessions')); await store.save(record); await harness.activateSession(record.id);
  assert.equal(harness.activeSessionRecord().project_instructions![1], 'refreshed'); await harness.activateSession(record.id);
  const defaultModel = new NodeHarness({ workspace: dir, model: 'q', contextLength: 1000 }); assert.equal(defaultModel.model(), 'q');
  await harness.newSession(); await collect(harness.submit({ ...action, message: ' ' }));
  await mkdir(path.join(dir, 'skills/one'), { recursive: true }); await writeFile(path.join(dir, 'skills/one/SKILL.md'), 'instruction');
  await harness.reset(); await collect(harness.submit({ ...action, message: '/one' }));
  const emptySkills = new NodeHarness({ workspace: path.join(dir, 'work'), projectRoot: path.join(dir, 'work'), model: 'q', contextLength: 1000, ollama: model });
  assert.match((await emptySkills.runTool('use_skill', { name: 'absent' }, ['use_skill']) as { text: string }).text, /\(none\)/);
  await assert.rejects(new NodeHarness({ workspace: dir, model: 'q', contextLength: 1000, ollama: { streamChat: model.streamChat } }).explore(action), /does not support/);
  assert.equal((await new NodeHarness({ workspace: dir, model: 'qwen', contextLength: 1000, ollama: { ...model, async request() { return {}; } } }).explore(action)).template, '');
  assert.match(String((await emptySkills.explore({ ...action, useMemory: false })).final), /only written for Qwen/);
  const missingPrompt = harness.activeSessionRecord(); missingPrompt.setup = { prompt: 'gone', agent: 'gone' }; missingPrompt.snapshots = { prompt: { name: 'gone', text: '' }, agent: { name: 'gone', value: null } }; await store.save(missingPrompt); await harness.activateSession(missingPrompt.id); await collect(harness.submit(action));
});

test('context edge conditions, trimming skips, and Stop during compaction', async t => {
  const dir = await root(t), harness = new NodeHarness({ workspace: dir, model: 'q', contextLength: 1000, ollama: model });
  const history: ChatMessage[] = [{ role: 'user', content: 'hello' }, { role: 'tool', content: 'tiny' }, { role: 'tool', tool_name: 'read_file', content: '[output trimmed: already]' }, ...Array.from({ length: 4 }, () => ({ role: 'user' as const, content: 'large '.repeat(1000) }))];
  assert.equal(harness.trimContext([], history, []), undefined);
  const boundary: ChatMessage[] = [{ role: 'assistant', content: '' }, { role: 'tool', content: 'x' }, ...Array.from({ length: 3 }, () => ({ role: 'user' as const, content: 'tail' }))]; assert.equal(retainedBoundary(boundary), 0);
  harness.state.memory.push(...Array.from({ length: 8 }, () => ({ role: 'user' as const, content: 'old '.repeat(100) }))); harness.state.contextLength = 4096;
  const compaction = harness.compact(); await compaction.next(); const next = await compaction.next(); assert.equal(next.value!.action, 'compact_response'); harness.stop(); assert.equal((await compaction.next()).value!.action, 'error'); await compaction.return(undefined);
  const noCalls = [{ role: 'assistant' as const, content: '' }, { role: 'tool' as const, content: 'x'.repeat(4000) }, ...Array.from({ length: 4 }, () => ({ role: 'user' as const, content: 'tail' }))]; harness.state.contextLength = 1000; assert.equal(harness.trimContext([], noCalls, [])!.action, 'trim');
  const withArgs: ChatMessage[] = [{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file' } }] }, { role: 'tool', tool_name: 'read_file', content: 'x'.repeat(5000) }, { role: 'tool', tool_name: 'read_file', content: 'y'.repeat(5000) }, ...Array.from({ length: 4 }, () => ({ role: 'user' as const, content: 'tail' }))]; harness.trimContext([], withArgs, []);
});

test('headless fails clearly on startup errors and reports interrupt status', async t => {
  const output: string[] = [], dir = await root(t);
  assert.equal(await headless(['hi'], async () => { throw new Error('offline'); }, text => output.push(text)), 1);
  const interrupted = new NodeHarness({ workspace: dir, model: 'q', contextLength: 4096, ollama: model });
  assert.equal(await headless(['hello'], async () => interrupted, text => { output.push(text); if (text.startsWith('{')) process.emit('SIGINT'); }), 130);
  assert.match(output[0]!, /offline/);
  const approvalModel = { async *streamChat() { yield JSON.stringify({ message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a', content: 'ok' } } }] }, done: true }); } };
  const approvalHarness = new NodeHarness({ workspace: dir, model: 'q', contextLength: 4096, ollama: approvalModel });
  assert.equal(await headless(['hi', '--tools', 'write_file'], async () => approvalHarness, text => { if (text.includes('"type":"approval"')) process.emit('SIGINT'); }), 130);
});

test('turn failures, empty replies, and aborted command startup leave the host usable', async t => {
  const dir = await root(t);
  const failures = new NodeHarness({ workspace: dir, model: 'q', contextLength: 1000, ollama: { async *streamChat() { throw 'offline'; } } });
  assert.match(String((await collect(failures.submit(action))).at(-1)!.reason), /offline/);
  assert.match((await failures.runTool('pwd', { surprise: true }, ['pwd']) as { text: string }).text, /bad arguments/);
  const empty = new NodeHarness({ workspace: dir, model: 'q', contextLength: 1000, ollama: { async *streamChat() {} } });
  assert.match(String((await collect(empty.submit(action))).at(-1)!.reason), /empty reply/);
  // Cancellation can arrive in an adapter immediately before its rejected operation returns.
  const calls = { async *streamChat() { yield JSON.stringify({ message: { tool_calls: [{ function: { name: 'pwd' } }] }, done: true }); } };
  const cancelledTool = new NodeHarness({ workspace: dir, model: 'q', contextLength: 1000, ollama: calls });
  t.mock.method(cancelledTool, 'runTool', async () => { cancelledTool.stop(); throw new Error('cancelled'); });
  assert.equal((await collect(cancelledTool.submit({ ...action, tools: ['pwd'] }))).at(-1)!.reason, 'stopped by the user');
  let commandTurn = 0;
  const command = new NodeHarness({ workspace: dir, model: 'q', contextLength: 1000, commandTimeoutMs: 10, ollama: { async *streamChat() { yield JSON.stringify({ message: ++commandTurn === 1 ? { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'sleep 1' } } }] } : { content: 'ok' }, done: true }); } } });
  t.mock.method(process, 'kill', () => { throw new Error('process group already disappeared'); });
  assert.match(String((await collect(command.submit({ ...action, tools: ['run_command'] }))).find(event => event.type === 'command')!.status), /timed out/);
  t.mock.restoreAll();
  command.stop();
  assert.match(String((await collect(command.executeCommand('true')))[0]!.approved), /false/);
  // A Stop during synchronous process creation must also terminate the new child.
  const setTimeoutOriginal = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', ((...args: Parameters<typeof setTimeout>) => { command.stop(); return setTimeoutOriginal(...args); }) as typeof setTimeout);
  await collect(command.submit(action));
  assert.match(String((await collect(command.executeCommand('sleep 1')))[0]!.status), /stopped/);
});

test('abandoned pending approvals are denied when a turn finishes', async t => {
  const dir = await root(t), harness = new NodeHarness({ workspace: dir, model: 'q', contextLength: 1000, ollama: model });
  const pending = harness.applyChange('write_file', { path: 'pending.txt', content: 'draft' });
  const proposal = await pending.next(); assert.ok(!proposal.done); assert.equal(proposal.value.type, 'approval');
  await collect(harness.submit(action));
  const decision = await pending.next(); assert.ok(!decision.done); assert.equal(decision.value.approved, false);
  assert.match(String((await pending.next()).value), /refused/);
  assert.equal(harness.approve(String(proposal.value.id), true), false);
});

test('Qwen rendering handles missing args, empty assistants and sorted optional properties', () => {
  assert.match(renderQwenPrompt([{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'tool' } }] }], []), /arguments": \{\}/);
  assert.equal(renderQwenPrompt([{ role: 'assistant', content: '' }], []), '<|im_start|>assistant\n');
  assert.match(toolAsGoValue({ type: 'function', function: { name: 'test', description: '<&>', parameters: { type: 'object', properties: { b: { type: 'string', enum: [] }, a: { description: '<&>', anyOf: [{ type: 'null' }] } } } } }), /\\u003c/);
});

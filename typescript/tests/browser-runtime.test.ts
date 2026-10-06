import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserStorage } from '../src/browser/storage.js';
import { BrowserSessions } from '../src/browser/sessions.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { BrowserWorkspace, absolutePath, projectFromFiles } from '../src/browser/workspace.js';
import { BrowserCatalog } from '../src/browser/catalog.js';
import { DemoModel, DEMO_MODEL } from '../src/browser/demo.js';
import { BrowserModel } from '../src/browser/model.js';
import { OllamaAdapter } from '../src/ollama.js';
import type { ModelPort } from '../src/harness.js';
import type { ChatMessage, ModelRequest } from '../src/core.js';
import { TOOLS } from '../src/tools.js';

const library = { agents: { coder: 'tools: read_file,write_file,bad\n---\nExplain edits', plain: 'Plain agent' }, prompts: { teaching: 'Show the harness work.' }, skills: { basic: '---\nname: basic\ndescription: examples\n---\nRead before editing.' } };
const action = { message: 'List files', useMemory: true, tools: TOOLS.map(tool => tool.function.name), askApproval: true, agent: '', prompt: '' };
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
export async function browserFixture(t: { after(callback: () => unknown): void }, modelPort?: ModelPort) {
  const factory = new IDBFactory(), storage = await BrowserStorage.open('test', factory); t.after(() => storage.close());
  const options = { model: 'scripted-demo', storage, library, seed: { 'README.md': 'Hello\n', 'src/main.py': 'print("hello")\n' }, ...(modelPort ? { modelPort } : {}) };
  const backend = await BrowserHarness.open(options);
  return { backend, storage, options, factory };
}

test('browser backend runs without UI, preserves setup snapshots, stores sessions and persists file effects', async t => {
  const { backend, storage, options } = await browserFixture(t);
  assert.equal((await backend.bootstrap()).runtime, 'browser');
  const offered = ((await backend.bootstrap()).tools as { name: string }[]).map(tool => tool.name);
  assert.equal(offered.includes('run_command'), false); assert.equal(offered.includes('web_search'), false); assert.equal(offered.includes('git_status'), false);
  assert.deepEqual(offered, ['find_files', 'search', 'get_current_time', 'pwd', 'list_files', 'read_file', 'write_file', 'edit_file', 'delete_file', 'move_file', 'update_plan', 'use_skill']);
  assert.deepEqual(Object.keys((await backend.bootstrap()).unavailable_tools as object), ['run_command', 'web_search', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_checkout', 'git_commit']);
  assert.match((await backend.runTool('run_command', { command: 'true' }, ['run_command']) as { text: string }).text, /unsupported: 'run_command' is unavailable in the browser runtime: a browser page cannot start processes/);
  const events = await collect(backend.submit({ ...action, message: 'show instructions', agent: 'coder', prompt: 'teaching' }));
  assert.match(String(events.find(event => event.type === 'response')!.content), /Show the harness work/);
  assert.equal(backend.activeSessionRecord().settings.tools.includes('run_command'), false);
  const frozen = backend.activeSessionRecord(); library.prompts.teaching = 'Changed';
  assert.equal((await backend.explore(action)).system_prompt, 'Show the harness work.'); library.prompts.teaching = 'Show the harness work.';
  assert.equal(frozen.snapshots.agent!.name, 'coder'); assert.ok(frozen.snapshots.skills!.basic);
  for await (const event of backend.submit({ ...action, message: 'Write note.txt: hello' })) if (event.type === 'approval') await backend.approve(String(event.id), true);
  assert.equal((await backend.exportProject()).files['note.txt'], 'hello\n');
  const resumed = await BrowserHarness.open(options); assert.equal(resumed.inspect().memory.at(-1)!.role, 'assistant'); assert.equal((await resumed.exportProject()).files['note.txt'], 'hello\n');
  const exported = resumed.activeSessionRecord(), imported = await resumed.importSession(exported); assert.notEqual(imported.id, exported.id);
  await resumed.activateSession(imported.id); await resumed.patchSession(imported.id, { name: 'renamed' }); assert.equal((await resumed.getSession(imported.id)).name, 'renamed');
  await resumed.reset(); assert.equal(resumed.inspect().memory.length, 0); assert.ok(resumed.activeSessionRecord().events.length);
  await storage.put('sessions', 'corrupt', {}); assert.equal((await new BrowserSessions(storage).list()).length, 2);
});

test('browser approvals deny, time out, stop and reject conflicts independently of UI', async t => {
  const { backend, options } = await browserFixture(t);
  for await (const event of backend.submit({ ...action, message: 'Write denied.txt: no' })) if (event.type === 'approval') {
    await assert.rejects(backend.importProject({}), /running turn/); await assert.rejects(backend.configureModel({ mode: 'demo' }), /running turn/);
    backend.approve(String(event.id), false);
  }
  assert.equal((await backend.exportProject()).files['denied.txt'], undefined);
  for await (const event of backend.submit({ ...action, message: 'Write stopped.txt: no' })) if (event.type === 'approval') backend.stop();
  assert.equal((await backend.exportProject()).files['stopped.txt'], undefined);
  const timeout = await BrowserHarness.open({ ...options, approvalTimeoutMs: 1 });
  assert.equal((await collect(timeout.submit({ ...action, message: 'Write timed.txt: no' }))).find(event => event.type === 'change')!.approved, false);
  await backend.newSession(); const stream = backend.submit(action); await stream.next();
  await assert.rejects(collect(backend.submit(action)), /already running/); await stream.return(undefined);
  await assert.rejects(collect(backend.submit({ ...action, sessionId: 'stale' })), /no longer/);
});

test('virtual files enforce paths, line/output limits, searches, edits and failed persistence', async () => {
  let persisted = 0; const project = projectFromFiles('/workspace', { 'a': 'one\ntwo\n', 'empty': '', 'repeat': 'x x', 'sub/code.py': '🙂'.repeat(600), 'node_modules/x': 'needle', 'binary': '\0needle' });
  const workspace = new BrowserWorkspace(project, async () => { persisted++; });
  await workspace.refresh(); assert.equal(workspace.pathFor('/a'), '/workspace/a'); assert.equal(workspace.pathFor('/workspace/a'), '/workspace/a'); assert.throws(() => workspace.pathFor('../out'), /outside/);
  assert.throws(() => absolutePath('../out'), /leaves/); assert.throws(() => absolutePath('x\\y'), /forward/); assert.throws(() => absolutePath('\0'), /forward/);
  assert.equal(await workspace.listFiles('sub'), 'code.py'); assert.equal(await workspace.listFiles('node_modules'), 'x'); await assert.rejects(workspace.listFiles('a'), /not a folder/);
  await assert.rejects(workspace.readText('missing'), /not a project file/); assert.equal(await workspace.readNumbered('empty'), '(empty file)'); assert.match(await workspace.readNumbered('a', 3), /past the end/);
  await assert.rejects(workspace.readNumbered('a', 0), /start_line/); await assert.rejects(workspace.readNumbered('a', 2, 1), /start_line/);
  assert.equal(await workspace.readNumbered('a', 1, 1), '   1: one\n[lines 1-1 of 2; call again with start_line=2]');
  assert.equal(await workspace.search('two', 'a'), 'a:2: two'); assert.equal(await workspace.search('needle', 'node_modules'), '(no matches)'); assert.equal(await workspace.search('needle', '.', 'binary'), '(no matches)');
  assert.equal(await workspace.search('🙂', 'sub', '*.py'), 'sub/code.py:1: ' + '🙂'.repeat(500) + ' [line truncated]');
  assert.match(await workspace.search('🙂'), /line truncated/); assert.equal(await workspace.search('none'), '(no matches)'); await assert.rejects(workspace.search(''), /empty/); await assert.rejects(workspace.search('x', 'missing'), /does not exist/);
  assert.equal(await workspace.findFiles('sub/*.py'), 'sub/code.py'); assert.equal(await workspace.findFiles('*.no'), '(no files found)');
  assert.equal((await workspace.edit('a', 'one\\ntwo', 'new\\nvalue')).note?.includes('literal'), true); assert.equal((await workspace.edit('a', 'one', '$&')).content, '$&\ntwo\n');
  await assert.rejects(workspace.edit('a', '', ''), /empty/); await assert.rejects(workspace.edit('a', 'missing\\ntext', ''), /not found/); await assert.rejects(workspace.edit('repeat', 'x', ''), /2 times/);
  await workspace.writeText('nested/new.txt', 'hello'); assert.equal(await workspace.listFiles('nested'), 'new.txt'); assert.equal(persisted, 1);
  await assert.rejects(workspace.writeText('.', ''), /folder/); await assert.rejects(workspace.writeText('a/child', ''), /not a folder/);
  const empty = new BrowserWorkspace(projectFromFiles('/empty', {}), async () => {}); assert.equal(await empty.listFiles(), '(empty folder)');
  assert.throws(() => projectFromFiles('/x', { x: 1 } as unknown as Record<string, string>), /text/); assert.throws(() => projectFromFiles('/x', { '.': '' }), /name/); assert.throws(() => projectFromFiles('/x', { a: '', 'a/child': '' }), /both/);
  const failed = new BrowserWorkspace(project, async () => { throw new Error('quota'); }); await assert.rejects(failed.writeText('quota.txt', ''), /quota/); assert.equal(project.files['quota.txt'], undefined);
  project.files.huge = 'x'.repeat(12000) + '\nsecond'; assert.match(await workspace.readNumbered('huge'), /long line truncated/);
  project.files.many = ('x'.repeat(1000) + '\n').repeat(20); assert.match(await workspace.readNumbered('many'), /start_line=10/);
  project.files.matches = 'needle\n'.repeat(101); assert.match(await workspace.search('needle', 'matches'), /more matches/);
  for (let i = 0; i < 202; i++) project.files[`cap-${i}`] = ''; assert.match(await workspace.findFiles('cap-*'), /2 more/);
});

test('browser catalog preserves project overrides, plain and malformed skill formats', async () => {
  const project = projectFromFiles('/p', { 'agents/coder.md': 'tools: pwd,invalid\r\n---\r\nProject agent', 'agents/ignore.txt': 'ignored', 'skills/override/SKILL.md': '---\nname: basic\ndescription: local\n---\nLocal skill', 'skills/plain/SKILL.md': 'Plain', 'skills/bad/SKILL.md': '---\nname: wrong\nmissing delimiter', 'skills/empty/SKILL.md': '---\nname: \nno colon\n---\nbody', 'other/SKILL.md': 'ignore' });
  const catalog = new BrowserCatalog(library, new BrowserWorkspace(project, async () => {}));
  assert.equal(catalog.agents().coder!.source, 'project'); assert.deepEqual(catalog.agents().coder!.tools, ['pwd']); assert.equal(catalog.agents().plain!.prompt, 'Plain agent');
  assert.equal(catalog.skills().basic!.description, 'local'); assert.equal(catalog.skills().plain!.body, 'Plain'); assert.equal(catalog.skills().empty!.description, ''); assert.match(catalog.skills().bad!.body, /missing delimiter/);
  assert.equal(catalog.projectInstructions(), null); project.files['AGENTS.md'] = '🙂'.repeat(10001); assert.match(catalog.projectInstructions()![1], /truncated/); project.files['AGENTS.md'] = ''; assert.deepEqual(catalog.projectInstructions(), ['AGENTS.md', '']);
  assert.equal(catalog.prompts().teaching, 'Show the harness work.');
});

test('project import, browse, missing workspaces and model connection preserve browser state', async t => {
  const { backend, storage, options } = await browserFixture(t);
  for (const invalid of [null, {}, { format: 'wrong' }, { format: 'myharness-project', version: 2 }, { format: 'myharness-project', version: 1, root: 1 }, { format: 'myharness-project', version: 1, root: '/p', files: null }, { format: 'myharness-project', version: 1, root: '/p', files: [] }]) await assert.rejects(backend.importProject(invalid), /valid/);
  await assert.rejects(backend.importProject(projectFromFiles('/', {})), /project name/);
  await backend.importProject(projectFromFiles('/new', { 'a/file': 'x', 'a/deep/file': 'nested', 'agents/local.md': 'local' })); assert.equal(backend.state.workspace, '/new'); assert.deepEqual(backend.browse('/new').folders, ['a', 'agents']); assert.equal(backend.browse('/new/a').parent, '/new'); assert.equal(backend.browse('/').parent, null);
  await BrowserHarness.open(options);
  assert.deepEqual(backend.browse('/workspace').folders, ['src']); await assert.rejects(backend.setProject('/absent'), /does not exist/); assert.throws(() => backend.browse('/missing'), /not a virtual/); assert.throws(() => backend.browse('/new/a/file'), /not a virtual/);
  await storage.put('settings', 'workspace', '/gone'); await BrowserHarness.open(options);
  const record = backend.activeSessionRecord(); record.workspace = '/gone'; await new BrowserSessions(storage).save(record); await backend.activateSession(record.id); await assert.rejects(backend.exportProject(), /replacement/); await assert.rejects(collect(backend.submit(action)), /missing/); await backend.setProject('/workspace');
  for (const url of ['file:///tmp', 'http://user:pass@example.com']) await assert.rejects(backend.configureModel({ mode: 'ollama', url }), /HTTP/);
  await assert.rejects(backend.configureModel({ mode: 'other' }), /Choose MYHARNESS_PROVIDER/);
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 })); await assert.rejects(backend.configureModel({ mode: 'ollama' }), /OLLAMA_ORIGINS/);
  t.mock.restoreAll(); t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 8192 } })));
  await backend.configureModel({ mode: 'ollama', url: 'http://localhost:9999/', model: 'qwen3:8b' }); assert.equal(backend.contextLength(), 8192); assert.equal(backend.model(), 'qwen3:8b'); assert.equal((await backend.bootstrap()).ollama_url, 'http://localhost:9999');
  await BrowserHarness.open(options); await backend.configureModel({ mode: 'ollama', model: ' ' }); await backend.configureModel({ mode: 'demo' }); assert.equal(backend.model(), DEMO_MODEL);
});

test('scripted model demonstrates memory, tool availability, editing, skills, cancellation and summarization', async () => {
  const demo = new DemoModel(), messages: ChatMessage[] = [];
  const run = async (text: string, tools = TOOLS) => { const payload: ModelRequest = { model: DEMO_MODEL, stream: true, options: { num_ctx: 4096 }, tools, messages: [...messages, { role: 'user', content: text }] }; return (await collect(demo.streamChat(payload))).map(chunk => JSON.parse(chunk)); };
  for (const text of ['list files', 'read README.md', 'write a: hello', 'edit a: hello => goodbye', 'search hello', 'skill basic', 'run true']) assert.ok((await run(text)).at(-1).message.tool_calls);
  assert.match((await run('write a: hi', [])).at(-1).message.content, /SENT/);
  const disabled = await collect(demo.streamChat({ model: DEMO_MODEL, messages: [{ role: 'user', content: 'list files' }], stream: true, options: { num_ctx: 1 } })); assert.match(disabled.join(''), /unavailable/);
  assert.match((await run('remember 42')).map(chunk => chunk.message.content).join(''), /42/); messages.push({ role: 'user', content: 'Remember 42' }); assert.match((await run('What do you remember?')).map(chunk => chunk.message.content).join(''), /42/);
  messages.length = 0; assert.match((await run('what do you remember')).map(chunk => chunk.message.content).join(''), /No earlier/);
  assert.match((await run('show instructions')).map(chunk => chunk.message.content).join(''), /No system/); messages.push({ role: 'system', content: 'Rules' }); assert.match((await run('show instructions')).map(chunk => chunk.message.content).join(''), /Rules/);
  assert.match((await run('anything')).map(chunk => chunk.message.content).join(''), /scripted learning model/);
  const controller = new AbortController(); controller.abort(); assert.deepEqual(await collect(demo.streamChat({ model: DEMO_MODEL, messages: [], stream: true, options: { num_ctx: 1 } }, controller.signal)), []);
  const controller2 = new AbortController(), source = demo.streamChat({ model: DEMO_MODEL, messages: [{ role: 'user', content: 'hello' }], stream: true, options: { num_ctx: 1 } }, controller2.signal); await source.next(); controller2.abort(); assert.equal((await source.next()).done, true);
  assert.match(String((await demo.request('show', {})).template), /no LLM/); assert.ok((await demo.request('chat', { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'older conversation' }] })).message); await assert.rejects(demo.request('tags', {}), /only chat/);
  const router = new BrowserModel(new OllamaAdapter(async () => new Response(JSON.stringify({ message: { content: 'real' }, done: true }) + '\n'), 'http://fake'));
  assert.match((await collect(router.streamChat({ model: 'qwen', messages: [], stream: true, options: { num_ctx: 1 } }))).join(''), /real/); assert.ok((await router.request('show', { model: 'qwen' })).message); assert.match(String((await router.request('show', { model: DEMO_MODEL })).template), /Scripted/);
});

test('browser inspection rejects requests imported from an unsupported provider without sending them to Ollama', async t => {
  let requests = 0;
  const router = new BrowserModel(new OllamaAdapter(async () => { requests++; throw new Error('must not send'); }, 'http://fake'));
  const { backend } = await browserFixture(t, router), record = backend.activeSessionRecord();
  record.events.push({ type: 'request', provider: 'gemini-developer', parts: [JSON.stringify({ model: 'gemini-test', messages: [{ role: 'user', content: 'saved message' }], options: { num_ctx: 4096 }, stream: true })] });
  const imported = await backend.importSession(record); await backend.activateSession(imported.id);
  assert.match((await backend.tokenize(record.events.length - 1)).explanation, /another provider/);
  assert.equal(requests, 0);
});

test('project exports restore complete session transcripts independently of model memory', async t => {
  const { backend } = await browserFixture(t);
  await collect(backend.submit({ ...action, message: 'Remember original conversation', agent: 'coder', prompt: 'teaching' }));
  for (let i = 0; i < 4; i++) await collect(backend.submit({ ...action, message: `Follow up ${i}` }));
  const beforeCompact = backend.activeSessionRecord().events;
  await collect(backend.compact());
  assert.deepEqual(backend.activeSessionRecord().events.slice(0, beforeCompact.length), beforeCompact);
  assert.ok(backend.activeSessionRecord().events.some(event => event.action === 'compact'));
  const first = backend.activeSessionRecord();
  await backend.newSession('Second conversation');
  await collect(backend.submit({ ...action, message: 'Write archived.txt: original', askApproval: false }));
  await collect(backend.submit({ ...action, message: 'Without model memory', useMemory: false }));
  await backend.reset();
  const second = backend.activeSessionRecord();
  assert.equal(second.memory.length, 0);
  await backend.newSession('Other project');
  await backend.importProject(projectFromFiles('/unrelated', {}));
  await collect(backend.submit({ ...action, message: 'Other project conversation' }));
  await backend.activateSession(second.id);
  const exported = JSON.parse(JSON.stringify(await backend.exportProject()));
  assert.equal(exported.sessions.length, 2);
  assert.equal(exported.active_session_id, second.id);
  assert.deepEqual(exported.sessions.find((record: { id: string }) => record.id === first.id).events, first.events);
  assert.deepEqual(exported.sessions.find((record: { id: string }) => record.id === second.id).events, second.events);
  const storage = await BrowserStorage.open('restored', new IDBFactory()); t.after(() => storage.close());
  const options = { storage, library, seed: {}, model: DEMO_MODEL };
  const restored = await BrowserHarness.open(options);
  await restored.importProject(exported);
  assert.notEqual(restored.activeSessionRecord().id, second.id);
  assert.deepEqual(restored.activeSessionRecord().events, second.events);
  assert.deepEqual(restored.activeSessionRecord().memory, second.memory);
  assert.equal((await restored.exportProject()).files['archived.txt'], 'original\n');
  const reopened = await BrowserHarness.open(options);
  assert.deepEqual(reopened.activeSessionRecord().events, second.events);
  const importedFirst = (await reopened.listSessions()).find(record => record.name === first.name + ' (imported)')!;
  await reopened.activateSession(importedFirst.id);
  assert.deepEqual(reopened.activeSessionRecord().events, first.events);
  assert.deepEqual(reopened.activeSessionRecord().memory, first.memory);
  assert.deepEqual(reopened.activeSessionRecord().snapshots, first.snapshots);
  assert.deepEqual(reopened.activeSessionRecord().settings, first.settings);
  await reopened.importProject({ ...exported, active_session_id: undefined });
  await reopened.importProject({ ...exported, sessions: [], active_session_id: undefined });
});

test('project imports validate all sessions before changing files or active conversation', async t => {
  const { backend } = await browserFixture(t);
  const session = backend.activeSessionRecord(), exported = await backend.exportProject();
  for (const value of [
    { ...exported, sessions: {} },
    { ...exported, sessions: [session, {}] },
    { ...exported, sessions: [{ ...session, workspace: '/other' }] },
    { ...exported, sessions: [session, session] },
    { ...exported, active_session_id: 'missing' },
  ]) {
    await assert.rejects(backend.importProject(value), /session|Session/);
    assert.deepEqual(backend.activeSessionRecord(), session);
    assert.deepEqual(await backend.exportProject(), exported);
  }
  const turn = backend.submit(action); await turn.next();
  assert.deepEqual((await backend.exportProject()).sessions![0]!.events, backend.activeSessionRecord().events);
  await turn.return(undefined);
});

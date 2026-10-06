import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserHarness } from '../src/browser/harness.js';
import { fixture } from './browser-fixture.js';
import { ORCHESTRATION_TOOLS } from '../src/tools.js';
import { NodeHarness, type ModelPort, type TurnAction } from '../src/node/harness.js';
import { planItems, planText } from '../src/plan.js';
import { STOPPED_RESULT, type CoreEvent, type ModelRequest, type ToolResult } from '../src/core.js';
import { real, repository } from './git-helpers.js';

const turn = (tools: string[], overrides: Partial<TurnAction> = {}): TurnAction => ({ message: 'go', useMemory: true, tools, askApproval: true, agent: '', prompt: '', ...overrides });
const call = (name: string, args: Record<string, unknown>): unknown[] => [{ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: true }];
const answer: unknown[] = [{ message: { role: 'assistant', content: 'done' }, done: true }];
class Model implements ModelPort {
  requests: ModelRequest[] = []; turns: unknown[][] = [];
  async *streamChat(payload: ModelRequest): AsyncGenerator<string> { this.requests.push(structuredClone(payload)); for (const chunk of this.turns.shift() ?? answer) yield JSON.stringify(chunk); }
  async request(): Promise<Record<string, unknown>> { return { template: '', parameters: '' }; }
}
const lastTool = (harness: NodeHarness): string => [...harness.inspect().memory].reverse().find(message => message.role === 'tool')!.content;
/** Runs one turn, answering every approval with `decide`. */
async function run(harness: NodeHarness, model: Model, name: string, args: Record<string, unknown>, options: { decide?: (event: CoreEvent) => boolean | 'stop' | 'ignore'; action?: Partial<TurnAction> } = {}): Promise<{ events: CoreEvent[]; result: string }> {
  model.turns = [call(name, args), answer];
  const events: CoreEvent[] = [];
  for await (const event of harness.submit(turn([name], options.action))) {
    events.push(event);
    if (event.type === 'approval') { const decision = options.decide?.(event) ?? true; if (decision === 'stop') harness.stop(); else if (decision !== 'ignore') harness.approve(String(event.id), decision); }
  }
  return { events, result: lastTool(harness) };
}
async function project(t: { after(fn: () => unknown): void }, options: Record<string, unknown> = {}, root?: string) {
  const dir = root ?? await mkdtemp(path.join(tmpdir(), 'myharness-agentic-')); if (!root) t.after(() => rm(dir, { recursive: true, force: true }));
  const model = new Model(), harness = new NodeHarness({ workspace: dir, model: 'qwen3:8b', contextLength: 100_000, ollama: model, ...options });
  await harness.initialize(); t.after(() => harness.close());
  return { dir, model, harness };
}
const exists = (file: string) => access(file).then(() => true, () => false);

test('the maintained coder agent recognizes delegation tools in both runtimes and respects host permissions', async t => {
  const coder = await readFile(path.resolve('agents/coder.md'), 'utf8');
  const node = await project(t, { allowSubagents: true });
  const browserModel = new Model(), browser = await fixture(t, browserModel);
  const browserBackend = await BrowserHarness.open({ ...browser.options, allowSubagents: true,
    library: { ...browser.options.library, agents: { coder } } });
  t.after(() => browserBackend.close());
  const agentNames = ORCHESTRATION_TOOLS.map(tool => tool.function.name);
  for (const [backend, model] of [[node.harness, node.model], [browserBackend, browserModel]] as const) {
    const tools = backend.agentList().find(agent => agent.name === 'coder')!.tools as string[];
    for (const name of agentNames) assert.ok(tools.includes(name), name);
    for await (const _event of backend.submit(turn(tools, { agent: 'coder' }))) {}
    const offered = model.requests.at(-1)!.tools!.map(tool => tool.function.name);
    for (const name of agentNames) assert.ok(offered.includes(name), name);
    assert.ok(backend.activeSessionRecord().snapshots.agent!.value!.tools.includes('spawn_agent'));
    await backend.updateHarnessSettings({ allowSubagents: false });
    const restricted = backend.agentList().find(agent => agent.name === 'coder')!.tools as string[];
    assert.ok(agentNames.every(name => !restricted.includes(name)));
    for await (const _event of backend.submit(turn(tools, { agent: 'coder' }))) {}
    assert.ok(model.requests.at(-1)!.tools!.every(tool => !agentNames.includes(tool.function.name)));
  }
});
const action = (events: CoreEvent[]) => events.find(event => event.type === 'action') as CoreEvent;

test('update_plan checks the list and returns it as a checklist, with no approval and no effect', async t => {
  const { harness, model, dir } = await project(t);
  const items = [{ step: 'read the code', status: 'done' }, { step: 'edit it', status: 'in_progress' }, { step: 'run tests', status: 'pending' }];
  const { events, result } = await run(harness, model, 'update_plan', { items });
  assert.equal(result, 'Plan updated (1 of 3 done):\n[x] read the code\n[~] edit it\n[ ] run tests');
  assert.equal(events.some(event => event.type === 'approval'), false);
  assert.equal((events.find(event => event.type === 'tool') as CoreEvent).name, 'update_plan'); assert.match(String((events.find(event => event.type === 'tool') as CoreEvent).arguments), /read the code/);
  assert.deepEqual(planItems([{ step: ' trimmed ', status: 'pending' }]), [{ step: 'trimmed', status: 'pending' }]);
  for (const bad of [undefined, [], 'x', Array.from({ length: 31 }, () => items[0]), [null], [{ status: 'done' }], [{ step: ' ', status: 'done' }], [{ step: 'x'.repeat(201), status: 'done' }], [{ step: 'ok' }], [{ step: 'ok', status: 'finished' }], [{ step: 'ok', status: 3 }]])
    assert.throws(() => planText(bad), /items must be|step 1 needs/);
  assert.match((await run(harness, model, 'update_plan', {})).result, /^error: items must be a list/);
  assert.equal(await exists(path.join(dir, 'plan')), false);
});

test('delete_file shows the removal, waits for approval and deletes only after allowed-once', async t => {
  const { harness, model, dir } = await project(t);
  await writeFile(path.join(dir, 'old.txt'), 'line one\nline two\n');
  const denied = await run(harness, model, 'delete_file', { path: 'old.txt' }, { decide: () => false });
  const approval = denied.events.find(event => event.type === 'approval') as CoreEvent;
  assert.equal(approval.name, 'delete_file'); assert.match(String(approval.title), /wants to delete old\.txt/); assert.match(String(approval.detail), /^--- a\/old\.txt\n\+\+\+ \/dev\/null\n@@/); assert.match(String(approval.detail), /-line one/);
  assert.equal(await exists(path.join(dir, 'old.txt')), true); assert.match(denied.result, /^refused: the user did not approve this file deletion/);
  assert.deepEqual([action(denied.events).approved, action(denied.events).outcome, action(denied.events).result], [false, 'rejected', '']);
  const allowed = await run(harness, model, 'delete_file', { path: 'old.txt' });
  assert.equal(await exists(path.join(dir, 'old.txt')), false); assert.equal(allowed.result, "ok: deleted 'old.txt'");
  assert.deepEqual([action(allowed.events).approved, action(allowed.events).outcome, action(allowed.events).result], [true, 'allowed-once', "ok: deleted 'old.txt'"]);
});

test('delete_file and move_file: nobody answered, Stop, approvals off, races, and bad requests', async t => {
  const { harness, model, dir } = await project(t, { approvalTimeoutMs: 20 });
  await writeFile(path.join(dir, 'f.txt'), 'x\n'); await writeFile(path.join(dir, 'empty.txt'), ''); await writeFile(path.join(dir, 'bin.dat'), new Uint8Array([255, 0, 254])); await mkdir(path.join(dir, 'folder'));
  assert.match((await run(harness, model, 'delete_file', { path: 'f.txt' }, { decide: () => 'ignore' })).result, /^unavailable: nobody answered/);
  assert.match((await run(harness, model, 'move_file', { from: 'f.txt', to: 'g.txt' }, { decide: () => 'ignore' })).result, /^unavailable: nobody answered the approval request, so this file move did not run/);
  const stopped = await run(harness, model, 'delete_file', { path: 'f.txt' }, { decide: () => 'stop' });
  assert.match(stopped.result, /^stopped:/); assert.equal(await exists(path.join(dir, 'f.txt')), true);
  const unasked = await run(harness, model, 'move_file', { from: 'f.txt', to: 'deep/er/g.txt' }, { action: { askApproval: false } });
  assert.equal(unasked.events.some(event => event.type === 'approval'), false); assert.equal(await readFile(path.join(dir, 'deep/er/g.txt'), 'utf8'), 'x\n'); assert.equal(unasked.result, "ok: moved 'f.txt' to 'deep/er/g.txt'");
  assert.match(String(((await run(harness, model, 'delete_file', { path: 'empty.txt' }, { decide: () => false })).events.find(event => event.type === 'approval') as CoreEvent).detail), /^empty\.txt \(an empty file\)$/);
  assert.match(String(((await run(harness, model, 'delete_file', { path: 'bin.dat' }, { decide: () => false })).events.find(event => event.type === 'approval') as CoreEvent).detail), /binary or unreadable file/);
  for (const [name, args, message] of [
    ['delete_file', { path: 'missing.txt' }, /does not exist/], ['delete_file', { path: 'folder' }, /is a folder; delete_file deletes one file/], ['delete_file', { path: '../outside.txt' }, /outside the project folder/], ['delete_file', {}, /bad arguments for 'path'/],
    ['move_file', { from: 'missing.txt', to: 'x' }, /does not exist/], ['move_file', { from: 'folder', to: 'x' }, /is a folder; move_file moves one file/], ['move_file', { from: 'bin.dat', to: 'bin.dat' }, /same as the source/],
    ['move_file', { from: 'bin.dat', to: 'deep/er/g.txt' }, /already exists/], ['move_file', { from: 'bin.dat', to: '../out' }, /outside the project folder/], ['move_file', { from: 'bin.dat' }, /bad arguments for 'to'/],
  ] as [string, Record<string, unknown>, RegExp][]) assert.match((await run(harness, model, name, args)).result, new RegExp(`^error: .*${message.source}`));
  assert.equal(await exists(path.join(dir, 'bin.dat')), true);
});

test('a failing approved action is reported to the model as an error result', async t => {
  const { harness, model, dir } = await project(t);
  await writeFile(path.join(dir, 'gone.txt'), 'x\n');
  model.turns = [call('delete_file', { path: 'gone.txt' }), answer];
  const events: CoreEvent[] = [];
  for await (const event of harness.submit(turn(['delete_file']))) { events.push(event); if (event.type === 'approval') { await rm(path.join(dir, 'gone.txt')); harness.approve(String(event.id), true); } }
  assert.match(action(events).result as string, /^error: ENOENT/); assert.equal(action(events).approved, true); assert.match(lastTool(harness), /^error: ENOENT/);
});

test('git tools: read-only ones answer directly; branch, checkout and commit show a preview and wait for approval', async t => {
  const dir = await repository(t); real(dir, 'config', 'user.name', 'T'); real(dir, 'config', 'user.email', 't@t');
  const { harness, model } = await project(t, {}, dir);
  assert.deepEqual(Object.keys(((await harness.bootstrap()).unavailable_tools) as object), []);
  assert.match((await run(harness, model, 'git_status', {})).result, /^On branch main\nNothing to commit/);
  await writeFile(path.join(dir, 'a.txt'), 'two\n'); await writeFile(path.join(dir, 'new.txt'), 'brand new\n');
  const status = (await run(harness, model, 'git_status', {})).result; assert.match(status, /^On branch main\n M a\.txt\n\?\? new\.txt\n\(left column/);
  assert.match((await run(harness, model, 'git_diff', {})).result, /\+two/); assert.equal((await run(harness, model, 'git_diff', { staged: true })).result, '(no differences)');
  assert.match((await run(harness, model, 'git_diff', { path: 'a.txt' })).result, /\+two/); assert.match((await run(harness, model, 'git_diff', { path: '.' })).result, /\+two/);
  assert.match((await run(harness, model, 'git_diff', { staged: 'yes' })).result, /^error: bad arguments for 'staged'/); assert.match((await run(harness, model, 'git_diff', { path: '../x' })).result, /outside the project folder/);
  assert.match((await run(harness, model, 'git_log', {})).result, /^[0-9a-f]{7} \d{4}-\d\d-\d\d Tester: first$/); assert.match((await run(harness, model, 'git_log', { limit: 500, path: 'a.txt' })).result, /first/);
  assert.match((await run(harness, model, 'git_log', { limit: 'many' })).result, /^error: bad arguments for 'limit'/);
  assert.equal((await run(harness, model, 'git_branch', {})).result, '* main');

  // branch creation
  const made = await run(harness, model, 'git_branch', { name: 'topic' }, { decide: () => false });
  assert.match(String((made.events.find(event => event.type === 'approval') as CoreEvent).title), /wants to create the branch topic/); assert.equal(real(dir, 'branch', '--list', 'topic').trim(), '');
  assert.equal((await run(harness, model, 'git_branch', { name: 'topic' })).result, "ok: created branch 'topic'"); assert.equal(real(dir, 'branch', '--list', 'topic').trim(), 'topic');
  assert.match((await run(harness, model, 'git_branch', { name: '--force' })).result, /not a valid branch name/); assert.match((await run(harness, model, 'git_branch', { name: 'topic' })).result, /^error: .*already exists/);
  // checkout shows uncommitted work, refuses unknown branches, and git refuses to overwrite
  const switching = await run(harness, model, 'git_checkout', { branch: 'topic' }, { decide: () => false });
  const preview = String((switching.events.find(event => event.type === 'approval') as CoreEvent).detail); assert.match(preview, /^Switch from main to topic\./); assert.match(preview, / M a\.txt/);
  assert.equal(real(dir, 'branch', '--show-current').trim(), 'main'); assert.match((await run(harness, model, 'git_checkout', { branch: 'nope' })).result, /^error: there is no branch 'nope'\. Branches: main, topic/);
  assert.equal((await run(harness, model, 'git_checkout', { branch: 'topic' })).result, "ok: switched to branch 'topic'"); assert.equal(real(dir, 'branch', '--show-current').trim(), 'topic');
  // commit: preview first, nothing changes until approved
  assert.match((await run(harness, model, 'git_commit', { message: '  ' })).result, /^error: the commit message is empty/); assert.match((await run(harness, model, 'git_commit', { message: 'm', paths: 'a.txt' })).result, /^error: bad arguments for 'paths'/);
  assert.match((await run(harness, model, 'git_commit', { message: 'm', paths: [1] })).result, /^error: bad arguments for 'paths'/); assert.match((await run(harness, model, 'git_commit', { message: 'm', paths: ['nowhere'] })).result, /^error: nothing to commit: there are no changes in those paths/);
  const refused = await run(harness, model, 'git_commit', { message: 'change a', paths: ['a.txt'] }, { decide: () => false });
  const commitApproval = refused.events.find(event => event.type === 'approval') as CoreEvent;
  assert.match(String(commitApproval.title), /wants to commit on topic/); assert.match(String(commitApproval.detail), /^Message: change a\n\nFiles that will be in this commit/); assert.match(String(commitApproval.detail), /\+two/); assert.equal(String(commitApproval.detail).includes('new.txt'), false);
  assert.equal(real(dir, 'log', '--format=%s').trim(), 'first'); assert.match(refused.result, /^refused:/);
  assert.match((await run(harness, model, 'git_commit', { message: 'change a', paths: ['a.txt'] })).result, /^ok: committed [0-9a-f]{7,} change a$/);
  assert.equal(real(dir, 'log', '-1', '--format=%s').trim(), 'change a'); assert.equal(real(dir, 'status', '--porcelain').trim(), '?? new.txt');
  assert.match((await run(harness, model, 'git_commit', { message: 'everything' })).result, /^ok: committed/); assert.equal(real(dir, 'status', '--porcelain'), '');
  assert.match((await run(harness, model, 'git_commit', { message: 'nothing' })).result, /^error: nothing to commit: there are no changes$/);
  real(dir, 'checkout', '-q', 'main'); await writeFile(path.join(dir, 'a.txt'), 'dirty\n');
  assert.match((await run(harness, model, 'git_checkout', { branch: 'topic' })).result, /^error: [\s\S]*would be overwritten by checkout/); assert.equal(real(dir, 'branch', '--show-current').trim(), 'main');
  real(dir, 'checkout', '-q', '--detach');
  assert.match(String((await run(harness, model, 'git_commit', { message: 'detached' }, { decide: () => false })).events.find(event => event.type === 'approval')!.title), /wants to commit on \(detached HEAD\)/);
  assert.match(String((await run(harness, model, 'git_checkout', { branch: 'main' }, { decide: () => false })).events.find(event => event.type === 'approval')!.detail), /^Switch from \(detached HEAD\) to main/);
});

test('git tools are not offered or run when the runtime has no git for the folder, and say why', async t => {
  const { harness, model } = await project(t);
  const options = (harness as unknown as { options: { runtime: { git?: unknown; unavailable?: Record<string, string>; supportedTools: string[] } } }).options.runtime;
  options.git = () => undefined; options.unavailable = { git_log: 'no repository here' };
  const boot = await harness.bootstrap(), offered = (boot.tools as { name: string }[]).map(tool => tool.name);
  assert.equal(offered.some(name => name.startsWith('git_')), false); assert.equal(offered.includes('delete_file'), true);
  assert.deepEqual(boot.unavailable_tools, { git_status: 'not available in this runtime', git_diff: 'not available in this runtime', git_log: 'no repository here', git_branch: 'not available in this runtime', git_checkout: 'not available in this runtime', git_commit: 'not available in this runtime' });
  assert.equal((await run(harness, model, 'git_log', {})).result, "error: unknown tool 'git_log'");
  const direct = async (name: string) => (await harness.runTool(name, {}, [name]) as { text: string }).text;
  assert.equal(await direct('git_log'), "unsupported: 'git_log' is unavailable in the Node runtime: no repository here"); assert.equal(await direct('git_status'), "unsupported: 'git_status' is unavailable in the Node runtime");
  assert.equal((await harness.explore(turn(['git_status', 'delete_file']))).tools, JSON.stringify([(await import('../src/tools.js')).TOOLS.find(tool => tool.function.name === 'delete_file')], null, 2));
  const settings = harness.activeSessionRecord().settings.tools; assert.equal(settings.includes('git_log'), false);
});

test('agent tool lists only name tools that are available', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-agents-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'agents')); await mkdir(path.join(root, '.git')); await writeFile(path.join(root, 'agents/dev.md'), 'tools: pwd, git_status, run_command\n---\nBe careful.\n');
  const { harness } = await project(t, { projectRoot: root }, root);
  const options = (harness as unknown as { options: { runtime: { git?: unknown } } }).options.runtime;
  assert.deepEqual(harness.agentList().find(agent => agent.name === 'dev')!.tools, ['pwd', 'git_status', 'run_command']);
  options.git = () => undefined; assert.deepEqual(harness.agentList().find(agent => agent.name === 'dev')!.tools, ['pwd', 'run_command']);
});

test('Stop during an approved action reports the stop, not the action, and a repository without branches says so', async t => {
  const { harness, dir } = await project(t); await writeFile(path.join(dir, 'a.txt'), 'a\n');
  const prepared = await harness.runTool('move_file', { from: 'a.txt', to: 'b.txt' }, ['move_file']) as Extract<ToolResult, { kind: 'action' }>;
  (harness as unknown as { workspace: { move: () => Promise<void> } }).workspace.move = async () => { harness.stop(); };
  const generator = harness.executeAction(prepared.action); let next = await generator.next();
  for (; !next.done; next = await generator.next()) if (next.value.type === 'approval') harness.approve(String(next.value.id), true);
  assert.equal(next.value, STOPPED_RESULT);
  const unborn = await repository(t, false), fresh = await project(t, {}, unborn);
  assert.match((await run(fresh.harness, fresh.model, 'git_checkout', { branch: 'main' })).result, /^error: there is no branch 'main'\. Branches: \(none\)$/);
});

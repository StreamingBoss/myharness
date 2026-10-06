import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BrowserHarness } from '../src/browser/harness.js';
import { LocalWorkspace } from '../src/browser/local.js';
import { BrowserWorkspace } from '../src/browser/workspace.js';
import { WorkspaceAdapter } from '../src/node/workspace.js';
import { projectFromFiles } from '../src/browser/workspace.js';
import type { CoreEvent, ToolResult } from '../src/core.js';
import { fixture } from './browser-fixture.js';
import { DiskDirectory, DiskFile, NodeDirectory } from './disk-handle.js';
import { real, repository } from './git-helpers.js';

/** Runs one tool call on the backend alone: the prepared action is shown, answered and run, with no model or UI. */
async function act(backend: BrowserHarness, name: string, args: Record<string, unknown>, approve = true, between?: () => void): Promise<{ text: string; events: CoreEvent[] }> {
  const result = await backend.runTool(name, args, [name]) as ToolResult;
  if (result.kind === 'text') return { text: result.text, events: [] };
  assert.equal(result.kind, 'action'); between?.();
  const events: CoreEvent[] = [], generator = backend.executeAction(result.action);
  for (let next = await generator.next(); ; next = await generator.next()) {
    if (next.done) return { text: next.value, events };
    events.push(next.value); if (next.value.type === 'approval') backend.approve(String(next.value.id), approve);
  }
}
async function attach(t: { after(fn: () => unknown): void; mock: { method: (...args: never[]) => unknown } }, handle: DiskDirectory | NodeDirectory) {
  const { backend, storage } = await fixture(t);
  // Fake handles have methods, unlike browser-native handles, so keep them out of the fake IndexedDB.
  const put = storage.put.bind(storage); (t.mock as { method: Function }).method(storage, 'put', async (store: string, key: string, value: unknown) => { if (store === 'projects' && (value as { handle?: unknown }).handle) return; return put(store, key, value); });
  await backend.attachLocalFolder(handle);
  return backend;
}
const file = async (disk: DiskDirectory, ...parts: string[]): Promise<DiskFile | undefined> => { let dir = disk; for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part); return dir.getFileHandle(parts.at(-1)!).catch(() => undefined); };

test('virtual workspace: delete_file and move_file persist, and refuse bad targets', async t => {
  const { backend } = await fixture(t);
  assert.match((await act(backend, 'delete_file', { path: 'README.md' }, false)).text, /^refused:/); assert.ok((await backend.exportProject()).files['README.md']);
  const deleted = await act(backend, 'delete_file', { path: 'README.md' });
  assert.equal(deleted.text, "ok: deleted 'README.md'"); assert.equal((deleted.events[0] as CoreEvent).type, 'approval'); assert.equal((await backend.exportProject()).files['README.md'], undefined);
  assert.equal((await act(backend, 'move_file', { from: 'src/main.py', to: 'lib/deep/main.py' })).text, "ok: moved 'src/main.py' to 'lib/deep/main.py'");
  const files = (await backend.exportProject()).files; assert.equal(files['lib/deep/main.py'], 'print("hello")\n'); assert.equal(files['src/main.py'], undefined);
  assert.match((await act(backend, 'git_status', {})).text, /^unsupported: 'git_status' is unavailable in the browser runtime: git tools need a repository: open a local folder/);
  const workspace = new BrowserWorkspace(projectFromFiles('/p', { 'a.txt': 'a', 'b.txt': 'b' }), async () => undefined);
  await assert.rejects(workspace.remove('/p/missing.txt'), /is not a project file/); await assert.rejects(workspace.remove('/p'), /is not a project file/);
  await assert.rejects(workspace.move('/p/missing', '/p/x'), /is not a project file/); await assert.rejects(workspace.move('/p/a.txt', '/p/b.txt'), /already exists/);
  await assert.rejects(workspace.move('/p/a.txt', '/p/b.txt/inside'), /'b.txt' is a file, not a folder/);
  await workspace.move('/p/a.txt', '/p/new/place.txt'); assert.deepEqual(workspace.project.directories.includes('new'), true); assert.equal(workspace.project.files['new/place.txt'], 'a');
});

test('local folder: files are deleted and moved on disk, bytes survive, and outside changes are noticed', async t => {
  const disk = new DiskDirectory('code'); const main = disk.add('main.py', 'old\n'); disk.add('keep.txt', 'k\n'); disk.add('taken.txt', 'taken\n');
  const picture = disk.add('pic.bin', ''); picture.bytes = new Uint8Array([0, 255, 128, 7]); await disk.getDirectoryHandle('adir', { create: true });
  const backend = await attach(t, disk);
  assert.deepEqual(Object.keys((await backend.bootstrap()).unavailable_tools as object), ['run_command', 'web_search', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_checkout', 'git_commit']);
  assert.match(((await backend.bootstrap()).unavailable_tools as Record<string, string>).git_status!, /open a local folder that contains a \.git directory/);
  assert.match((await act(backend, 'delete_file', { path: 'main.py' }, false)).text, /^refused:/); assert.ok(await file(disk, 'main.py'));
  // The file changes between the preview and the approval: the approved delete stops.
  const stale = await act(backend, 'delete_file', { path: 'main.py' }, true, () => { main.bytes = new TextEncoder().encode('changed outside\n'); });
  assert.match(stale.text, /^error: 'main\.py' changed on disk after it was read\. Read it again before deleting it\./); assert.ok(await file(disk, 'main.py'));
  assert.equal((await act(backend, 'delete_file', { path: 'main.py' })).text, "ok: deleted 'main.py'"); assert.equal(await file(disk, 'main.py'), undefined);
  // Move: raw bytes, new nested folders, and the same checks.
  assert.equal((await act(backend, 'move_file', { from: 'pic.bin', to: 'assets/img/pic.bin' })).text, "ok: moved 'pic.bin' to 'assets/img/pic.bin'");
  assert.deepEqual([...(await file(disk, 'assets', 'img', 'pic.bin'))!.bytes], [0, 255, 128, 7]); assert.equal(await file(disk, 'pic.bin'), undefined);
  assert.equal((await act(backend, 'move_file', { from: 'keep.txt', to: 'again/kept.txt' })).text, "ok: moved 'keep.txt' to 'again/kept.txt'");
  const workspace = new LocalWorkspace(projectFromFiles('/local-code', {}), disk); await workspace.refresh();
  await assert.rejects(workspace.move('/local-code/taken.txt', '/local-code/again/kept.txt'), /already exists/); await assert.rejects(workspace.move('/local-code/taken.txt', '/local-code/adir'), /already exists/);
  disk.writePermission = 'denied'; await assert.rejects(workspace.remove('/local-code/taken.txt'), /Write permission/); await assert.rejects(workspace.move('/local-code/taken.txt', '/local-code/x'), /Write permission/); disk.writePermission = 'granted';
  await workspace.readText('/local-code/taken.txt'); (await file(disk, 'taken.txt'))!.bytes = new TextEncoder().encode('moved under it\n');
  await assert.rejects(workspace.move('/local-code/taken.txt', '/local-code/elsewhere.txt'), /'taken\.txt' changed on disk after it was read\. Read it again before moving it\./);
  await workspace.readText('/local-code/taken.txt');
  await workspace.move('/local-code/taken.txt', '/local-code/taken-and-moved.txt'); assert.equal((await file(disk, 'taken-and-moved.txt'))!.text(), 'moved under it\n');
  const unseen = new LocalWorkspace(projectFromFiles('/local-code', {}), disk); await unseen.move('/local-code/taken-and-moved.txt', '/local-code/unseen/moved-again.txt'); // never refreshed: not in its file list
  assert.equal((await file(disk, 'unseen', 'moved-again.txt'))!.text(), 'moved under it\n');
  // A target that cannot be written is cleaned up, and the original stays.
  const failing = new DiskDirectory('f'); failing.add('src.txt', 's'); const original = failing.getFileHandle.bind(failing);
  failing.getFileHandle = async (name: string, options?: { create: boolean }) => { const handle = await original(name, options); if (name === 'dst.txt') handle.failed = true; return handle; };
  const broken = new LocalWorkspace(projectFromFiles('/local-f', {}), failing); await broken.refresh();
  await assert.rejects(broken.move('/local-f/src.txt', '/local-f/dst.txt'), /disk full/); assert.ok(await file(failing, 'src.txt')); assert.equal(await file(failing, 'dst.txt'), undefined);
  const odd = new DiskDirectory('o'); odd.add('src.txt', 's'); odd.getFileHandle = async (name: string, options?: { create: boolean }) => { if (name === 'dst.txt' && !options) throw new Error('disk offline'); return DiskDirectory.prototype.getFileHandle.call(odd, name, options); };
  await assert.rejects(new LocalWorkspace(projectFromFiles('/local-o', {}), odd).move('/local-o/src.txt', '/local-o/dst.txt'), /disk offline/);
});

test('local folder with a real repository: the browser git tools read and commit it, and real git agrees', async t => {
  const dir = await repository(t); real(dir, 'config', 'user.name', 'Browser Tester'); real(dir, 'config', 'user.email', 'b@example.org');
  const backend = await attach(t, new NodeDirectory('repo', dir));
  assert.deepEqual(Object.keys((await backend.bootstrap()).unavailable_tools as object), ['run_command', 'web_search']);
  assert.match((await act(backend, 'git_status', {})).text, /^On branch main\nNothing to commit/);
  await writeFile(path.join(dir, 'a.txt'), 'two\n'); await writeFile(path.join(dir, 'new.txt'), 'new\n');
  assert.match((await act(backend, 'git_status', {})).text, / M a\.txt\n\?\? new\.txt/); assert.match((await act(backend, 'git_diff', {})).text, /-one\n\+two/);
  const commit = await act(backend, 'git_commit', { message: 'from the browser' }, false);
  assert.match(String(commit.events[0]!.detail), /^Message: from the browser\n\nFiles that will be in this commit[\s\S]*\+two[\s\S]*\+new/); assert.equal(real(dir, 'log', '--format=%s').trim(), 'first');
  assert.match((await act(backend, 'git_commit', { message: 'from the browser' })).text, /^ok: committed [0-9a-f]{7} from the browser$/);
  assert.equal(real(dir, 'log', '-1', '--format=%an|%s').trim(), 'Browser Tester|from the browser'); assert.equal(real(dir, 'status', '--porcelain'), ''); assert.equal(real(dir, 'fsck', '--strict').trim(), '');
  assert.match((await act(backend, 'git_log', { limit: 2 })).text, /from the browser\n.* first$/);
  assert.equal((await act(backend, 'git_branch', { name: 'feature' })).text, "ok: created branch 'feature'"); assert.equal((await act(backend, 'git_checkout', { branch: 'feature' })).text, "ok: switched to branch 'feature'");
  assert.equal(real(dir, 'branch', '--show-current').trim(), 'feature');
  // Files too: deleting and moving act on the real folder.
  await backend.explore({ useMemory: false, tools: [], agent: '', prompt: '' }); // each real turn refreshes the folder listing first
  assert.equal((await act(backend, 'move_file', { from: 'a.txt', to: 'docs/a.txt' })).text, "ok: moved 'a.txt' to 'docs/a.txt'"); assert.equal(await readFile(path.join(dir, 'docs/a.txt'), 'utf8'), 'two\n');
  assert.equal((await act(backend, 'delete_file', { path: 'new.txt' })).text, "ok: deleted 'new.txt'");
  assert.match((await act(backend, 'git_status', {})).text, /^On branch feature\n D new\.txt\n D a\.txt|^On branch feature\n D a\.txt\n D new\.txt|a\.txt/);
  assert.equal(real(dir, 'status', '--porcelain').split('\n').filter(Boolean).length >= 2, true);
});

test('git tools are offered only for a folder with a .git directory, and a vanished repository is reported', async t => {
  const bare = await mkdtemp(path.join(tmpdir(), 'myharness-bare-')); t.after(() => rm(bare, { recursive: true, force: true }));
  const barely = await attach(t, new NodeDirectory('bare', bare));
  assert.equal(((await barely.bootstrap()).tools as { name: string }[]).some(tool => tool.name.startsWith('git_')), false);
  assert.match((await act(barely, 'git_status', {})).text, /^unsupported: 'git_status' is unavailable in the browser runtime: git tools need a repository/);
  // The repository disappears after the folder was opened: the next call says so instead of failing obscurely.
  const dir = await repository(t), backend = await attach(t, new NodeDirectory('repo', dir));
  await rm(path.join(dir, '.git'), { recursive: true });
  for (const [name, args] of [['git_status', {}], ['git_log', {}], ['git_branch', {}], ['git_branch', { name: 'x' }], ['git_checkout', { branch: 'main' }]] as [string, Record<string, unknown>][])
    assert.match((await act(backend, name, args)).text, /^error: not a git repository: the project folder has no \.git directory/);
});

test('Node workspace: remove and move refuse an existing target even when asked directly', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-nw-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'a'); await writeFile(path.join(root, 'b.txt'), 'b');
  const workspace = new WorkspaceAdapter(root);
  await assert.rejects(workspace.move(path.join(root, 'a.txt'), path.join(root, 'b.txt')), /'b\.txt' already exists/);
  await workspace.move(path.join(root, 'a.txt'), path.join(root, 'x/y/c.txt')); assert.equal(await readFile(path.join(root, 'x/y/c.txt'), 'utf8'), 'a');
  await workspace.remove(path.join(root, 'b.txt')); await assert.rejects(workspace.remove(path.join(root, 'b.txt')), /ENOENT/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalWorkspace, type LocalDirectory } from '../src/browser/local.js';
import { DiskDirectory } from './disk-handle.js';
import { projectFromFiles } from '../src/browser/workspace.js';
import { action, collect, fixture } from './browser-fixture.js';
import type { RuntimePort } from '../src/runtime.js';
import '../src/runtime.js';

test('local workspace reads real handles, refreshes catalogs, skips binary files and writes with conflict checks', async () => {
  const disk = new DiskDirectory('code'), main = disk.add('main.py', 'old\r\nline\r'); disk.add('AGENTS.md', 'Read first');
  disk.add('__proto__', 'reserved filename');
  const agents = await disk.getDirectoryHandle('agents', { create: true }); agents.add('coder.md', 'Project rules');
  const skills = await disk.getDirectoryHandle('skills', { create: true }); (await skills.getDirectoryHandle('basic', { create: true })).add('SKILL.md', 'Skill');
  const skip = await disk.getDirectoryHandle('node_modules', { create: true }); skip.add('ignored', 'old');
  const binary = disk.add('binary', ''); binary.bytes = new Uint8Array([255]); const huge = disk.add('huge', ''); huge.oversized = true;
  const workspace = new LocalWorkspace(projectFromFiles('/local-code', {}), disk); await workspace.refresh();
  assert.equal(workspace.project.files['agents/coder.md'], 'Project rules'); assert.equal(workspace.project.files['skills/basic/SKILL.md'], 'Skill'); assert.ok(workspace.isDirectory('node_modules')); assert.equal(workspace.project.files['node_modules/ignored'], undefined);
  assert.ok(workspace.exists('__proto__')); assert.equal(await workspace.readText('__proto__'), 'reserved filename');
  assert.equal(await workspace.readText('main.py'), 'old\nline\n'); assert.equal(await workspace.search('old'), 'main.py:1: old');
  await assert.rejects(workspace.readText('huge'), /10 MiB/); await assert.rejects(workspace.readText('binary'), /encoded/);
  main.bytes = new TextEncoder().encode('external'); await assert.rejects(workspace.writeText('main.py', 'lost'), /changed on disk/); assert.equal(main.text(), 'external');
  await workspace.readText('main.py'); await workspace.writeText('main.py', 'approved'); assert.equal(main.text(), 'approved');
  await workspace.writeText('new/sub/file.py', 'new'); assert.equal((await (await (await disk.getDirectoryHandle('new')).getDirectoryHandle('sub')).getFileHandle('file.py')).text(), 'new');
  await workspace.writeText('new/sub/next.py', 'next');
  disk.writePermission = 'denied'; await assert.rejects(workspace.writeText('no', ''), /Write permission/); disk.writePermission = 'granted';
  main.failed = true; await assert.rejects(workspace.writeText('main.py', 'failed'), /disk full/); assert.ok(main.aborted); assert.equal(main.text(), 'approved'); main.failed = false;
  await assert.rejects(workspace.writeText('binary', ''), /encoded/);
  disk.permission = 'denied'; await assert.rejects(workspace.refresh(), /Open the local folder/); disk.permission = 'granted';
  await workspace.refresh(); disk.children.delete('main.py'); await assert.rejects(workspace.writeText('main.py', 'lost'), /changed/);
  disk.add('unexpected.py', 'external'); await assert.rejects(workspace.writeText('unexpected.py', 'lost'), /changed/);
});

test('local folder harness approval controls disk writes and exports file contents, without UI', async t => {
  const { backend, storage } = await fixture(t), disk = new DiskDirectory('code'), main = disk.add('main.py', 'old\n');
  // Fake handles have methods, unlike browser-native handles, so use a storage adapter for this test.
  const put = storage.put.bind(storage); t.mock.method(storage, 'put', async (store: string, key: string, value: unknown) => {
    if (store === 'projects' && (value as { handle?: unknown }).handle) return;
    return put(store, key, value);
  });
  disk.writePermission = 'denied'; await assert.rejects(backend.attachLocalFolder(disk), /grant/); disk.writePermission = 'granted';
  await assert.rejects(backend.attachLocalFolder({ kind: 'file' } as unknown as LocalDirectory), /directory/);
  await backend.attachLocalFolder(disk); assert.match(String((await backend.bootstrap()).workspace_kind), /direct disk/);
  for await (const event of backend.submit({ ...action, message: 'Edit main.py: old => denied' })) if (event.type === 'approval') backend.approve(String(event.id), false);
  assert.equal(main.text(), 'old\n');
  for await (const event of backend.submit({ ...action, message: 'Edit main.py: old => new' })) if (event.type === 'approval') backend.approve(String(event.id), true);
  assert.equal(main.text(), 'new\n'); assert.equal((await backend.exportProject()).files['main.py'], 'new\n');
  assert.equal(Object.hasOwn(await backend.exportProject(), 'handle'), false);
  await collect(backend.submit({ ...action, message: 'Write auto.py: yes', askApproval: false })); assert.equal((await disk.getFileHandle('auto.py')).text(), 'yes\n');
  const runtime = (backend as unknown as { options: { runtime: RuntimePort } }).options.runtime;
  await assert.rejects(runtime.executeCommand('true', '/local-code', new AbortController().signal), /Bash commands/);
});

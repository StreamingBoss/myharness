import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalWorkspace, type LocalDirectory, type LocalFile } from '../src/browser/local.js';
import { projectFromFiles } from '../src/browser/workspace.js';
import { action, collect, fixture } from './browser-fixture.js';
import type { RuntimePort } from '../src/runtime.js';
import '../src/runtime.js';

export class DiskFile implements LocalFile {
  readonly kind = 'file'; bytes: Uint8Array; failed = false; aborted = false; oversized = false;
  constructor(readonly name: string, text = '') { this.bytes = new TextEncoder().encode(text); }
  async getFile() { return { size: this.oversized ? 10485761 : this.bytes.length, arrayBuffer: async () => this.bytes.slice().buffer as ArrayBuffer }; }
  async createWritable() {
    let staged = '';
    return { write: async (text: string) => { if (this.failed) throw new Error('disk full'); staged = text; }, close: async () => { this.bytes = new TextEncoder().encode(staged); }, abort: async () => { this.aborted = true; } };
  }
  text(): string { return new TextDecoder().decode(this.bytes); }
}
export class DiskDirectory implements LocalDirectory {
  readonly kind = 'directory'; permission = 'granted'; writePermission = 'granted'; children = new Map<string, DiskDirectory | DiskFile>();
  constructor(readonly name: string) {}
  async *entries(): AsyncIterable<[string, DiskDirectory | DiskFile]> { yield* this.children.entries(); }
  async queryPermission(options: { mode: 'read' | 'readwrite' }) { return options.mode === 'read' ? this.permission : this.writePermission; }
  async getDirectoryHandle(name: string, options?: { create: boolean }): Promise<DiskDirectory> {
    if (!this.children.has(name) && options?.create) this.children.set(name, new DiskDirectory(name));
    const entry = this.children.get(name); if (!entry) throw new DOMException('missing', 'NotFoundError'); if (entry.kind !== 'directory') throw new Error('not directory'); return entry;
  }
  async getFileHandle(name: string, options?: { create: boolean }): Promise<DiskFile> {
    if (!this.children.has(name) && options?.create) this.children.set(name, new DiskFile(name));
    const entry = this.children.get(name); if (!entry) throw new DOMException('missing', 'NotFoundError'); if (entry.kind !== 'file') throw new Error('not file'); return entry;
  }
  add(name: string, text: string) { const file = new DiskFile(name, text); this.children.set(name, file); return file; }
}

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

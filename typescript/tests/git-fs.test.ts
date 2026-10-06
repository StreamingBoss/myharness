import assert from 'node:assert/strict';
import test from 'node:test';
import { gitFs } from '../src/browser/git-fs.js';
import { DiskDirectory } from './disk-handle.js';

const code = (promise: Promise<unknown>): Promise<string> => promise.then(() => 'resolved', (error: { code?: string }) => error.code ?? 'no code');

test('the git fs adapter reads, writes, lists and removes through folder handles, with Node-style error codes', async () => {
  const root = new DiskDirectory('repo'), fs = (gitFs(root) as any).promises;
  await fs.mkdir('/.git'); await fs.mkdir('/.git/objects');
  assert.equal(await code(fs.mkdir('/.git')), 'EEXIST'); assert.equal(await code(fs.mkdir('/missing/child')), 'ENOENT');
  await fs.writeFile('/.git/HEAD', 'ref: refs/heads/main\n'); await fs.writeFile('./.git//bytes', new Uint8Array([0, 255, 7]));
  assert.equal(await code(fs.mkdir('/.git/HEAD')), 'EEXIST');
  assert.equal(await fs.readFile('/.git/HEAD', 'utf8'), 'ref: refs/heads/main\n'); assert.equal(await fs.readFile('/.git/HEAD', { encoding: 'utf8' }), 'ref: refs/heads/main\n');
  assert.deepEqual([...await fs.readFile('/.git/bytes')], [0, 255, 7]); assert.ok(await fs.readFile('/.git/bytes', {}) instanceof Uint8Array);
  assert.deepEqual(await fs.readdir('/.git'), ['HEAD', 'bytes', 'objects']); assert.deepEqual(await fs.readdir('/'), ['.git']);
  assert.equal(await code(fs.readdir('/nope')), 'ENOENT'); assert.equal(await code(fs.readdir('/.git/HEAD')), 'ENOTDIR');
  assert.equal(await code(fs.readFile('/nope')), 'ENOENT'); assert.equal(await code(fs.readFile('/.git/objects')), 'EISDIR'); assert.equal(await code(fs.readFile('/')), 'EISDIR');
  assert.equal(await code(fs.readFile('/.git/HEAD/inside')), 'ENOTDIR');
  assert.equal(await code(fs.writeFile('/.git/objects', 'x')), 'EISDIR'); assert.equal(await code(fs.writeFile('/missing/file', 'x')), 'ENOENT');
  const file = await (await root.getDirectoryHandle('.git')).getFileHandle('HEAD'); file.failed = true;
  await assert.rejects(fs.writeFile('/.git/HEAD', 'lost'), /disk full/); assert.ok(file.aborted); file.failed = false; assert.equal(await fs.readFile('/.git/HEAD', 'utf8'), 'ref: refs/heads/main\n');
  const info = await fs.stat('/.git/HEAD'); assert.deepEqual([info.isFile(), info.isDirectory(), info.isSymbolicLink(), info.size, info.mode], [true, false, false, 21, 0o100644]);
  assert.equal(info.mtimeMs, 0); assert.notEqual(info.ino, (await fs.lstat('/.git/HEAD')).ino);
  const dir = await fs.stat('/.git'); assert.deepEqual([dir.isFile(), dir.isDirectory(), dir.mode], [false, true, 0o40000]); assert.equal((await fs.stat('/')).isDirectory(), true);
  assert.equal(await code(fs.stat('/nope')), 'ENOENT'); assert.equal(await code(fs.stat('/nope/deeper')), 'ENOENT'); assert.equal(await code(fs.lstat('/.git/HEAD/x')), 'ENOTDIR');
  assert.equal(await code(fs.readlink('/x')), 'ENOSYS'); assert.equal(await code(fs.symlink('/x')), 'ENOSYS');
  await fs.unlink('/.git/bytes'); assert.equal(await code(fs.unlink('/.git/bytes')), 'ENOENT'); assert.equal(await code(fs.unlink('/.git/objects')), 'EISDIR');
  await fs.rmdir('/.git/objects'); assert.equal(await code(fs.rmdir('/.git/objects')), 'ENOENT'); assert.equal(await code(fs.rmdir('/.git/HEAD')), 'ENOTDIR');
  assert.equal(await code(fs.unlink('/')), 'EISDIR');
  const stamped = new DiskDirectory('stamped'), real = stamped.add('f', 'x'); real.getFile = async () => ({ size: 1, lastModified: 1234, arrayBuffer: async () => new Uint8Array([120]).buffer as ArrayBuffer });
  assert.equal((await (gitFs(stamped) as any).promises.stat('/f')).mtimeMs, 1234);
});

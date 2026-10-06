import type { PromiseFsClient } from 'isomorphic-git';
import type { LocalDirectory, LocalFile } from './local.js';

/** A Node-style `fs.promises` over a user-granted folder, which is what isomorphic-git needs to read and write `.git`. */
export type GitFs = PromiseFsClient;

const fail = (code: string, path: string, message = code): Error => Object.assign(new Error(`${message}: ${path}`), { code });
const parts = (path: string): string[] => path.split('/').filter(part => part && part !== '.');
const named = (error: unknown, ...names: string[]): boolean => names.includes((error as Error).name);

/**
 * A browser exposes no inode or change time. isomorphic-git trusts matching stat data and skips reading the file,
 * so a same-size edit within a second of an earlier status would look unchanged. A fresh `ino` on every call makes it
 * always compare content: slower, but status and commit never miss a change.
 */
function stats(type: 'file' | 'directory', size: number, modified: number) {
  return { type, mode: type === 'file' ? 0o100644 : 0o40000, size, ino: Math.floor(Math.random() * 0xffffffff), uid: 1, gid: 1, dev: 1, mtimeMs: modified, ctimeMs: modified,
    isFile: () => type === 'file', isDirectory: () => type === 'directory', isSymbolicLink: () => false };
}

export function gitFs(root: LocalDirectory): GitFs {
  const directory = async (path: string[]): Promise<LocalDirectory> => {
    let current = root;
    for (const name of path) {
      try { current = await current.getDirectoryHandle(name); }
      catch (error) { throw named(error, 'TypeMismatchError') ? fail('ENOTDIR', path.join('/')) : fail('ENOENT', path.join('/')); }
    }
    return current;
  };
  const parent = async (path: string): Promise<[LocalDirectory, string]> => {
    const all = parts(path), name = all.pop();
    if (!name) throw fail('EISDIR', path);
    return [await directory(all), name];
  };
  const file = async (path: string): Promise<LocalFile> => {
    const [folder, name] = await parent(path);
    try { return await folder.getFileHandle(name); }
    catch (error) { throw named(error, 'TypeMismatchError') ? fail('EISDIR', path) : fail('ENOENT', path); }
  };
  const stat = async (path: string) => {
    if (!parts(path).length) return stats('directory', 0, 0);
    const [folder, name] = await parent(path);
    try { const info = await (await folder.getFileHandle(name)).getFile(); return stats('file', info.size, info.lastModified ?? 0); }
    catch (error) {
      if (!named(error, 'TypeMismatchError')) throw fail('ENOENT', path);
      await folder.getDirectoryHandle(name); return stats('directory', 0, 0);
    }
  };
  const unsupported = async (path: string) => { throw fail('ENOSYS', path, 'symbolic links are not supported in the browser'); };
  return { promises: {
    async readFile(path: string, options?: string | { encoding?: string }) {
      const bytes = new Uint8Array(await (await (await file(path)).getFile()).arrayBuffer());
      return (typeof options === 'string' ? options : options?.encoding) ? new TextDecoder().decode(bytes) : bytes;
    },
    async writeFile(path: string, data: string | Uint8Array) {
      const [folder, name] = await parent(path);
      let handle: LocalFile;
      try { handle = await folder.getFileHandle(name, { create: true }); } catch { throw fail('EISDIR', path); }
      const stream = await handle.createWritable();
      try { await stream.write(data); await stream.close(); } catch (error) { await stream.abort(); throw error; }
    },
    async unlink(path: string) { const [folder, name] = await parent(path); await file(path); await folder.removeEntry(name); },
    async readdir(path: string) {
      const names: string[] = [];
      for await (const [name] of (await directory(parts(path))).entries()) names.push(name);
      return names.sort();
    },
    async mkdir(path: string) {
      const [folder, name] = await parent(path);
      try { await folder.getDirectoryHandle(name); } catch (error) { if (named(error, 'TypeMismatchError')) throw fail('EEXIST', path); await folder.getDirectoryHandle(name, { create: true }); return; }
      throw fail('EEXIST', path);
    },
    async rmdir(path: string) { const [folder, name] = await parent(path); await directory(parts(path)); await folder.removeEntry(name); },
    stat: (path: string) => stat(path), lstat: (path: string) => stat(path), readlink: unsupported, symlink: unsupported,
  } };
}

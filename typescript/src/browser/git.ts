import { STAGE, TREE, WORKDIR, add, branch, readBlob, resolveRef, checkout, commit, currentBranch, getConfig, listBranches, log, remove, statusMatrix, walk } from 'isomorphic-git';
import { covers, fileDiff, type GitCommit, type GitEntry, type GitPort } from '../git.js';
import { gitFs, type GitFs } from './git-fs.js';
import type { LocalDirectory } from './local.js';

type Sides = [Uint8Array | undefined, Uint8Array | undefined, Uint8Array | undefined];
const decode = (bytes: Uint8Array | undefined): string | undefined => bytes && new TextDecoder().decode(bytes);
const binary = (bytes: Uint8Array | undefined): boolean => !!bytes && bytes.includes(0);

/** State letters from one isomorphic-git status row: [head, workdir, stage], each 0 absent, 1 same as HEAD, 2 and 3 different. */
export function states(head: number, workdir: number, stage: number): { staged: string; unstaged: string } {
  const staged = !stage ? (head ? 'D' : '') : !head ? 'A' : stage === 1 ? '' : 'M';
  const unstaged = !stage ? (workdir ? '?' : '') : !workdir ? 'D' : stage === 1 ? (workdir === 2 ? 'M' : '') : stage === 2 ? '' : 'M';
  return { staged, unstaged };
}

/**
 * isomorphic-git over a granted folder, so the browser edition can read and commit a real repository without a
 * git program. It reads only the repository's own `.git/config`, runs no hooks and cannot use symbolic links.
 */
export class BrowserGit implements GitPort {
  private readonly base: { fs: GitFs; dir: string };
  constructor(root: LocalDirectory) { this.base = { fs: gitFs(root), dir: '/' }; }

  /** Like git itself, every command fails clearly outside a repository. Only the project folder is checked, never its parents. */
  private async repository(): Promise<void> {
    try { await this.base.fs.promises.stat('/.git'); }
    catch { throw new Error('not a git repository: the project folder has no .git directory'); }
  }

  async status(): Promise<{ branch: string; entries: GitEntry[] }> {
    await this.repository();
    const entries = (await statusMatrix(this.base)).map(([path, head, workdir, stage]) => ({ path, ...states(head, workdir, stage) })).filter(entry => entry.staged || entry.unstaged);
    return { branch: await currentBranch(this.base) || '', entries };
  }

  async diff(options: { staged?: boolean; paths?: string[] }): Promise<string> {
    const { entries } = await this.status(), paths = options.paths;
    const wanted = entries.filter(entry => (options.staged ? entry.staged : entry.unstaged && entry.unstaged !== '?') && (!paths || paths.some(prefix => covers(prefix, entry.path))));
    const names = new Set(wanted.map(entry => entry.path)), sides = new Map<string, Sides>();
    await walk({ ...this.base, trees: [TREE({ ref: 'HEAD' }), STAGE(), WORKDIR()],
      map: async (path, [head, stage, work]) => {
        if (path === '.') return undefined;
        if (!names.has(path)) return [...names].some(name => name.startsWith(`${path}/`)) ? undefined : null;
        // The index walker has no content, only the object id of what is staged.
        const read = async (entry: typeof head) => entry ? await entry.content() as Uint8Array | undefined : undefined;
        const staged = stage ? (await readBlob({ ...this.base, oid: (await stage.oid())! })).blob : undefined;
        sides.set(path, [await read(head), staged, await read(work)]);
        return null;
      } });
    return wanted.map(entry => {
      const [head, stage, work] = sides.get(entry.path)!, before = options.staged ? head : stage, after = options.staged ? stage : work;
      return binary(before) || binary(after) ? `Binary files a/${entry.path} and b/${entry.path} differ` : fileDiff(entry.path, decode(before), decode(after));
    }).join('\n');
  }

  async log(options: { limit: number; path?: string }): Promise<GitCommit[]> {
    await this.repository();
    if (!await resolveRef({ ...this.base, ref: 'HEAD' }).then(() => true, () => false)) return []; // a branch with no commits yet
    try {
      return (await log({ ...this.base, depth: options.limit, ...(options.path ? { filepath: options.path } : {}) }))
        .map(item => ({ oid: item.oid, author: item.commit.author.name, date: new Date(item.commit.author.timestamp * 1000).toISOString(), subject: item.commit.message.split('\n')[0]! }));
    } catch (error) {
      if (options.path && (error as { code?: string }).code === 'NotFoundError') return []; // a path that is not in the repository has no history
      throw error;
    }
  }

  async branches(): Promise<{ current: string; all: string[] }> {
    await this.repository();
    return { current: await currentBranch(this.base) || '', all: await listBranches(this.base) };
  }

  async commit(message: string, paths?: string[]): Promise<string> {
    const { entries } = await this.status();
    for (const entry of paths ? entries.filter(item => paths.some(prefix => covers(prefix, item.path))) : entries) {
      if (entry.unstaged === 'D') await remove({ ...this.base, filepath: entry.path });
      else if (entry.unstaged) await add({ ...this.base, filepath: entry.path });
    }
    const name = await getConfig({ ...this.base, path: 'user.name' }), email = await getConfig({ ...this.base, path: 'user.email' });
    if (typeof name !== 'string' || typeof email !== 'string') throw new Error("the repository has no committer identity. The browser reads only this repository's .git/config: run `git config user.name \"Your Name\"` and `git config user.email you@example.com` in the project folder, then try again");
    const oid = await commit({ ...this.base, message, author: { name, email } });
    return `${oid.slice(0, 7)} ${message.split('\n')[0]}`;
  }

  async createBranch(name: string): Promise<void> { await this.repository(); await branch({ ...this.base, ref: name }); }
  async checkout(name: string): Promise<void> { await this.repository(); await checkout({ ...this.base, ref: name }); }
}

import { execFile } from 'node:child_process';
import path from 'node:path';
import type { GitCommit, GitEntry, GitPort } from '../git.js';

const TIMEOUT_MS = 30_000;

/**
 * The installed git program, run without a shell in the project folder. Repositories above the folder are not
 * searched, hooks and fsmonitor do not run, and nothing can prompt.
 */
export class NodeGit implements GitPort {
  constructor(private readonly root: string, private readonly signal?: AbortSignal) {}

  private run(args: string[]): Promise<string> {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: path.dirname(this.root), LC_ALL: 'C' };
    return new Promise((resolve, reject) => {
      execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', ...args],
        { cwd: this.root, env, timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8', ...(this.signal ? { signal: this.signal } : {}) },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('git is not installed or not on PATH'));
          if (error.name === 'AbortError') return reject(new Error('stopped'));
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
        });
    });
  }

  async status(): Promise<{ branch: string; entries: GitEntry[] }> {
    const records = (await this.run(['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'])).split('\0');
    const header = records.shift()!.replace(/^## /, '');
    const branch = header.startsWith('HEAD (no branch)') ? '' : header.replace(/^No commits yet on /, '').split(/\.\.\.| /)[0]!;
    const entries: GitEntry[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      if (!record) continue;
      const x = record[0]!, y = record[1]!;
      if (x === 'R' || x === 'C') i++; // the original name follows
      entries.push(x === '?' ? { path: record.slice(3), staged: '', unstaged: '?' } : { path: record.slice(3), staged: x === ' ' ? '' : x, unstaged: y === ' ' ? '' : y });
    }
    return { branch, entries };
  }

  diff(options: { staged?: boolean; paths?: string[] }): Promise<string> {
    return this.run(['diff', '--no-color', '--no-ext-diff', ...(options.staged ? ['--cached'] : []), '--', ...(options.paths ?? [])]);
  }

  async log(options: { limit: number; path?: string }): Promise<GitCommit[]> {
    let output: string;
    try { output = await this.run(['log', '-n', String(options.limit), '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', '--', ...(options.path ? [options.path] : [])]); }
    catch (error) { if (/does not have any commits/.test((error as Error).message)) return []; throw error; }
    return output.split('\x1e').map(record => record.trim()).filter(Boolean).map(record => { const [oid, author, date, subject] = record.split('\x1f'); return { oid: oid!, author: author!, date: date!, subject: subject! }; });
  }

  async branches(): Promise<{ current: string; all: string[] }> {
    const all = (await this.run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
    const current = (await this.run(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
    return { current, all };
  }

  async commit(message: string, paths?: string[]): Promise<string> {
    await this.run(['add', '-A', '--', ...(paths ?? ['.'])]);
    await this.run(['commit', '-m', message]);
    return (await this.run(['log', '-1', '--format=%h %s'])).trim();
  }

  async createBranch(name: string): Promise<void> { await this.run(['branch', name]); }
  async checkout(name: string): Promise<void> { await this.run(['switch', '--no-guess', name]); }
}

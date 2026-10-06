import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const IDENTITY = { GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.org' };
/** Real git, used to build repositories and to check what the adapters did. */
export const real = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...IDENTITY } });
export async function repository(t: { after(fn: () => unknown): void }, commits = true): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'myharness-git-')); t.after(() => rm(dir, { recursive: true, force: true }));
  real(dir, 'init', '-q', '-b', 'main');
  if (commits) {
    await writeFile(path.join(dir, 'a.txt'), 'one\n'); await mkdir(path.join(dir, 'sub')); await writeFile(path.join(dir, 'sub/b.txt'), 'bee\n');
    real(dir, 'add', '.'); real(dir, 'commit', '-q', '-m', 'first');
  }
  return dir;
}

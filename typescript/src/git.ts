import { createTwoFilesPatch } from 'diff';

/** A changed path. `staged` and `unstaged` are one-letter states as in `git status --short`; unstaged `?` is untracked. */
export interface GitEntry { path: string; staged: string; unstaged: string }
export interface GitCommit { oid: string; author: string; date: string; subject: string }

/** What the git tools need from a runtime: real git in Node, isomorphic-git in the browser. Paths are relative to the project folder. */
export interface GitPort {
  /** `branch` is empty on a detached HEAD. */
  status(): Promise<{ branch: string; entries: GitEntry[] }>;
  diff(options: { staged?: boolean; paths?: string[] }): Promise<string>;
  log(options: { limit: number; path?: string }): Promise<GitCommit[]>;
  branches(): Promise<{ current: string; all: string[] }>;
  /** Stages `paths` (default: every change), commits everything staged and returns "<short id> <subject>". */
  commit(message: string, paths?: string[]): Promise<string>;
  createBranch(name: string): Promise<void>;
  checkout(name: string): Promise<void>;
}

/** Long diffs are cut so one tool result cannot fill the context. */
export const OUTPUT_LIMIT = 20_000;
export function cap(text: string, limit = OUTPUT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[output cut: ${text.length - limit} more characters]` : text;
}

/** A branch name that is safe to hand to git: no option-like names, no spaces, no `..`. */
export function branchName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(name) || /^[-/]|\.\.|\/\/|\/$|\.lock$|\.$/.test(name)) throw new Error(`'${value}' is not a valid branch name: use letters, digits, '.', '_', '-' and '/', not starting with '-' or '/'`);
  return name;
}

export const formatEntries = (entries: GitEntry[]): string =>
  entries.map(entry => `${entry.unstaged === '?' ? '??' : (entry.staged || ' ') + (entry.unstaged || ' ')} ${entry.path}`).join('\n');
export function formatStatus(status: { branch: string; entries: GitEntry[] }): string {
  const head = status.branch ? `On branch ${status.branch}` : 'HEAD is detached';
  return status.entries.length
    ? `${head}\n${formatEntries(status.entries)}\n(left column: staged, right column: unstaged; ?? is untracked; M modified, A added, D deleted, R renamed)`
    : `${head}\nNothing to commit: the working tree is clean.`;
}
export const formatLog = (commits: GitCommit[]): string =>
  commits.map(commit => `${commit.oid.slice(0, 7)} ${commit.date.slice(0, 10)} ${commit.author}: ${commit.subject}`).join('\n') || '(no commits yet)';
export const formatBranches = (branches: { current: string; all: string[] }): string =>
  branches.all.map(name => `${name === branches.current ? '*' : ' '} ${name}`).join('\n') || `(no branches yet${branches.current ? `; on unborn branch ${branches.current}` : ''})`;

/** Whether `path` is the same as, or inside, `prefix` ('' and '.' mean the whole project). */
export function covers(prefix: string, path: string): boolean {
  const base = prefix.replace(/\/+$/, '');
  return !base || base === '.' || path === base || path.startsWith(`${base}/`);
}

/** One file's change as a unified diff; `undefined` means the file does not exist on that side. */
export function fileDiff(path: string, before: string | undefined, after: string | undefined): string {
  return createTwoFilesPatch(before === undefined ? '/dev/null' : `a/${path}`, after === undefined ? '/dev/null' : `b/${path}`, before ?? '', after ?? '', undefined, undefined, { context: 3 }).replace(/^(Index:.*\n)?=+\n/, '').trimEnd();
}
/** A new file as a diff. A file that cannot be read as text is described instead. */
export const newFileDiff = (path: string, text: string | undefined): string => text === undefined ? `new file ${path} (binary or unreadable, not shown)` : fileDiff(path, undefined, text);

/**
 * What `git_commit` will commit, shown before approval and without changing anything: the files, and the diff of
 * what is already staged, the selected changes and the selected new files.
 */
export async function commitPreview(git: GitPort, readText: (path: string) => Promise<string>, message: string, paths?: string[]): Promise<string> {
  const { entries } = await git.status();
  const selected = paths ? entries.filter(entry => paths.some(prefix => covers(prefix, entry.path))) : entries;
  const files = [...selected, ...entries.filter(entry => entry.staged && !selected.includes(entry))];
  if (!files.length) throw new Error(`nothing to commit: there are no changes${paths ? ' in those paths' : ''}`);
  const staged = files.filter(entry => entry.staged).map(entry => entry.path);
  const changed = selected.filter(entry => entry.unstaged && entry.unstaged !== '?').map(entry => entry.path);
  const parts = [
    staged.length ? await git.diff({ staged: true, paths: staged }) : '',
    changed.length ? await git.diff({ paths: changed }) : '',
    ...await Promise.all(selected.filter(entry => entry.unstaged === '?').map(async entry => newFileDiff(entry.path, await readText(entry.path).catch(() => undefined)))),
  ].filter(Boolean);
  return cap(`Message: ${message}\n\nFiles that will be in this commit (only the ones staged now and the selected ones):\n${formatEntries(files)}\n\n${parts.join('\n')}`);
}

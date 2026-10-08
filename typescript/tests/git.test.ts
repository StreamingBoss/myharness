import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserGit, states } from '../src/browser/git.js';
import { NodeGit } from '../src/node/git.js';
import { branchName, cap, commitPreview, covers, fileDiff, formatBranches, formatEntries, formatLog, formatStatus, newFileDiff, OUTPUT_LIMIT, type GitPort } from '../src/git.js';
import { NodeDirectory } from './disk-handle.js';
import { real, repository } from './git-helpers.js';

const adapters: [string, (dir: string, signal?: AbortSignal) => GitPort][] = [
  ['real git (Node)', (dir, signal) => new NodeGit(dir, signal)],
  ['isomorphic-git (browser)', dir => new BrowserGit(new NodeDirectory('repo', dir))],
];
const sorted = (entries: { path: string }[]) => [...entries].sort((a, b) => a.path.localeCompare(b.path));
const write = (dir: string, name: string, text: string | Uint8Array) => writeFile(path.join(dir, name), text);

for (const [name, make] of adapters) {
  test(`${name}: status, diff, log and branches describe a repository the same way`, async t => {
    const dir = await repository(t), git = make(dir);
    assert.deepEqual(await git.status(), { branch: 'main', entries: [] });
    assert.equal(await git.diff({}), '');
    assert.deepEqual(await git.branches(), { current: 'main', all: ['main'] });
    await git.createBranch('feature'); assert.deepEqual(await git.branches(), { current: 'main', all: ['feature', 'main'] });
    await assert.rejects(git.createBranch('feature'));
    await git.checkout('feature'); assert.equal(real(dir, 'branch', '--show-current').trim(), 'feature'); assert.equal((await git.status()).branch, 'feature');
    await assert.rejects(git.checkout('missing-branch'));
    await write(dir, 'a.txt', 'two\n'); await write(dir, 'new.txt', 'new\n'); await rm(path.join(dir, 'sub/b.txt'));
    await mkdir(path.join(dir, 'fresh')); await write(dir, 'fresh/x.txt', 'x\n'); await write(dir, 'fresh/y.txt', 'y\n');
    await write(dir, '.gitignore', 'ignored.txt\n'); await write(dir, 'ignored.txt', 'skip\n');
    assert.deepEqual(sorted((await git.status()).entries), [
      { path: '.gitignore', staged: '', unstaged: '?' }, { path: 'a.txt', staged: '', unstaged: 'M' }, { path: 'fresh/x.txt', staged: '', unstaged: '?' },
      { path: 'fresh/y.txt', staged: '', unstaged: '?' }, { path: 'new.txt', staged: '', unstaged: '?' }, { path: 'sub/b.txt', staged: '', unstaged: 'D' }]);
    const diff = await git.diff({});
    assert.match(diff, /--- a\/a\.txt/); assert.match(diff, /-one/); assert.match(diff, /\+two/); assert.match(diff, /sub\/b\.txt/); assert.match(diff, /-bee/);
    assert.equal(/new\.txt|ignored/.test(diff), false);
    const only = await git.diff({ paths: ['a.txt'] }); assert.match(only, /\+two/); assert.equal(only.includes('b.txt'), false);
    assert.equal(await git.diff({ staged: true }), '');
    real(dir, 'add', 'a.txt');
    assert.deepEqual((await git.status()).entries.find(entry => entry.path === 'a.txt'), { path: 'a.txt', staged: 'M', unstaged: '' });
    assert.match(await git.diff({ staged: true }), /\+two/); assert.equal(await git.diff({ paths: ['a.txt'] }), '');
    await write(dir, 'a.txt', 'three\n');
    assert.deepEqual((await git.status()).entries.find(entry => entry.path === 'a.txt'), { path: 'a.txt', staged: 'M', unstaged: 'M' });
    assert.match(await git.diff({}), /\+three/);
    real(dir, 'add', 'sub/b.txt'); assert.match(await git.diff({ staged: true, paths: ['sub/b.txt'] }), /-bee/); assert.deepEqual((await git.status()).entries.find(entry => entry.path === 'sub/b.txt'), { path: 'sub/b.txt', staged: 'D', unstaged: '' });
    await write(dir, 'blob.bin', new Uint8Array([0, 1, 2])); real(dir, 'add', 'blob.bin'); await write(dir, 'blob.bin', new Uint8Array([0, 1, 3]));
    assert.match(await git.diff({ paths: ['blob.bin'] }), /Binary files/); assert.match(await git.diff({ staged: true, paths: ['blob.bin'] }), /Binary files|new file|Binary/);

    const first = await git.log({ limit: 5 });
    assert.equal(first.length, 1); assert.equal(first[0]!.subject, 'first'); assert.equal(first[0]!.author, 'Tester'); assert.match(first[0]!.date, /^\d{4}-\d\d-\d\dT/); assert.match(first[0]!.oid, /^[0-9a-f]{40}$/);
    assert.equal((await git.log({ limit: 5, path: 'sub/b.txt' })).length, 1);
    assert.equal((await git.log({ limit: 5, path: 'nothing/here' })).length, 0);
    real(dir, 'checkout', '-q', '--detach'); assert.equal((await git.status()).branch, ''); assert.equal((await git.branches()).current, '');
  });

  test(`${name}: commit stages the chosen paths, commits what is staged, and real git agrees`, async t => {
    const dir = await repository(t); real(dir, 'config', 'user.name', 'Configured'); real(dir, 'config', 'user.email', 'c@example.org');
    const git = make(dir);
    await write(dir, 'a.txt', 'two\n'); await write(dir, 'new.txt', 'new\n'); await rm(path.join(dir, 'sub/b.txt'));
    assert.match(await git.commit('change a\n\nlonger body', ['a.txt']), /^[0-9a-f]{7} change a$/);
    assert.equal(real(dir, 'log', '-1', '--format=%an|%s').trim(), 'Configured|change a');
    assert.equal(real(dir, 'status', '--porcelain').split('\n').filter(Boolean).sort().join('|'), ' D sub/b.txt|?? new.txt');
    assert.equal(real(dir, 'show', 'HEAD:a.txt'), 'two\n');
    assert.match(await git.commit('rest'), /^[0-9a-f]{7} rest$/);
    assert.equal(real(dir, 'status', '--porcelain'), ''); assert.equal(real(dir, 'ls-files').trim().split('\n').join('|'), 'a.txt|new.txt');
    assert.equal(real(dir, 'fsck', '--strict').trim(), '');
    assert.deepEqual((await git.log({ limit: 10 })).map(commit => commit.subject), ['rest', 'change a', 'first']);
    // Something already staged by someone else is part of the commit too.
    await write(dir, 'staged.txt', 's\n'); real(dir, 'add', 'staged.txt'); await write(dir, 'other.txt', 'o\n');
    await git.commit('only other', ['other.txt']); assert.equal(real(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort().join('|'), 'other.txt|staged.txt');
  });

  test(`${name}: a checkout that would overwrite uncommitted work is refused, and a clean one switches files`, async t => {
    const dir = await repository(t), git = make(dir);
    await git.createBranch('other'); await git.checkout('other');
    await write(dir, 'a.txt', 'on other\n'); real(dir, 'commit', '-q', '-am', 'other change');
    await git.checkout('main'); assert.equal(real(dir, 'show', 'HEAD:a.txt'), 'one\n');
    await write(dir, 'a.txt', 'dirty\n');
    await assert.rejects(git.checkout('other'));
    assert.equal(real(dir, 'branch', '--show-current').trim(), 'main');
    real(dir, 'checkout', '-q', 'a.txt'); await git.checkout('other'); assert.equal(real(dir, 'branch', '--show-current').trim(), 'other');
  });

  test(`${name}: a repository without commits and a folder without a repository`, async t => {
    const dir = await repository(t, false), git = make(dir);
    await write(dir, 'a.txt', 'x\n');
    assert.deepEqual(await git.status(), { branch: 'main', entries: [{ path: 'a.txt', staged: '', unstaged: '?' }] });
    assert.deepEqual(await git.log({ limit: 3 }), []); assert.deepEqual(await git.branches(), { current: 'main', all: [] });
    const bare = await mkdtemp(path.join(tmpdir(), 'myharness-nogit-')); t.after(() => rm(bare, { recursive: true, force: true }));
    await assert.rejects(make(bare).status());
  });
}

test('both adapters report a log they cannot read instead of calling it empty', async t => {
  const dir = await repository(t), head = real(dir, 'rev-parse', 'HEAD').trim();
  await rm(path.join(dir, '.git/objects', head.slice(0, 2), head.slice(2)));
  for (const [, make] of adapters) await assert.rejects(make(dir).log({ limit: 3 }));
  await assert.rejects(new NodeGit(dir).log({ limit: 3, path: '../outside' }));
});

test('browser git needs a committer identity from the repository itself', async t => {
  const dir = await repository(t); await write(dir, 'a.txt', 'two\n');
  await assert.rejects(new BrowserGit(new NodeDirectory('repo', dir)).commit('no identity'), /no committer identity[\s\S]*git config user\.name/);
  assert.equal(real(dir, 'log', '--format=%s').trim(), 'first');
});

test('browser status letters cover every isomorphic-git row', () => {
  const rows: [number, number, number, string, string][] = [
    [1, 1, 1, '', ''], [0, 2, 0, '', '?'], [0, 0, 0, '', ''], [1, 0, 0, 'D', ''], [1, 1, 0, 'D', '?'], [0, 2, 2, 'A', ''], [0, 2, 3, 'A', 'M'], [0, 0, 3, 'A', 'D'],
    [1, 2, 1, '', 'M'], [1, 2, 2, 'M', ''], [1, 2, 3, 'M', 'M'], [1, 0, 1, '', 'D'], [1, 1, 3, 'M', 'M'], [1, 0, 3, 'M', 'D'],
  ];
  for (const [head, workdir, stage, staged, unstaged] of rows) assert.deepEqual(states(head, workdir, stage), { staged, unstaged }, `[${head},${workdir},${stage}]`);
});

test('real git adapter: renames, safe environment, missing git, Stop and failures', async t => {
  const dir = await repository(t), git = new NodeGit(dir);
  real(dir, 'mv', 'a.txt', 'c.txt'); await write(dir, 'z.txt', 'z\n');
  assert.deepEqual(sorted((await git.status()).entries), [{ path: 'c.txt', staged: 'R', unstaged: '' }, { path: 'z.txt', staged: '', unstaged: '?' }]);
  await assert.rejects(git.commit('bad path', ['nowhere']), /pathspec 'nowhere' did not match/);
  assert.match(await git.commit('rename and add'), /^[0-9a-f]{7} rename and add$/);
  await assert.rejects(git.commit('empty'), /nothing to commit/);
  // A repository above the project folder is not used, and hooks do not run.
  const parent = await repository(t), inner = path.join(parent, 'project'); await mkdir(inner);
  await assert.rejects(new NodeGit(inner).status(), /not a git repository/);
  const marker = path.join(parent, 'hook-ran'); await mkdir(path.join(parent, '.git/hooks'), { recursive: true });
  await writeFile(path.join(parent, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`); await chmod(path.join(parent, '.git/hooks/pre-commit'), 0o755);
  await write(parent, 'h.txt', 'h\n'); await new NodeGit(parent).commit('with hook installed');
  await assert.rejects(access(marker), /ENOENT/);
  const oldPath = process.env.PATH; process.env.PATH = '/nonexistent'; try { await assert.rejects(git.status(), /git is not installed/); } finally { process.env.PATH = oldPath; }
  const stop = new AbortController(); stop.abort(); await assert.rejects(new NodeGit(dir, stop.signal).status(), /stopped/);
  await assert.rejects(git.diff({ paths: ['../outside'] }));
});

test('formatting, validation and the commit preview are shared by both adapters', async t => {
  assert.equal(cap('x'.repeat(10)), 'x'.repeat(10)); assert.match(cap('x'.repeat(OUTPUT_LIMIT + 5)), /\[output cut: 5 more characters\]$/);
  for (const good of ['main', 'feature/a-b_c.1', ' padded ']) assert.equal(branchName(good), good.trim());
  for (const bad of ['', '-x', '/x', 'a..b', 'a//b', 'a/', 'x.lock', 'a b', 'a.', '--force', 'x;rm']) assert.throws(() => branchName(bad), /not a valid branch name/);
  assert.equal(formatEntries([{ path: 'a', staged: 'M', unstaged: '' }, { path: 'b', staged: '', unstaged: 'M' }, { path: 'c', staged: 'A', unstaged: 'M' }, { path: 'd', staged: '', unstaged: '?' }]), 'M  a\n M b\nAM c\n?? d');
  assert.match(formatStatus({ branch: 'main', entries: [{ path: 'a', staged: '', unstaged: 'M' }] }), /^On branch main\n M a\n\(left column/);
  assert.equal(formatStatus({ branch: '', entries: [] }), 'HEAD is detached\nNothing to commit: the working tree is clean.');
  assert.equal(formatLog([{ oid: 'abcdef1234', author: 'A', date: '2026-10-06T10:00:00Z', subject: 's' }]), 'abcdef1 2026-10-06 A: s'); assert.equal(formatLog([]), '(no commits yet)');
  assert.equal(formatBranches({ current: 'b', all: ['a', 'b'] }), '  a\n* b'); assert.equal(formatBranches({ current: 'main', all: [] }), '(no branches yet; on unborn branch main)'); assert.equal(formatBranches({ current: '', all: [] }), '(no branches yet)');
  assert.deepEqual(['', '.', 'a', 'a/', 'a/b', 'ab'].map(prefix => covers(prefix, 'a/b.txt')), [true, true, true, true, false, false]);
  assert.equal(covers('a', 'a'), true);
  assert.match(fileDiff('f', 'a\n', 'b\n'), /^--- a\/f\n\+\+\+ b\/f\n@@/); assert.match(fileDiff('f', undefined, 'n\n'), /^--- \/dev\/null\n\+\+\+ b\/f/); assert.match(fileDiff('f', 'gone\n', undefined), /\+\+\+ \/dev\/null/);
  assert.match(newFileDiff('f', undefined), /binary or unreadable/);

  const dir = await repository(t), git = new NodeGit(dir);
  await write(dir, 'a.txt', 'two\n'); await write(dir, 'new.txt', 'brand new\n'); await write(dir, 'pre.txt', 'p\n'); real(dir, 'add', 'pre.txt'); await write(dir, 'bin.dat', 'x');
  const read = async (file: string) => file === 'bin.dat' ? Promise.reject(new Error('binary')) : (await import('node:fs/promises')).readFile(path.join(dir, file), 'utf8');
  const all = await commitPreview(git, read, 'msg');
  assert.match(all, /^Message: msg\n\nFiles that will be in this commit/); assert.match(all, /\?\? new\.txt/); assert.match(all, /\+brand new/); assert.match(all, /\+two/); assert.match(all, /\+p/); assert.match(all, /new file bin\.dat \(binary or unreadable/);
  const some = await commitPreview(git, read, 'msg', ['a.txt']);
  assert.match(some, /M a\.txt/); assert.match(some, /A {2}pre\.txt/); assert.equal(some.includes('new.txt'), false);
  await assert.rejects(commitPreview(git, read, 'msg', ['nowhere']).then(() => commitPreview({ status: async () => ({ branch: 'main', entries: [] }) } as unknown as GitPort, read, 'msg')), /nothing to commit: there are no changes$/);
  await assert.rejects(commitPreview({ status: async () => ({ branch: 'main', entries: [] }) } as unknown as GitPort, read, 'msg', ['x']), /no changes in those paths/);
  assert.equal(real(dir, 'status', '--porcelain').includes('pre.txt'), true); // previews change nothing
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pathToFileURL } from 'node:url';

type Copy = (source: string, target: string) => Promise<{ language: string; file: string; name: string }[]>;
// The build script is plain JavaScript run from the repository root.
const copyRecordedSessions: Copy = (...args) => import(pathToFileURL(path.resolve('scripts/recorded-sessions.mjs')).href).then(module => (module.copyRecordedSessions as Copy)(...args));

const session = (name: string, extra = '') => JSON.stringify({ format: 'myharness-session', name, workspace: '/workspace', note: extra });

test('recorded sessions are copied with an index in language and file-name order, ignoring other files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-recorded-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'out');
  await mkdir(path.join(source, 'fr'), { recursive: true }); await mkdir(path.join(source, 'en'), { recursive: true });
  await writeFile(path.join(source, 'fr', '1-memoire.json'), session('Mémoire')); await writeFile(path.join(source, 'en', '2-memory.json'), session('Memory'));
  await writeFile(path.join(source, 'en', '1-raw.json'), session('Raw')); await writeFile(path.join(source, 'en', 'notes.txt'), 'not a session');
  await writeFile(path.join(source, 'README.md'), 'a file, not a language folder');
  const index = await copyRecordedSessions(source, target);
  assert.deepEqual(index, [{ language: 'en', file: 'en/1-raw.json', name: 'Raw' }, { language: 'en', file: 'en/2-memory.json', name: 'Memory' }, { language: 'fr', file: 'fr/1-memoire.json', name: 'Mémoire' }]);
  assert.deepEqual(JSON.parse(await readFile(path.join(target, 'index.json'), 'utf8')), index);
  assert.equal(await readFile(path.join(target, 'fr', '1-memoire.json'), 'utf8'), session('Mémoire'));
});

test('no recordings give an empty index, and a recording that is not a session or names a local path stops the build', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-recorded-')); t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await copyRecordedSessions(path.join(root, 'missing'), path.join(root, 'none')), []);
  assert.equal(await readFile(path.join(root, 'none', 'index.json'), 'utf8'), '[]');
  const source = path.join(root, 'source'); await mkdir(path.join(source, 'en'), { recursive: true });
  await writeFile(path.join(source, 'en', 'a.json'), '{"format":"other"}');
  await assert.rejects(copyRecordedSessions(source, path.join(root, 'out')), /not a myharness session export: en\/a\.json/);
  for (const [file, path_] of [['b.json', '/home/someone/project'], ['c.json', '/Users/someone/project'], ['d.json', 'C:\\\\Users\\\\someone']]) {
    await writeFile(path.join(source, 'en', 'a.json'), session('ok')); await writeFile(path.join(source, 'en', file!), session('leak', path_!));
    await assert.rejects(copyRecordedSessions(source, path.join(root, 'out')), new RegExp(`local path.*en/${file!.replace('.', '\\.')}`));
    await rm(path.join(source, 'en', file!));
  }
});

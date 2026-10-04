import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';

test('all UI routes, static assets, CORS preflight and session lifecycle use the public host', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-http-all-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['work', 'work/a', 'work/b', 'work/.hidden', 'second']) await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, 'file.txt'), 'x');
  const harness = new NodeHarness({ workspace: path.join(root, 'work'), projectRoot: root, model: 'qwen', contextLength: 4096, sessions: new SessionStore(path.join(root, 'sessions')), ollama: { async *streamChat() { yield JSON.stringify({ message: { content: 'hello' }, done: true }); }, async request() { return {}; } } });
  await harness.initialize();
  const server = createHarnessServer(harness, { projectRoot: process.cwd(), uiOrigins: 'http://localhost:8000, ' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const request = async (route: string, method = 'GET', value?: unknown, expected = 200) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }); assert.equal(response.status, expected, await response.clone().text()); return response;
  };
  assert.match(await (await request('/')).text(), /bootstrap/);
  assert.match(await (await request('/static/marked.min.js')).text(), /marked/); await request('/static/missing.js', 'GET', undefined, 404);
  const cors = await fetch(base + '/bootstrap', { headers: { Origin: 'http://localhost:8000' } }); assert.equal(cors.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
  assert.equal((await fetch(base + '/bootstrap', { headers: { Origin: 'http://unlisted' } })).headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await fetch(base + '/chat', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8000' } })).status, 204);
  const first = harness.activeSessionRecord();
  await request('/sessions'); await request(`/sessions/${first.id}`); await request(`/sessions/${first.id}/export`);
  await request(`/sessions/${first.id}`, 'PATCH', { name: 'renamed', settings: { ask_approval: false } });
  await request('/sessions', 'POST', {}); await request('/sessions', 'POST', { name: 'third' });
  await request(`/sessions/${first.id}`, 'PATCH', { name: 'stale' }, 409); await request(`/sessions/${first.id}/activate`, 'POST');
  await request('/sessions/missing', 'GET', undefined, 404); await request('/sessions/missing/activate', 'POST', {}, 404);
  await request(`/sessions/${first.id}/activate`, 'PUT', undefined, 404);
  await request('/sessions/import', 'POST', first, 201); await request('/sessions/import', 'POST', {}, 400);
  await request('/approve', 'POST', { id: 'expired', approved: false }, 404); await request('/approve', 'POST', {}, 400); await request('/approve', 'POST', { approved: true }, 404);
  const settings = { message: 'hello', use_memory: true, ask_approval: false, tools: [], agent: '', prompt: '' };
  await request('/chat', 'POST', { ...settings, session_id: 'stale' }, 409);
  await request('/chat', 'POST', settings); await request('/chat', 'POST', {}, 400); await request('/chat', 'POST', null, 400);
  await request('/chat', 'POST', { ...settings, tools: [1] }, 400); await request('/chat', 'POST', { ...settings, use_memory: 'wrong' }, 400); await request('/chat', 'POST', { ...settings, ask_approval: 'wrong' }, 400); await request('/chat', 'POST', { ...settings, agent: 1 }, 400); await request('/chat', 'POST', { ...settings, prompt: 1 }, 400); await request('/chat', 'POST', { ...settings, message: 1 }, 400);
  await request('/explore', 'POST', settings); await request('/compact', 'POST', {}); await request('/compact', 'POST', { use_memory: false, session_id: first.id }, 400);
  await request('/project', 'POST', {}, 400); await request('/project', 'POST', { path: path.join(root, 'second') });
  await request('/browse'); assert.equal((await (await request('/browse?path=' + encodeURIComponent(path.join(root, 'work')))).json() as { folders: string[] }).folders.join(','), 'a,b');
  await request('/browse?path=/', 'GET'); await request('/browse?path=' + encodeURIComponent(path.join(root, 'file.txt')), 'GET', undefined, 400);
  await request('/reset', 'POST'); await request('/stop', 'POST');
});

test('HTTP detects disconnected streams and releases the turn', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-disconnect-')); t.after(() => rm(root, { recursive: true, force: true }));
  let aborted = false;
  const harness = new NodeHarness({ workspace: root, model: 'q', contextLength: 4096, ollama: { async *streamChat(_payload, signal) { await new Promise<void>(resolve => { if (signal!.aborted) resolve(); else signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); }); } } });
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(base + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hi', use_memory: true, tools: [], agent: '', prompt: '' }) });
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
  for (let i = 0; i < 50 && !aborted; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(aborted, true);
  for (let i = 0; i < 50; i++) { try { await harness.reset(); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
  assert.equal(harness.state.memory.length, 0);
});

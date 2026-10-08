import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { NodeHarness } from '../src/node/harness.js';
import { createHarnessServer } from '../src/node/http.js';

test('Node distribution serves separate Guide & Setup and static Worker assets without changing its landing page', async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'guide-http-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  const harness = new NodeHarness({ workspace: scratch, model: 'fixture', contextLength: 4096, ollama: { async *streamChat() {} } }); t.after(() => harness.close());
  for (const options of [{}, { projectRoot: scratch }]) {
    const server = createHarnessServer(harness, options); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const response = await fetch(base + '/guide.html'); assert.equal(response.status, options.projectRoot ? 404 : 200);
    if (!options.projectRoot) { assert.match(await response.text(), /Guide &amp; Setup|Guide & Setup/); for (const file of ['index.html', 'guide-ui.js', 'managed-worker.js', 'library.json', 'browser-ui.js', 'backend-worker.js', 'browser-backend.js']) assert.equal((await fetch(base + '/' + file)).status, 200); }
    else assert.match(await response.text(), /Build the browser/);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

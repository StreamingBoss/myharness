import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { NodeHarness } from '../src/node/harness.js';
import { createHarnessServer } from '../src/node/http.js';
import type { CoreEvent, ModelChunk, ModelRequest } from '../src/core.js';

for (const file of readdirSync('tests/scenarios').filter(name => name.endsWith('.json')).sort()) {
  test(`Python/TypeScript HTTP parity: ${file}`, async t => {
    const scenario = JSON.parse(readFileSync(path.join('tests/scenarios', file), 'utf8'));
    const root = await mkdtemp(path.join(tmpdir(), 'myharness-parity-')); t.after(() => rm(root, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(scenario.files ?? {})) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), String(text)); }
    const requests: ModelRequest[] = [];
    const turns = structuredClone(scenario.model_turns) as ModelChunk[][];
    const harness = new NodeHarness({ workspace: root, projectRoot: root, model: 'qwen3:8b', contextLength: 3000, ollama: {
      async *streamChat(payload) { requests.push(structuredClone(payload)); for (const chunk of turns.shift()!) yield JSON.stringify(chunk); }
    } });
    const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(base + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scenario.request) });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; const events: CoreEvent[] = [];
    while (true) {
      const chunk = await reader.read(); buffer += decoder.decode(chunk.value);
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const event = JSON.parse(buffer.slice(0, newline)) as CoreEvent; buffer = buffer.slice(newline + 1); events.push(event);
        if (event.type === 'approval') {
          if (scenario.approval === 'stop') await fetch(base + '/stop', { method: 'POST' });
          else await fetch(base + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: event.id, approved: scenario.approval === 'approve' }) });
        }
        newline = buffer.indexOf('\n');
      }
      if (chunk.done) break;
    }
    assert.deepEqual(events.map(event => event.type), scenario.expect.event_types);
    assert.deepEqual(harness.state.memory.map(message => message.role), scenario.expect.memory_roles);
    for (const [name, text] of Object.entries(scenario.expect.files ?? {})) assert.equal(await readFile(path.join(root, name), 'utf8'), text);
    const python = spawnSync('.venv/bin/python', ['tests/parity_host.py'], { input: JSON.stringify(scenario), encoding: 'utf8' });
    assert.equal(python.status, 0, python.stderr);
    const reference = JSON.parse(python.stdout);
    // Only generated approval IDs and the isolated workspace roots vary.
    const normalize = (value: unknown, workspace: string): unknown => {
      const encoded = JSON.stringify(value).replaceAll(workspace, '<workspace>');
      const data = JSON.parse(encoded);
      if (Array.isArray(data)) return data.map(item => {
        if (item.type === 'approval') item.id = '<approval>';
        if (item.parts) item.parts = JSON.parse(item.parts.join(''));
        if (item.arguments) item.arguments = JSON.parse(item.arguments);
        return item;
      });
      return data;
    };
    assert.deepEqual(normalize(events, root), normalize(reference.events, reference.root));
    assert.deepEqual(normalize(requests, root), normalize(reference.requests, reference.root));
    assert.deepEqual(normalize(harness.state.memory, root), normalize(reference.memory, reference.root));
  });
}

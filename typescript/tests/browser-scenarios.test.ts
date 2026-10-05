import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserHarness } from '../src/browser/harness.js';
import { BrowserStorage } from '../src/browser/storage.js';
import { NodeHarness } from '../src/node/harness.js';
import { turnAction } from '../src/transport.js';
import type { CoreEvent, ModelChunk, ModelRequest } from '../src/core.js';

for (const file of readdirSync('tests/scenarios').filter(name => name.endsWith('.json') && name !== 'command_output.json').sort()) {
  test(`browser/Node shared contract: ${file}`, async t => {
    const scenario = JSON.parse(readFileSync(path.join('tests/scenarios', file), 'utf8'));
    const root = await mkdtemp(path.join(tmpdir(), 'myharness-browser-parity-')); t.after(() => rm(root, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(scenario.files ?? {})) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), String(text)); }
    const requests: ModelRequest[][] = [[], []];
    const model = (index: number) => { const turns = structuredClone(scenario.model_turns) as ModelChunk[][]; return { async *streamChat(payload: ModelRequest) { requests[index]!.push(structuredClone(payload)); for (const chunk of turns.shift()!) yield JSON.stringify(chunk); } }; };
    const node = new NodeHarness({ workspace: root, projectRoot: root, model: 'qwen3:8b', contextLength: 3000, ollama: model(0) });
    const storage = await BrowserStorage.open('parity', new IDBFactory()); t.after(() => storage.close());
    const browser = await BrowserHarness.open({ storage, library: { agents: {}, prompts: {}, skills: {} }, seed: scenario.files ?? {}, model: 'qwen3:8b', contextLength: 3000, modelPort: model(1) });
    const events: CoreEvent[][] = [[], []];
    for (const [index, backend] of [node, browser].entries()) {
      for await (const event of backend.submit(turnAction(scenario.request, true))) {
        events[index]!.push(event);
        if (event.type === 'approval') { if (scenario.approval === 'stop') backend.stop(); else backend.approve(String(event.id), scenario.approval === 'approve'); }
      }
      assert.deepEqual(events[index]!.map(event => event.type), scenario.expect.event_types);
      assert.deepEqual(backend.inspect().memory.map(message => message.role), scenario.expect.memory_roles);
    }
    const normalize = (value: unknown, workspace: string): unknown => JSON.parse(JSON.stringify(value).replaceAll(workspace, '<workspace>'), (key, item: unknown) => key === 'id' ? '<approval>' : item);
    assert.deepEqual(normalize(events[1], '/workspace'), normalize(events[0], root));
    assert.deepEqual(normalize(requests[1], '/workspace'), normalize(requests[0], root));
    assert.deepEqual(normalize(browser.inspect().memory, '/workspace'), normalize(node.inspect().memory, root));
    for (const [name, text] of Object.entries(scenario.expect.files ?? {})) assert.equal((await browser.exportProject()).files[name], text);
  });
}

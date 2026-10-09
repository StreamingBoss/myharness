import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserHarness } from '../src/browser/harness.js';
import { MemoryStorage } from '../src/browser/storage.js';
import { BrowserWorkspace } from '../src/browser/workspace.js';

test('restored session exposes saved harness details despite unavailable live workspace and model metadata', async t => {
  const storage = new MemoryStorage();
  const library = { prompts: { archived: 'Saved system instructions' }, agents: { archived: 'tools: read_file\n---\nSaved agent instructions' }, skills: { archived: 'Saved skill instructions' } };
  let descriptionCalls = 0;
  const modelPort = {
    async *streamChat() { yield JSON.stringify({ message: { content: 'reply' }, done: true }); },
    async request() { descriptionCalls++; throw new Error('PRIVATE provider response'); },
  };
  const original = await BrowserHarness.open({ storage, library, seed: { 'AGENTS.md': 'Saved project instructions' }, model: 'qwen-test', modelPort });
  const action = { message: 'hello', useMemory: true, tools: ['read_file', 'use_skill'], askApproval: true, agent: 'archived', prompt: 'archived' };
  for await (const _event of original.submit(action)) { /* Save setup and conversation. */ }
  const exported = original.activeSessionRecord();
  const restored = await BrowserHarness.open({ storage: new MemoryStorage(), library: { agents: {}, skills: {}, prompts: {} }, seed: {}, model: 'qwen-test', modelPort });
  t.after(() => original.close()); t.after(() => restored.close());
  const imported = await restored.importSession(exported); await restored.activateSession(imported.id);
  t.mock.method(BrowserWorkspace.prototype, 'refresh', async () => { throw new Error('PRIVATE workspace failure'); });
  const details = await restored.explore({ ...action, prompt: '', agent: '' });
  assert.equal(details.system_prompt, 'Saved system instructions');
  assert.equal((details.agent as { prompt: string }).prompt, 'Saved agent instructions');
  assert.equal((details.skills as { body: string }[])[0]!.body, 'Saved skill instructions');
  assert.match(String(details.tools), /read_file/);
  assert.match(String(details.final), /Saved system instructions/);
  assert.match(String(details.template), /Model template unavailable/);
  assert.equal((details.warnings as string[]).length, 2);
  assert.ok(!JSON.stringify(details).includes('PRIVATE'));
  const before = descriptionCalls;
  const localDetails = await restored.explore({ ...action, prompt: '', agent: '' }, false);
  assert.equal(descriptionCalls, before);
  assert.equal(localDetails.system_prompt, details.system_prompt);
  assert.equal((localDetails.warnings as string[]).length, 1);
  assert.match(String(localDetails.template), /not requested/);
});

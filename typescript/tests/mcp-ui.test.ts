import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';
import { STDIO_SERVER } from './mcp-fixture.js';

test('the UI offers MCP tools, renders an MCP approval and result, explores servers and replays the call', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-mcp-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [STDIO_SERVER], env: { MCP_FIXTURE: JSON.stringify({ instructions: 'Echo politely.', prompts: [{ name: 'review', arguments: [{ name: 'topic', required: true }] }] }) } } } }));
  let turn = 0;
  const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 8192, mcpConfigFile: config, sessions: new SessionStore(path.join(root, 'sessions')), ollama: {
    async *streamChat() { yield JSON.stringify({ message: ++turn === 1 ? { tool_calls: [{ function: { name: 'mcp__files__echo', arguments: { text: 'from the UI' } } }] } : { content: 'MCP done' }, done: true }); },
    async request() { return {}; },
  } });
  await harness.initialize(); t.after(() => harness.close());
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length === 11);

  assert.equal(await page.locator('.mcp-group').innerText(), 'MCP files:');
  const checkbox = page.locator('input.tool-checkbox[value="mcp__files__echo"]');
  assert.equal(await checkbox.isChecked(), false);
  await checkbox.check();
  await page.locator('#input').fill('echo something'); await page.locator('#send').click();
  await page.getByText("MCP tool echo on server 'files' wants to run with these arguments:").waitFor();
  assert.match(await page.locator('.change').last().innerText(), /server hints, not verified by the harness: readOnlyHint=true/);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('MCP done', { exact: true }).first().waitFor();
  assert.match(await page.locator('.change').last().innerText(), /echo: from the UI[\s\S]*ran/);
  assert.match(await page.locator('#terminal').innerText(), /MCP — files\/echo over stdio, protocol 2026-07-28[\s\S]*"method": "tools\/call"/);
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);

  await page.locator('#explore-view').selectOption('mcp');
  await page.getByText('== files — connected (stdio)', { exact: false }).waitFor();
  const explored = await page.locator('#explore').innerText();
  assert.match(explored, /instructions \(added to the system message when its tools are checked\):\n {2}Echo politely\./);
  assert.match(explored, /prompt \/mcp__files__review <topic>/);
  assert.match(explored, /wire log:/);
  await page.locator('#mcp-reload').click();
  await page.waitForFunction(() => !(document.querySelector('#mcp-reload') as HTMLButtonElement).disabled && document.querySelectorAll('.tool-checkbox').length === 11);

  await page.reload(); await page.getByText('MCP done', { exact: true }).first().waitFor();
  assert.match(await page.locator('#terminal').innerText(), /MCP — files\/echo over stdio/);
  assert.equal(await page.locator('input.tool-checkbox[value="mcp__files__echo"]').isChecked(), true);
  assert.deepEqual(errors, []);
});

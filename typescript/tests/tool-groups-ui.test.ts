import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';
import { characters, json } from '../src/format.js';
import { TOOLS } from '../src/tools.js';
import { STDIO_SERVER } from './mcp-fixture.js';

test('every tool group has a group checkbox and folds into a drop-down', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-tool-groups-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'mcp.json');
  const tools = Array.from({ length: 10 }, (_, index) => ({ name: `tool${index}`, description: `Tool ${index}`, inputSchema: { type: 'object', properties: {} } }));
  await writeFile(config, JSON.stringify({ mcpServers: { many: { command: process.execPath, args: [STDIO_SERVER], env: { MCP_FIXTURE: JSON.stringify({ tools }) } } } }));
  const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 8192, mcpConfigFile: config, sessions: new SessionStore(path.join(root, 'sessions')), ollama: {
    async *streamChat() { yield JSON.stringify({ message: { content: 'ok' }, done: true }); },
    async request() { return {}; },
  } });
  await harness.initialize(); t.after(() => harness.close());
  // Costs come from the callable backend, including each complete parameter schema.
  const catalog = (await harness.bootstrap()).tools as { name: string; tokens: number; tokens_estimated: boolean }[];
  for (const definition of TOOLS.filter(tool => catalog.some(item => item.name === tool.function.name))) {
    const item = catalog.find(item => item.name === definition.function.name)!;
    assert.equal(item.tokens, Math.ceil(characters(json(definition)) / 4));
    assert.equal(item.tokens_estimated, true);
  }
  for (const definition of tools) {
    const item = catalog.find(item => item.name === `mcp__many__${definition.name}`)!;
    assert.ok(item.tokens > Math.ceil(definition.description.length / 4));
    assert.equal(item.tokens_estimated, true);
  }
  const costs = tools.map(tool => catalog.find(item => item.name === `mcp__many__${tool.name}`)!.tokens);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const server = createHarnessServer(harness); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ executablePath: process.env.MYHARNESS_TEST_CHROMIUM ?? chromium.executablePath(), headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelector('input.tool-checkbox[value="mcp__many__tool9"]') !== null);

  const many = page.locator('.tool-family').filter({ has: page.locator('legend', { hasText: 'MCP many:' }) });
  const group = many.locator('.tool-group-checkbox'), tool = (n: number) => many.locator(`input[value="mcp__many__tool${n}"]`);
  assert.equal(await many.locator('details.tool-menu').getAttribute('open'), null);
  assert.equal(await tool(0).isVisible(), false);
  assert.equal(await many.locator('summary').innerText(), '0 of 10 tools ticked');
  assert.equal(await group.isChecked(), false);
  assert.equal(await many.locator('.tool-group-cost').innerText(), `≈0 / ≈${total} tokens`);
  // built-in groups fold too and start fully ticked
  const files = page.locator('.tool-family').filter({ has: page.locator('legend', { hasText: 'Files' }) });
  assert.equal(await files.locator('details').count(), 1);
  assert.equal(await files.locator('input[value="read_file"]').isVisible(), false);
  assert.equal(await files.locator('.tool-group-checkbox').isChecked(), true);

  await group.check();
  assert.equal(await many.locator('summary').innerText(), '10 of 10 tools ticked');
  assert.equal(await many.locator('.tool-group-cost').innerText(), `≈${total} / ≈${total} tokens`);
  await many.locator('summary').click();
  assert.match((await tool(0).getAttribute('title'))!, new RegExp(`costs ≈${costs[0]} tokens`));
  assert.match((await tool(0).locator('..').getAttribute('title'))!, /context cost/);
  assert.equal(await tool(9).isChecked(), true);
  await tool(3).uncheck();
  assert.equal(await group.evaluate((box: HTMLInputElement) => box.indeterminate), true);
  assert.equal(await many.locator('summary').innerText(), '9 of 10 tools ticked');
  assert.equal(await many.locator('.tool-group-cost').innerText(), `≈${total - costs[3]!} / ≈${total} tokens`);
  await group.check(); // a partly ticked group ticks everything first
  assert.equal(await tool(3).isChecked(), true);
  await group.uncheck();
  assert.equal(await tool(0).isChecked(), false);
  await tool(0).check(); await tool(1).check();
  assert.equal(await many.locator('summary').innerText(), '2 of 10 tools ticked');

  // turning Tools off disables the group boxes too
  await page.locator('#use-tools').uncheck();
  assert.equal(await group.isDisabled(), true);
  assert.equal(await many.locator('.tool-group-cost').innerText(), `≈0 / ≈${total} tokens`);
  await page.locator('#use-tools').check();
  assert.equal(await group.isDisabled(), false);
  assert.equal(await many.locator('.tool-group-cost').innerText(), `≈${costs[0]! + costs[1]!} / ≈${total} tokens`);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('input.tool-checkbox[value="mcp__many__tool9"]') !== null);
  assert.equal(await many.locator('.tool-group-cost').innerText(), `≈${costs[0]! + costs[1]!} / ≈${total} tokens`);
  assert.deepEqual(errors, []);
});

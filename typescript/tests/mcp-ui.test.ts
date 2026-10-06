import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { NodeHarness } from '../src/node/harness.js';
import { SessionStore } from '../src/node/sessions.js';
import { createHarnessServer } from '../src/node/http.js';
import { FixtureServer, STDIO_SERVER, fixtureFetch } from './mcp-fixture.js';

test('the UI offers MCP tools, renders an MCP approval and result, explores servers and replays the call', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-mcp-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [STDIO_SERVER], env: { MCP_FIXTURE: JSON.stringify({ instructions: 'Echo politely.', prompts: [{ name: 'review', arguments: [{ name: 'topic', required: true }] }] }) } } } }));
  // The backend's fetch: a scripted registry and a remote MCP server for the preview.
  const remote = fixtureFetch(new FixtureServer({ instructions: 'Remote preview hints.' })), registryQueries: string[] = [];
  let requireAuth = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: Parameters<typeof remote>[1]) => {
    if (!url.startsWith('https://api.mcp.github.com/') && !url.startsWith('https://registry.modelcontextprotocol.io/')) {
      if (requireAuth && init.headers.Authorization !== 'Bearer ui-secret') return new Response('missing required Authorization header', { status: 401 });
      return remote(url, init);
    }
    const query = new URL(url).searchParams; registryQueries.push(new URL(url).host.split('.')[0] + ' ' + query.toString());
    const servers = query.get('cursor')
      ? [{ server: { name: 'io.example/second', description: 'Second page', version: '1.0.0', packages: [{ registryType: 'npm', identifier: '@example/second', version: '1.0.0', transport: { type: 'stdio' }, environmentVariables: [{ name: 'SECOND_KEY', isRequired: true, isSecret: true }] }] } }]
      : [{ server: { name: 'io.example/weather', title: 'Weather <img src=x onerror="window.injected=1">', description: 'Forecasts', version: '2.0.0', remotes: [{ type: 'streamable-http', url: 'http://remote.test/mcp' }] } }];
    return new Response(JSON.stringify({ servers, metadata: query.get('cursor') ? {} : { nextCursor: 'io.example/weather:2.0.0' } }));
  });
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
  await page.goto(`http://127.0.0.1:${address.port}`); await page.waitForFunction(() => document.querySelector('input.tool-checkbox[value="mcp__files__echo"]') !== null);

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
  await page.waitForFunction(() => !(document.querySelector('#mcp-reload') as HTMLButtonElement).disabled && document.querySelector('input.tool-checkbox[value="mcp__files__echo"]') !== null);

  await page.locator('#mcp-find').click();
  await page.getByText('Weather <img src=x onerror="window.injected=1"> 2.0.0').waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { injected?: number }).injected), undefined);
  await page.getByRole('button', { name: 'Preview tools' }).click();
  await page.getByText('== preview — connected (http)', { exact: false }).waitFor();
  assert.match(await page.locator('.registry-option pre').first().innerText(), /tool mcp__preview__echo: Echo the text back[\s\S]*Remote preview hints\./);
  requireAuth = true;
  await page.getByRole('button', { name: 'Preview tools' }).click();
  await page.getByText('Authorization required:', { exact: false }).waitFor();
  const auth = page.getByLabel('Authorization header (optional)');
  assert.equal(await auth.getAttribute('type'), 'password');
  await auth.fill('Bearer ui-secret');
  await page.getByRole('button', { name: 'Preview tools' }).click();
  await page.getByText('== preview — connected (http)', { exact: false }).waitFor();
  assert.equal(await auth.inputValue(), '');
  assert.ok(!(await page.locator('.registry-option pre').first().innerText()).includes('ui-secret'));
  await page.getByRole('button', { name: 'Show configuration' }).click();
  assert.deepEqual(JSON.parse((await page.locator('.registry-option pre').first().innerText()).trim()), { mcpServers: { weather: { url: 'http://remote.test/mcp' } } });
  const editor = page.getByLabel('MCP configuration to add');
  assert.equal(await editor.isVisible(), true);
  const originalSnippet = await editor.inputValue();
  await editor.fill('{');
  await page.getByRole('button', { name: 'Add to harness', exact: true }).click();
  await page.getByText('Could not add MCP server:', { exact: false }).waitFor();
  await editor.fill(originalSnippet);
  const saveToken = page.getByLabel('Authorization header to save (optional)');
  await saveToken.fill('Bearer ui-secret');
  await page.getByRole('button', { name: 'Add to harness', exact: true }).click();
  await page.getByRole('button', { name: 'Added', exact: true }).waitFor();
  assert.equal(await saveToken.inputValue(), '');
  const saved = JSON.parse(await readFile(config, 'utf8'));
  assert.ok(saved.mcpServers.files.command);
  assert.deepEqual(saved.mcpServers.weather, { url: 'http://remote.test/mcp', headers: { Authorization: 'Bearer ui-secret' } });
  assert.equal(await page.locator('input.tool-checkbox[value="mcp__weather__echo"]').count(), 1);
  await page.locator('#mcp-registry-more').click();
  await page.getByText('io.example/second', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Show configuration' }).last().click();
  assert.match(await page.locator('.registry-option pre').last().innerText(), /"command": "npx"[\s\S]*"SECOND_KEY": "\$\{SECOND_KEY\}"[\s\S]*• Set SECOND_KEY, a secret, in your environment\.[\s\S]*Registry entries are not reviewed\./);
  await page.locator('#mcp-registry-search').fill('weather'); await page.locator('#mcp-registry-go').click();
  await page.waitForFunction(() => document.querySelectorAll('.registry-server').length === 1);
  await page.locator('#mcp-registry-source').selectOption('official');
  await page.waitForFunction(() => document.querySelectorAll('.registry-server').length === 1);
  assert.deepEqual(registryQueries, ['api limit=20', 'api limit=20&cursor=io.example%2Fweather%3A2.0.0', 'api limit=20&search=weather', 'registry version=latest&limit=20&search=weather']);
  await page.locator('#mcp-registry-close').click();
  assert.equal(await page.locator('#mcp-registry').isVisible(), false);
  assert.equal((harness.mcpStatus().servers as unknown[]).length, 2); // only Add persists a server

  await page.reload(); await page.getByText('MCP done', { exact: true }).first().waitFor();
  assert.match(await page.locator('#terminal').innerText(), /MCP — files\/echo over stdio/);
  assert.equal(await page.locator('input.tool-checkbox[value="mcp__files__echo"]').isChecked(), true);
  assert.deepEqual(errors, []);
});

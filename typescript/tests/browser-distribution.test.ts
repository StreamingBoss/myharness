import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { DemoModel } from '../src/browser/demo.js';
import type { ModelRequest } from '../src/core.js';
import { FixtureServer } from './mcp-fixture.js';
import { real, repository } from './git-helpers.js';

async function staticServer(t: { after(callback: () => unknown): void }) {
  const child = spawn(process.execPath, ['scripts/serve-browser.mjs'], { env: { ...process.env, MYHARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); });
  const base = await new Promise<string>((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Static server did not start: ' + output)), 10000);
    child.stdout.on('data', chunk => { output += String(chunk); const match = output.match(/http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error('Static server exited: ' + code)); });
  });
  return { base, child };
}
async function send(page: Page, message: string) {
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  await page.locator('#input').fill(message); await page.locator('#send').click();
}
async function ready(page: Page) { await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length === 12); }

test('browser MCP edits and imports print their storage location and saved content in the static server terminal', async t => {
  const { base, child } = await staticServer(t);
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(base + '/?database=mcp-terminal-debug');
  await ready(page);
  await page.locator('#explore-view').selectOption('mcp');
  await page.waitForFunction(() => (document.querySelector('#mcp-config-text') as HTMLTextAreaElement).value.includes('mcpServers'));
  const config = { mcpServers: { github: { disabled: true, url: 'https://example.test/mcp', headers: { Authorization: 'Bearer terminal-debug' } } } };
  await page.locator('#mcp-config-text').fill(JSON.stringify(config));
  await page.locator('#mcp-config-save').click();
  await page.waitForFunction(() => !(document.querySelector('#mcp-config-save') as HTMLButtonElement).disabled);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No saved MCP config was printed: ' + output)), 5000);
    const check = () => { if (output.includes('Bearer terminal-debug')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', check); check();
  });
  assert.match(output, /IndexedDB mcp-terminal-debug \/ settings \/ mcp-config/);
  assert.match(output, /MCP configuration content:/);
  const imported = { mcpServers: { github: { disabled: true, headers: { Authorization: 'Bearer imported-debug' } } } };
  await page.locator('#browser-mcp-config').setInputFiles({ name: 'mcp.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No imported MCP config was printed: ' + output)), 5000);
    const check = () => { if (output.includes('Bearer imported-debug')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', check); check();
  });
  assert.match(await page.locator('#mcp-config-source').innerText(), /browser storage/);
});

test('static browser distribution runs the backend in a Worker, saves sessions/files and works after the server stops', async t => {
  const { base, child } = await staticServer(t);
  assert.equal((await fetch(base + '/chat', { method: 'POST' })).status, 404);
  assert.equal((await fetch(base + '/missing')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e%2fpackage.json')).status, 404);
  assert.match(await (await fetch(base + '/README.txt')).text(), /static files only/);
  assert.equal((await fetch(base + '/backend-worker.js.map')).status, 200);
  const manifest = JSON.parse(await readFile('dist/browser/build-manifest.json', 'utf8')) as { inputs: Record<string, unknown> };
  assert.equal(Object.keys(manifest.inputs).some(input => input.includes('/src/node/')), false);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage(), errors: string[] = [], requests: string[] = [];
  await page.context().route('http://localhost:11434/api/tags', route => route.fulfill({ json: { models: [{ name: 'qwen3:8b' }] } }));
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
  await page.goto(base + '/?database=distribution'); await ready(page);
  assert.equal(await page.locator('#browser-model-mode').inputValue(), 'ollama');
  assert.equal(await page.locator('#browser-model-mode option[value=demo], #browser-examples').count(), 0);
  assert.equal(await page.locator('#browser-context-limit').inputValue(), '8192');
  assert.equal(await page.getByText('How this version works', { exact: true }).count(), 0);
  assert.equal(await page.locator('#browser-token-budgets').isVisible(), false);
  await page.locator('#browser-model-mode').selectOption('gemini');
  assert.equal(await page.locator('#browser-token-budgets').isVisible(), true);
  await page.getByText('Harness token budgets', { exact: true }).click();
  assert.match(await page.locator('#browser-token-budgets').innerText(), /configured budgets.*not the model’s advertised limits/);
  assert.equal(await page.locator('#browser-context-limit').inputValue(), '8192');
  assert.equal(await page.locator('#browser-output-limit').inputValue(), '2048');
  await page.locator('#browser-model-mode').selectOption('ollama');
  assert.equal(await page.locator('#browser-api-key').isVisible(), false);
  assert.equal(await page.locator('#browser-model').evaluate(element => element.tagName), 'SELECT');
  await page.waitForFunction(() => !(document.querySelector('#browser-model') as HTMLSelectElement).disabled);
  assert.equal(await page.locator('#browser-model').inputValue(), 'qwen3:8b');
  await page.locator('#browser-model-mode').selectOption('openai');
  assert.equal(await page.locator('#browser-api-key').isVisible(), true);
  assert.equal(await page.locator('#browser-ollama-url').isVisible(), false);
  await page.waitForFunction(() => document.getElementById('browser-runtime-status')!.textContent!.includes('API key'));
  await page.context().route('https://api.openai.com/v1/models', route => route.fulfill({ json: { data: [{ id: 'gpt-test' }, { id: 'text-embedding' }] } }));
  await page.locator('#browser-api-key').fill('test-key'); await page.locator('#browser-api-key').press('Tab');
  await page.waitForFunction(() => !(document.querySelector('#browser-model') as HTMLSelectElement).disabled);
  assert.deepEqual(await page.locator('#browser-model option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ['gpt-test']);
  // A test-only scripted server exercises the real Ollama adapter without live inference.
  const model = new DemoModel();
  const ollama = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', base);
    response.setHeader('access-control-allow-headers', 'content-type');
    if (request.method === 'OPTIONS') { response.end(); return; }
    if (request.url === '/api/tags') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'small:4b' }] })); return; }
    let body = ''; for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body);
    if (request.url === '/api/show') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ template: 'Test model', model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 4096 } })); return;
    }
    if (request.url === '/api/chat') {
      response.setHeader('content-type', 'application/x-ndjson');
      for await (const chunk of model.streamChat(payload as ModelRequest)) response.write(chunk + '\n');
      response.end(); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => ollama.listen(0, '127.0.0.1', resolve)); t.after(() => ollama.close());
  const address = ollama.address(); assert.ok(address && typeof address !== 'string');
  const modelURL = `http://127.0.0.1:${address.port}`;
  await page.locator('#browser-model-mode').selectOption('ollama');
  assert.equal(await page.locator('#browser-token-budgets').isVisible(), false);
  await page.locator('#browser-ollama-url').fill(modelURL); await page.locator('#browser-ollama-url').press('Tab');
  await page.waitForFunction(() => document.querySelector('#browser-model option[value="small:4b"]'));
  await page.locator('#browser-model').selectOption('small:4b');
  assert.equal(await page.getByRole('button', { name: 'New Session', exact: true }).count(), 1);
  assert.equal(await page.locator('#session-bar #new-session').isVisible(), true);
  assert.equal(await page.locator('#browser-runtime #new-session').count(), 0);
  await page.locator('#new-session').click();
  await page.waitForFunction(() => document.getElementById('browser-runtime-status')!.textContent === '');
  const configuredSession = await page.locator('#session-select').inputValue();
  const sessionCount = await page.locator('#session-select option').count();
  await page.getByRole('button', { name: 'New Session', exact: true }).click();
  await page.waitForFunction(id => (document.getElementById('session-select') as HTMLSelectElement).value !== id, configuredSession);
  assert.equal(await page.locator('#session-select option').count(), sessionCount + 1);
  assert.equal(await page.locator('#session-select option').evaluateAll((options, id) => options.some(option => (option as HTMLOptionElement).value === id), configuredSession), true);
  await page.reload(); await ready(page);
  await page.waitForFunction(() => !(document.querySelector('#browser-model') as HTMLSelectElement).disabled);
  assert.equal(await page.locator('#browser-model').inputValue(), 'small:4b');
  assert.equal(page.workers().length, 1); assert.match(await page.locator('#browser-mode-label').innerText(), /ollama/i);
  const offered = await page.locator('.tool-checkbox').evaluateAll(boxes => boxes.map(box => (box as HTMLInputElement).value));
  assert.equal(offered.length, 12); for (const hidden of ['run_command', 'web_search', 'git_status', 'git_commit']) assert.equal(offered.includes(hidden), false); assert.ok(offered.includes('delete_file'));
  // MCP from the Worker: a CORS-enabled Streamable HTTP server; stdio is reported unsupported.
  const fixture = new FixtureServer({ instructions: 'Browser MCP hints.' });
  const mcp = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', base);
    response.setHeader('access-control-allow-headers', 'content-type, mcp-protocol-version, mcp-method, mcp-name, authorization');
    if (request.method === 'OPTIONS') { response.end(); return; }
    let body = ''; for await (const chunk of request) body += String(chunk);
    const reply = await fixture.handle(JSON.parse(body));
    if (!reply) { response.writeHead(202); response.end(); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(reply));
  });
  await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve)); t.after(() => mcp.close());
  const mcpAddress = mcp.address(); assert.ok(mcpAddress && typeof mcpAddress !== 'string');
  await page.locator('#browser-mcp-config').setInputFiles({ name: 'mcp.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ mcpServers: { web: { url: `http://127.0.0.1:${mcpAddress.port}/mcp`, headers: { authorization: 'Bearer browser' } }, local: { command: 'node' } } })) });
  await page.getByText('MCP: 1 of 2 servers connected.', { exact: false }).waitFor();
  await page.waitForFunction(() => document.querySelector('.tool-checkbox[value="mcp__web__echo"]'));
  assert.equal(await page.locator('.mcp-group').innerText(), 'MCP web:');
  await page.locator('#explore-view').selectOption('mcp');
  await page.locator('#mcp-server-details').evaluate(node => (node as HTMLDetailsElement).open = true);
  await page.getByText('== local — unsupported', { exact: false }).waitFor();
  assert.match(await page.locator('#mcp-server-status').innerText(), /== web — connected \(http\)[\s\S]*Browser MCP hints\./);
  await page.locator('#explore-view').selectOption('memory');
  // The imported configuration persists (without header values); clear it so later steps see the ten harness tools.
  await page.evaluate(() => (window as unknown as { harness: { call(action: string, payload: unknown): Promise<unknown> } }).harness.call('configureMcp', { mcpServers: {} }));
  await send(page, 'Remember 42'); await page.getByText('Received: 42.', { exact: false }).first().waitFor();
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  await page.locator('#explore-view').selectOption('tokens'); await page.waitForFunction(() => !(document.querySelector('#token-inspect') as HTMLButtonElement).disabled);
  await page.locator('#token-inspect').click(); await page.getByText('Token sequence unavailable', { exact: true }).waitFor();
  assert.match(await page.locator('#token-summary').innerText(), /No token pieces or IDs are shown/);
  assert.equal(await page.locator('.token-chip').count(), 0);
  await page.reload(); await ready(page); await send(page, 'What do you remember?'); await page.getByText('Remember 42', { exact: true }).last().waitFor();
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  await send(page, 'Write browser.txt: persisted'); await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  await page.reload(); await ready(page);
  assert.equal(await page.evaluate(async () => {
    const client = (window as unknown as { harness: { call(action: string): Promise<{ files: Record<string, string> }> } }).harness;
    return (await client.call('exportProject')).files['browser.txt'];
  }), 'persisted\n');
  assert.equal(await page.locator('#browser-export-project').count(), 0);
  assert.equal(await page.locator('#browser-project-json-picker, #browser-project-json').count(), 0);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export session', exact: true }).click();
  const sessionJSON = await readFile((await (await download).path())!, 'utf8');
  assert.match(sessionJSON, /Remember 42/);
  assert.equal(JSON.parse(sessionJSON).workspace, '/workspace');
  const originalEvents = JSON.parse(sessionJSON).events;
  const restoredPage = await browser.newPage(); await restoredPage.goto(base + '/?database=restored-session'); await ready(restoredPage);
  const chooser = restoredPage.waitForEvent('filechooser');
  await restoredPage.getByRole('button', { name: 'Import Session', exact: true }).click();
  await (await chooser).setFiles({ name: 'session.json', mimeType: 'application/json', buffer: Buffer.from(sessionJSON) });
  await restoredPage.waitForFunction(() => document.getElementById('session-status')!.textContent === 'imported');
  const importedId = await restoredPage.evaluate(async name => {
    const client = (window as unknown as { harness: { call(action: string): Promise<{ sessions: { id: string; name: string }[] }> } }).harness;
    return (await client.call('sessions')).sessions.find(session => session.name === `${name} (imported)`)!.id;
  }, JSON.parse(sessionJSON).name);
  await restoredPage.locator('#session-select').selectOption(importedId);
  await restoredPage.locator('#load-session').click();
  await restoredPage.waitForEvent('load'); await ready(restoredPage);
  await restoredPage.getByText('Remember 42', { exact: true }).last().waitFor();
  assert.deepEqual(await restoredPage.evaluate(async () => {
    const client = (window as unknown as { harness: { call(action: string): Promise<{ session: { events: unknown[] } }> } }).harness;
    return (await client.call('bootstrap')).session.events;
  }), originalEvents);
  await restoredPage.close();
  assert.equal(requests.some(url => url.startsWith(base + '/') && /\/(chat|bootstrap|sessions|approve)(\?|$|\/)/.test(url)), false);
  const headless = await browser.newPage(); await headless.goto(base + '/headless.html?database=headless');
  await headless.waitForFunction(() => Boolean((window as unknown as { harness: unknown }).harness));
  assert.equal(await headless.locator('#input').count(), 0);
  await headless.evaluate(url => (window as unknown as { harness: { call(action: string, payload: unknown): Promise<unknown> } }).harness.call('configureModel', { provider: 'ollama', url }), modelURL);
  const headlessEvents = await headless.evaluate(async () => {
    const client = (window as unknown as { harness: { stream(action: string, payload: unknown): AsyncIterable<{ type: string }> } }).harness, events: string[] = [];
    for await (const event of client.stream('chat', { message: 'List files', tools: ['list_files'], use_memory: true, ask_approval: true, agent: '', prompt: '' })) events.push(event.type);
    return events;
  }); assert.ok(headlessEvents.includes('tool'));
  child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
  await send(page, 'Read browser.txt'); await page.getByText('persisted', { exact: false }).last().waitFor();
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  assert.deepEqual(errors, []);
});

test('browser Worker connects to Ollama and reads/edits native filesystem handles with approval and reload persistence', async t => {
  const { base } = await staticServer(t), requests: { messages?: { role: string; content: string }[] }[] = [];
  const ollama = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', base); response.setHeader('access-control-allow-headers', 'content-type');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.url === '/api/tags') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })); return; }
    let text = ''; for await (const chunk of request) text += String(chunk);
    const data = JSON.parse(text); response.setHeader('content-type', 'application/json');
    if (request.url === '/api/show') { response.end(JSON.stringify({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 4096 } })); return; }
    requests.push(data);
    const message = data.messages.at(-1)?.role === 'tool' ? { content: 'Local code updated through the browser harness' } : { tool_calls: [{ function: { name: 'edit_file', arguments: { path: 'main.py', old_text: 'hello', new_text: 'updated' } } }] };
    response.end(JSON.stringify({ message, done: true, prompt_eval_count: 100, eval_count: 10 }) + '\n');
  });
  await new Promise<void>(resolve => ollama.listen(0, '127.0.0.1', resolve)); t.after(() => ollama.close());
  const address = ollama.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'], ...(process.env.MYHARNESS_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MYHARNESS_CHROMIUM_EXECUTABLE } : {}) }); t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ['local-network-access'] });
  await context.route('http://localhost:11434/api/tags', route => route.fulfill({ json: { models: [{ name: 'qwen3:8b' }] } }));
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // Native OPFS handles exercise Worker structured cloning and IndexedDB handle storage.
  // The operating-system picker itself requires a user's gesture and manual selection.
  await page.addInitScript(() => { (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory(), folder = await root.getDirectoryHandle('local-code', { create: true });
    const file = await folder.getFileHandle('main.py', { create: true }), current = await file.getFile();
    if (!current.size) { const stream = await file.createWritable(); await stream.write('print("hello")\n'); await stream.close(); }
    return folder;
  }; });
  await page.goto(base + '/?database=local'); await ready(page);
  await Promise.all([page.waitForEvent('load'), page.locator('#browser-local-folder').click()]); await ready(page);
  assert.match(await page.locator('#browser-mode-label').innerText(), /direct disk access/);
  await page.locator('#browser-model-mode').selectOption('ollama'); await page.locator('#browser-ollama-url').fill('http://127.0.0.1:' + address.port);
  await page.locator('#browser-ollama-url').press('Tab');
  await page.waitForFunction(() => !(document.querySelector('#browser-model') as HTMLSelectElement).disabled);
  await page.locator('#new-session').click(); await page.waitForFunction(() => document.querySelector('#browser-mode-label')?.textContent?.includes('Real model')); await ready(page);
  assert.match(await page.locator('#browser-mode-label').innerText(), /Real model/);
  await send(page, 'Edit my local code'); await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  const disk = () => page.evaluate(async () => { const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('local-code'); return (await (await folder.getFileHandle('main.py')).getFile()).text(); });
  assert.equal(await disk(), 'print("hello")\n'); await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('Local code updated through the browser harness', { exact: true }).first().waitFor(); assert.equal(await disk(), 'print("updated")\n');
  assert.ok(requests.some(request => request.messages?.some(message => message.role === 'tool' && message.content.includes('main.py'))));
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled); await page.reload(); await ready(page);
  assert.match(await page.locator('#browser-mode-label').innerText(), /Real model.*direct disk access/); assert.equal(await disk(), 'print("updated")\n');
  assert.equal(await page.locator('#browser-ollama-url').inputValue(), 'http://127.0.0.1:' + address.port);
  assert.deepEqual(errors, []);
});

test('the packaged browser Worker commits to a real repository in a native folder, and real git reads the result', async t => {
  const { base } = await staticServer(t), repo = await repository(t); real(repo, 'config', 'user.name', 'Packaged'); real(repo, 'config', 'user.email', 'p@example.org');
  await writeFile(path.join(repo, 'a.txt'), 'edited in the folder\n');
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix = ''): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const name = prefix + entry.name; if (entry.isDirectory()) await walk(path.join(dir, entry.name), name + '/'); else files[name] = (await readFile(path.join(dir, entry.name))).toString('base64'); } };
  await walk(repo);
  const ollama = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', base); response.setHeader('access-control-allow-headers', 'content-type');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.url === '/api/tags') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })); return; }
    let text = ''; for await (const chunk of request) text += String(chunk);
    const data = JSON.parse(text); response.setHeader('content-type', 'application/json');
    if (request.url === '/api/show') { response.end(JSON.stringify({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 32768 } })); return; }
    const names = (data.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
    const message = data.messages.at(-1)?.role === 'tool' ? { content: `Committed. git tools offered: ${names.includes('git_commit')}, run_command offered: ${names.includes('run_command')}` } : { tool_calls: [{ function: { name: 'git_commit', arguments: { message: 'packaged commit' } } }] };
    response.end(JSON.stringify({ message, done: true, prompt_eval_count: 100, eval_count: 10 }) + '\n');
  });
  await new Promise<void>(resolve => ollama.listen(0, '127.0.0.1', resolve)); t.after(() => ollama.close());
  const address = ollama.address(); assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'], ...(process.env.MYHARNESS_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MYHARNESS_CHROMIUM_EXECUTABLE } : {}) }); t.after(() => browser.close());
  const context = await browser.newContext({ permissions: ['local-network-access'] });
  await context.route('http://localhost:11434/api/tags', route => route.fulfill({ json: { models: [{ name: 'qwen3:8b' }] } }));
  const page = await context.newPage(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // The repository made by real git is copied into browser storage, which the picker then hands to the page.
  await page.goto(base + '/?database=git'); await page.evaluate(async (copy: Record<string, string>) => {
    const root = await navigator.storage.getDirectory(), folder = await root.getDirectoryHandle('git-code', { create: true });
    for (const [name, data] of Object.entries(copy)) {
      let dir = folder; const parts = name.split('/');
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const stream = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable(); await stream.write(Uint8Array.from(atob(data), char => char.charCodeAt(0))); await stream.close();
    }
  }, files);
  await page.addInitScript(() => { (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('git-code'); });
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await Promise.all([page.waitForEvent('load'), page.locator('#browser-local-folder').click()]);
  await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  assert.match(await page.locator('#browser-mode-label').innerText(), /direct disk access/);
  const offered = await page.locator('.tool-checkbox').evaluateAll(boxes => boxes.map(box => (box as HTMLInputElement).value));
  assert.ok(offered.includes('git_commit') && offered.includes('delete_file')); assert.equal(offered.includes('run_command'), false); assert.equal(offered.includes('web_search'), false);
  await page.locator('#browser-model-mode').selectOption('ollama'); await page.locator('#browser-ollama-url').fill('http://127.0.0.1:' + address.port); await page.locator('#browser-ollama-url').press('Tab');
  await page.waitForFunction(() => !(document.querySelector('#browser-model') as HTMLSelectElement).disabled);
  await page.locator('#new-session').click(); await page.waitForFunction(() => document.querySelector('#browser-mode-label')?.textContent?.includes('Real model'));
  await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length > 0);
  await send(page, 'Commit my work');
  await page.locator('.change-title', { hasText: /git_commit wants to commit on main/ }).waitFor();
  assert.match(await page.locator('.change').last().innerText(), /Message: packaged commit[\s\S]*\+edited in the folder/);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByText('Committed. git tools offered: true, run_command offered: false', { exact: true }).first().waitFor();
  // Copy the folder back out and let real git judge what the browser wrote.
  const copy = await page.evaluate(async () => {
    const out: Record<string, string> = {};
    const walkHandle = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, entry] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (entry.kind === 'directory') await walkHandle(entry as FileSystemDirectoryHandle, prefix + name + '/');
        else { const bytes = new Uint8Array(await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer()); let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); out[prefix + name] = btoa(text); }
      }
    };
    await walkHandle(await (await navigator.storage.getDirectory()).getDirectoryHandle('git-code'), ''); return out;
  });
  const result = await mkdtemp(path.join(tmpdir(), 'myharness-packaged-git-')); t.after(() => rm(result, { recursive: true, force: true }));
  for (const [name, data] of Object.entries(copy)) { await mkdir(path.dirname(path.join(result, name)), { recursive: true }); await writeFile(path.join(result, name), Buffer.from(data, 'base64')); }
  assert.equal(real(result, 'log', '-1', '--format=%an|%s').trim(), 'Packaged|packaged commit'); assert.equal(real(result, 'show', 'HEAD:a.txt'), 'edited in the folder\n');
  assert.equal(real(result, 'status', '--porcelain'), ''); assert.equal(real(result, 'fsck', '--strict').trim(), '');
  assert.deepEqual(errors, []);
});

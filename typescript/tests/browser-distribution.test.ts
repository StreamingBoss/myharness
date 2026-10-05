import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { DemoModel } from '../src/browser/demo.js';
import type { ModelRequest } from '../src/core.js';

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
async function ready(page: Page) { await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length === 10); }

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
  await page.locator('#browser-ollama-url').fill(modelURL); await page.locator('#browser-ollama-url').press('Tab');
  await page.waitForFunction(() => document.querySelector('#browser-model option[value="small:4b"]'));
  await page.locator('#browser-model').selectOption('small:4b');
  await page.locator('#browser-connect').click();
  await page.waitForFunction(() => document.getElementById('browser-runtime-status')!.textContent === '');
  await page.reload(); await ready(page);
  await page.waitForFunction(() => !(document.querySelector('#browser-model') as HTMLSelectElement).disabled);
  assert.equal(await page.locator('#browser-model').inputValue(), 'small:4b');
  assert.equal(page.workers().length, 1); assert.match(await page.locator('#browser-mode-label').innerText(), /ollama/i);
  const command = page.locator('.tool-checkbox[data-supported="false"]'); assert.equal(await command.count(), 1); assert.equal(await command.isDisabled(), true);
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
  const download = page.waitForEvent('download'); await page.locator('#export-session').click(); assert.match(await readFile((await (await download).path())!, 'utf8'), /Remember 42/);
  assert.match((await page.locator('#browser-export-project').getAttribute('title'))!, /Full conversation history is included/);
  const projectDownload = page.waitForEvent('download'); await page.locator('#browser-export-project').click();
  const projectJSON = await readFile((await (await projectDownload).path())!, 'utf8');
  const project = JSON.parse(projectJSON);
  const originalEvents = project.sessions.find((session: { id: string }) => session.id === project.active_session_id).events;
  const restoredPage = await browser.newPage(); await restoredPage.goto(base + '/?database=restored-project'); await ready(restoredPage);
  await restoredPage.locator('#browser-project-json').setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(projectJSON) });
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
  await page.locator('#browser-connect').click(); await page.waitForFunction(() => document.querySelector('#browser-mode-label')?.textContent?.includes('Real model')); await ready(page);
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

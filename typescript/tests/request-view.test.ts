import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Script, createContext } from 'node:vm';
import { chromium, type Page } from 'playwright';
import { CloudAdapter } from '../src/cloud.js';
import type { CoreEvent } from '../src/core.js';
import { NodeHarness } from '../src/node/harness.js';
import { OllamaAdapter } from '../src/node/ollama.js';
import { SessionStore } from '../src/node/sessions.js';
import { call, completeEvent, response, sse } from './cloud.test.js';

/*
 * Rules these tests hold in place (see AGENTS.md):
 *  - The Request tab's "As sent" view is identical to the body that is posted to the model (Ollama or a cloud provider).
 *  - The "By section" view shows the same content as "As sent", differing only in form.
 */

type Message = Record<string, unknown>;
interface RequestViewClass {
  sentBody(event: unknown): Record<string, unknown> | null;
  harnessBody(event: unknown): Record<string, unknown> | null;
  sections(body: unknown): { system: Message[]; memory: Message[]; thisTurn: Message[]; tools: Message[] };
}

// The view script only defines classes at load time, so it runs here without a DOM.
function loadRequestView(): RequestViewClass {
  const context = createContext({});
  new Script(readFileSync('web/static/request-view.js', 'utf8')).runInContext(context);
  return (context as unknown as { RequestView: RequestViewClass }).RequestView;
}

// The view script runs in its own realm, so values are compared by content.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const requests = (events: CoreEvent[]) => events.filter(event => event.type === 'request');
const turn = (message: string) => ({ message, useMemory: true, tools: ['list_files', 'read_file'], askApproval: false, agent: '', prompt: '' });
async function workspace(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'myharness-request-view-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'README.md'), 'hello');
  return root;
}

// Every text the By section view shows must be present in the body that was posted.
function shownTexts(view: RequestViewClass, event: CoreEvent): string[] {
  const parts = view.sections(view.harnessBody(event)), texts: string[] = [];
  for (const message of [...parts.system, ...parts.memory, ...parts.thisTurn]) {
    if (typeof message.content === 'string' && message.content) texts.push(message.content);
    for (const toolCall of (message.tool_calls ?? []) as { function: { name: string; arguments: Record<string, unknown> } }[]) {
      texts.push(toolCall.function.name);
      for (const value of Object.values(toolCall.function.arguments)) if (typeof value === 'string') texts.push(value);
    }
  }
  for (const tool of parts.tools as unknown as { function: { name: string; description: string } }[]) texts.push(tool.function.name, tool.function.description);
  return texts;
}

for (const withProviderLabel of [false, true]) {
  test(`Ollama${withProviderLabel ? ' with the harness provider label' : ''}: "As sent" is identical to the posted body and "By section" holds the same content`, async t => {
    const view = loadRequestView(), root = await workspace(t), posted: string[] = [];
    const chunks = [
      { message: { role: 'assistant', content: '', thinking: 'plan: list the folder', tool_calls: [{ function: { name: 'list_files', arguments: { path: '.' } } }] }, done: true, prompt_eval_count: 10, eval_count: 5 },
      { message: { role: 'assistant', content: 'Here are the files.' }, done: true, prompt_eval_count: 20, eval_count: 6 },
    ];
    const adapter = new OllamaAdapter(async (url, init) => {
      if (url.endsWith('/api/chat')) posted.push(init.body ?? '');
      return new Response(JSON.stringify(chunks.shift()) + '\n') as never;
    }, 'http://ollama');
    const harness = new NodeHarness({ workspace: root, model: 'qwen3:8b', contextLength: 8192, ollama: adapter, ...(withProviderLabel ? { provider: 'ollama' as const } : {}), sessions: new SessionStore(path.join(root, 'sessions')) });
    await harness.initialize();
    const events: CoreEvent[] = [];
    for await (const event of harness.submit(turn('list the files'))) events.push(event);
    const sent = requests(events);
    assert.equal(sent.length, 2); assert.equal(posted.length, 2);
    assert.equal(JSON.parse(posted[1]!).messages.find((message: Message) => message.tool_calls).thinking, 'plan: list the folder');
    sent.forEach((event, index) => {
      // identical: the same JSON, field for field and in the same order, as what went over the wire
      assert.equal(JSON.stringify(view.sentBody(event)), posted[index]);
      // "provider" is the harness's own label and is never part of the body
      assert.equal('provider' in JSON.parse(posted[index]!), false);
      // By section: the same messages and tools, in the same order
      const parts = view.sections(view.harnessBody(event)), body = JSON.parse(posted[index]!);
      assert.deepEqual(plain([...parts.system, ...parts.memory, ...parts.thisTurn]), body.messages);
      assert.deepEqual(plain(parts.tools), body.tools ?? []);
      for (const text of shownTexts(view, event)) assert.ok(posted[index]!.includes(JSON.stringify(text).slice(1, -1)), text);
    });
  });
}

for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
  test(`${provider}: "As sent" is identical to the posted body and "By section" holds the same content`, async t => {
    const view = loadRequestView(), root = await workspace(t), posted: string[] = [];
    let first = true;
    const adapter = new CloudAdapter(provider, async (_url, init) => {
      if (init.method === 'GET') return Response.json({});
      posted.push(init.body!);
      const native = first ? response(provider, '', [call(provider, 'read', 'read_file', { path: 'README.md' })]) : response(provider, 'Done.');
      first = false;
      return sse(completeEvent(provider, native));
    }, 'SECRET');
    const harness = new NodeHarness({ workspace: root, model: 'test', contextLength: 8192, provider, maxOutputTokens: 2048, modelAdapter: adapter, sessions: new SessionStore(path.join(root, 'sessions')) });
    await harness.initialize();
    const events: CoreEvent[] = [];
    for await (const event of harness.submit(turn('read the readme'))) events.push(event);
    const sent = requests(events);
    assert.equal(sent.length, 2); assert.equal(posted.length, 2);
    sent.forEach((event, index) => {
      assert.equal(JSON.stringify(view.sentBody(event)), posted[index]);
      // the sections come from the harness's own request; every text they show is in the provider's body
      for (const text of shownTexts(view, event)) assert.ok(posted[index]!.includes(JSON.stringify(text).slice(1, -1)), `${provider}: ${text}`);
    });
  });
}

async function staticServer(t: { after(callback: () => unknown): void }) {
  const child = spawn(process.execPath, ['scripts/serve-browser.mjs'], { env: { ...process.env, MYHARNESS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); });
  return await new Promise<string>((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Static server did not start: ' + output)), 10000);
    child.stdout.on('data', chunk => { output += String(chunk); const match = output.match(/http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error('Static server exited: ' + code)); });
  });
}
async function send(page: Page, message: string) {
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
  await page.locator('#input').fill(message); await page.locator('#send').click();
  await page.waitForFunction(() => !(document.querySelector('#send') as HTMLButtonElement).disabled);
}

test('the rendered Request view: "As sent" equals the sent body, and "By section" shows the same content', async t => {
  const base = await staticServer(t);
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?database=request-parity');
  await page.waitForFunction(() => document.querySelectorAll('.tool-checkbox').length === 12);
  await send(page, 'Remember 42'); await send(page, 'Read README.md');
  await page.locator('#tab-request').click();
  // By section, read from the rendered rows (rows are collapsed but present in the page)
  const sections = await page.evaluate(() => {
    const parts = [...document.querySelectorAll('#request-view .request-parts > details.part')];
    const part = (name: string) => parts.find(element => element.querySelector(':scope > summary .tag')!.textContent!.trim() === name)!;
    const rows = (element: Element) => [...element.querySelectorAll(':scope > .inner > details')].map(row => JSON.parse(row.querySelector('pre.json')!.textContent!));
    const system = [...part('system message').querySelectorAll('pre.plain')].map(pre => pre.textContent!).join('\n\n');
    return { system, memory: rows(part('memory')), thisTurn: rows(part('this turn')), tools: rows(part('tool schemas')) };
  });
  await page.locator('#request-view .seg button', { hasText: 'As sent' }).click();
  const shown = JSON.parse(await page.locator('#request-view pre.json').first().textContent() ?? '{}');
  const expected = await page.evaluate(() => JSON.stringify(RequestView.sentBody(requestView.requests.at(-1)!.event)));
  assert.equal(JSON.stringify(shown), expected);
  assert.equal(sections.memory.length, 2); assert.equal(sections.thisTurn.length, 3);
  assert.deepEqual(shown.messages, [{ role: 'system', content: sections.system }, ...sections.memory, ...sections.thisTurn]);
  assert.deepEqual(shown.tools, sections.tools);
  assert.deepEqual(errors, []);
});

declare const RequestView: { sentBody(event: unknown): unknown };
declare const requestView: { requests: { event: unknown }[] };

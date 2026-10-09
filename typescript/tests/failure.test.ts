import { SessionStore } from '../src/node/sessions.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { DiagnosticError, failureDetails, failureText } from '../src/failure.js';
import { BackendError } from '../src/harness.js';
import { NodeHarness } from '../src/node/harness.js';
import { BridgeError } from '../src/bridge/protocol.js';
import { WorkerClient, type WorkerPort } from '../src/browser/client.js';
import { browserFetch } from '../src/browser/fetch.js';
import type { RpcMessage, RpcRequest } from '../src/browser/worker-host.js';

const action = { message: 'hello', useMemory: true, tools: [], askApproval: true, agent: '', prompt: '' };
test('diagnostics identify model and bridge failures and retain safe details in saved history', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const detail = failureDetails(new Error('HTTP 503'), 'model', 'Ollama / q', 'Start Ollama and retry.');
  assert.deepEqual(failureDetails(new DiagnosticError(detail)), detail);
  assert.equal(failureDetails(new BackendError('busy')).source, 'harness');
  assert.equal(failureDetails('offline').reason, 'offline');
  assert.equal(failureText('offline', 'fallback'), 'fallback');
  assert.equal(failureText(new Error('offline'), 'fallback'), 'fallback');
  assert.equal(failureText(new BackendError('offline'), 'fallback'), 'fallback');
  assert.match(failureText(new DiagnosticError(detail), 'fallback'), /Where: Model service.*Ollama/);
  for (const error of [new Error('HTTP 503'), 'offline', new BridgeError('Bridge connection expired', 401)]) {
    const harness = new NodeHarness({ workspace: root, model: 'q', contextLength: 1000, ollama: { async *streamChat() { throw error; } } });
    const events = []; for await (const event of harness.submit(action)) events.push(event);
    const stopped = events.at(-1)!;
    const failure = stopped.failure as typeof detail;
    assert.equal(failure.source, error instanceof BridgeError ? 'bridge' : 'model');
    assert.match(failure.component, error instanceof BridgeError ? /bridge/ : /q/);
    assert.ok(failure.reason); assert.ok(failure.recovery);
    assert.deepEqual(harness.activeSessionRecord().events.at(-1)!.failure, failure);
    await harness.close();
  }
});

test('Worker and fetch preserve diagnostic source, reason and recovery', async () => {
  const failure = failureDetails('Workspace is missing.');
  let receive!: (event: { data?: RpcMessage }) => void;
  const worker: WorkerPort = {
    addEventListener(type, callback) { if (type === 'message') receive = callback; }, removeEventListener() {}, terminate() {},
    postMessage(request: RpcRequest) { receive({ data: { id: request.id, type: 'error', message: failure.reason, status: 409, failure } }); },
  };
  const client = new WorkerClient(worker);
  await assert.rejects(client.call('bootstrap'), (error: BackendError) => { assert.deepEqual(error.failure, failure); return true; });
  const response = await browserFetch(client)('/bootstrap');
  assert.equal(response.status, 409); assert.deepEqual((await response.json()).failure, failure);
  client.close();
});

test('chat diagnostics render the same details in live errors and replay without labeling user stops as errors', async () => {
  const html = await readFile('web/templates/index.html', 'utf8');
  const helper = html.slice(html.indexOf('function formatFailure('), html.indexOf('async function sendMessage('));
  const output: string[] = [];
  const context = { formatFailure: undefined as unknown as (failure: unknown, fallback: string) => string, responseError: undefined as unknown as (data: unknown) => Error, displayError: undefined as unknown as (error: Error) => string,
    replaySessionEvent: undefined as unknown as (event: unknown) => void,
    printBlock: (_title: string, text: string) => output.push(text), addDivider: (text: string) => output.push(text) };
  new Script(helper).runInNewContext(context);
  const failure = failureDetails('HTTP 503', 'model', 'Ollama / q', 'Start Ollama and retry.');
  const displayed = context.displayError(context.responseError({ error: failure.reason, failure }));
  assert.match(displayed, /Source: model/); assert.match(displayed, /Ollama \/ q/); assert.match(displayed, /Reason: HTTP 503/); assert.match(displayed, /Next: Start Ollama/);
  assert.match(context.displayError(context.responseError({ error: 'offline' })), /request could not be completed/);
  assert.match(context.displayError(context.responseError({})), /Request failed/);
  new Script(html.slice(html.indexOf('function replaySessionEvent('), html.indexOf('// A loop-hygiene guard'))).runInNewContext(context);
  context.replaySessionEvent({ type: 'stopped', reason: 'Turn failed', failure });
  assert.deepEqual(output, [displayed, displayed]);
  output.length = 0; context.replaySessionEvent({ type: 'stopped', reason: 'stopped by the user' });
  assert.deepEqual(output, ['stopped by the user', 'stopped by the user']);
  assert.match(html, /printBlock\("STOPPED", formatFailure\(event.failure, event.reason\)\)/);
});


test('invalid model tool proposals are attributed to the model before any tool executes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-invalid-proposal-')); t.after(() => rm(root, { recursive: true, force: true }));
  const harness = new NodeHarness({ workspace: root, provider: 'openai', model: 'fixture', contextLength: 1000, ollama: {
    async *streamChat() { yield JSON.stringify({ message: { tool_calls: [{ function: { name: 'read_file', arguments: {} } }] }, done: true }); }
  } });
  const events = []; for await (const event of harness.submit({ ...action, tools: ['read_file'] })) events.push(event);
  const failure = events.at(-1)!.failure as ReturnType<typeof failureDetails>;
  assert.equal(failure.source, 'model'); assert.match(failure.reason, /Missing required argument/);
  assert.match(failure.recovery, /no tools were executed/);
  assert.equal(events.some(event => event.type === 'tool'), false);
  await harness.close();
});

test('harness execution faults are attributed to the harness, including non-Error exceptions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-execution-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const error of [new Error('Runtime adapter failed'), 'Runtime adapter unavailable']) {
    const harness = new NodeHarness({ workspace: root, model: 'fixture', contextLength: 1000, ollama: {
      async *streamChat() { yield JSON.stringify({ message: { tool_calls: [{ function: { name: 'pwd', arguments: {} } }] }, done: true }); }
    } });
    t.mock.method(harness, 'runTool', async () => { throw error; });
    const events = []; for await (const event of harness.submit({ ...action, tools: ['pwd'] })) events.push(event);
    const failure = events.at(-1)!.failure as ReturnType<typeof failureDetails>;
    assert.equal(failure.source, 'harness'); assert.match(failure.reason, /Runtime adapter/);
    await harness.close();
  }
});

test('a non-Error persistence rejection records a harness failure and settles the turn', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-storage-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new SessionStore(root);
  const harness = new NodeHarness({ workspace: root, model: 'q', contextLength: 1000, sessions, ollama: { async *streamChat() { throw new Error('must not request a model'); } } });
  await harness.initialize();
  const save = sessions.save.bind(sessions); let first = true;
  t.mock.method(sessions, 'save', async (...args: Parameters<typeof save>) => { if (first) { first = false; throw 'storage unavailable'; } return save(...args); });
  const events = []; for await (const event of harness.submit(action)) events.push(event);
  const stopped = events.find(event => event.type === 'stopped')!;
  assert.equal(stopped.reason, 'Turn failed: storage unavailable'); assert.equal((stopped.failure as { source: string }).source, 'harness');
  await harness.newSession(); await harness.close();
});

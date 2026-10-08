import assert from 'node:assert/strict';
import test from 'node:test';
import { browserFetch, reportBrowserMcpConfig } from '../src/browser/fetch.js';
import type { WorkerClient } from '../src/browser/client.js';

test('MCP terminal reporting stays local, sends current backend config, and reports logging failures without failing the save', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'location', previous); else Reflect.deleteProperty(globalThis, 'location'); });
  const location = (url: string) => Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL(url) });
  const config = { source: 'browser storage', config: { mcpServers: { github: { disabled: true } } } };
  const calls: string[] = [];
  const client = { async call(action: string) { calls.push(action); return config; } } as unknown as WorkerClient;
  location('https://example.test/');
  await reportBrowserMcpConfig(client); assert.deepEqual(calls, []);
  location('http://localhost:1234/?database=isolated-debug');
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(String(url), 'http://localhost:1234/__debug/mcp-config?database=isolated-debug');
    assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(String(init.body)), config);
    return new Response(null, { status: 204 });
  });
  await reportBrowserMcpConfig(client); assert.deepEqual(calls, ['mcpConfiguration']);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  t.mock.method(globalThis, 'fetch', async () => new Response('Restart the static server', { status: 404 }));
  await reportBrowserMcpConfig(client);
  assert.equal(warnings[0]![1], 'Restart the static server');
  const failure = new Error('Worker unavailable');
  const broken = { async call() { throw failure; } } as unknown as WorkerClient;
  await reportBrowserMcpConfig(broken); assert.equal(warnings[1]![1], failure);
});

test('browser HTTP configuration routes inspect the config and preserve the public raw Worker save payload', async () => {
  const config = { mcpServers: { github: { disabled: true } } };
  const calls: { action: string; payload: unknown }[] = [];
  const client = { async call(action: string, payload: unknown) { calls.push({ action, payload }); return action === 'mcpConfiguration' ? { config } : { supported: true }; } } as unknown as WorkerClient;
  const request = browserFetch(client);
  assert.deepEqual(await (await request('/mcp/config')).json(), { config });
  assert.equal((await request('/mcp/config', { method: 'PUT', body: JSON.stringify({ config }) })).status, 200);
  assert.deepEqual(calls, [{ action: 'mcpConfiguration', payload: {} }, { action: 'configureMcp', payload: config }]);
});

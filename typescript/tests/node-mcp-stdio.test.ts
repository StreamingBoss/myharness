import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { McpClient } from '../src/mcp/client.js';
import { StdioChannel } from '../src/node/mcp-stdio.js';
import type { StdioConfig } from '../src/mcp/manager.js';
import { STDIO_SERVER, type FixtureOptions } from './mcp-fixture.js';

type Extra = { noise?: number; ignoreEnd?: boolean; ignoreTerm?: boolean; exitOnCall?: boolean; hangCalls?: boolean };
const stdioConfig = (options: FixtureOptions & Extra = {}, env: Record<string, string> = {}): StdioConfig =>
  ({ kind: 'stdio', command: process.execPath, args: [STDIO_SERVER], env: { MCP_FIXTURE: JSON.stringify(options), ...env } });
const signal = () => new AbortController().signal;

test('stdio: a real child process speaks modern MCP with framing split across writes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-stdio-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'tools'));
  const channel = new StdioChannel({ ...stdioConfig({ instructions: 'stdio hints', noise: 60 }, { FIXTURE_LABEL: 'label-from-env' }), cwd: 'tools' }, root);
  const client = new McpClient(channel);
  await client.connect(signal());
  assert.equal(client.era, 'modern'); assert.equal(client.instructions, 'stdio hints');
  const call = await client.request('tools/call', { name: 'echo', arguments: { text: 'över stdio' } }, signal());
  assert.deepEqual(call.result.content, [{ type: 'text', text: 'echo: över stdio' }]);
  const stderr = client.stderr();
  assert.equal(stderr.length, 50);
  assert.ok(stderr.at(-1)!.startsWith('[stdout is not JSON-RPC] not JSON 59'));
  await channel.close(); await channel.close();
});

test('stdio: legacy servers, server requests, cancellation and the stderr tail', async () => {
  const channel = new StdioChannel(stdioConfig({ era: 'legacy', probe: 'silent', serverRequests: true }, { FIXTURE_LABEL: 'legacy' }), process.cwd());
  const client = new McpClient(channel, { probeTimeoutMs: 200 });
  await client.connect(signal());
  assert.equal(client.era, 'legacy');
  await client.request('tools/call', { name: 'echo', arguments: { text: 'x' } }, signal());
  assert.deepEqual(client.stderr(), ['fixture started with legacy']);
  assert.ok(client.log.some(entry => entry.text.includes('sampling/createMessage')));
  const hanging = new StdioChannel(stdioConfig({ hangCalls: true }), process.cwd()), waiting = new McpClient(hanging);
  await waiting.connect(signal());
  const stop = new AbortController(), pending = waiting.request('tools/call', { name: 'echo', arguments: {} }, stop.signal);
  setTimeout(() => stop.abort(new Error('stopped by the user')), 20);
  await assert.rejects(pending, /stopped by the user/);
  assert.ok(waiting.log.some(entry => entry.text.includes('notifications/cancelled')));
  await waiting.close();
  const aborted = new AbortController(); aborted.abort(new Error('already stopped'));
  await assert.rejects(channel.request({ jsonrpc: '2.0', id: 'x', method: 'ping' }, { signal: aborted.signal }), /already stopped/);
  await client.close();
});

test('stdio: an exiting server rejects pending and later requests', async () => {
  const channel = new StdioChannel(stdioConfig({ exitOnCall: true }), process.cwd());
  const client = new McpClient(channel);
  await client.connect(signal());
  await assert.rejects(client.request('tools/call', { name: 'echo', arguments: {} }, signal()), /process exited \(code 3\)/);
  await assert.rejects(client.request('tools/list', {}, signal()), /process exited/);
  await assert.rejects(channel.notify({ jsonrpc: '2.0', method: 'x' }), /process exited/);
  await channel.close();
});

test('stdio: a missing command is reported', async () => {
  const channel = new StdioChannel({ kind: 'stdio', command: '/definitely/not/a/command', args: [], env: {} }, process.cwd());
  await assert.rejects(new McpClient(channel).connect(signal()), /could not start '\/definitely\/not\/a\/command'/);
  await channel.close();
});

test('stdio: shutdown escalates from closing stdin to SIGTERM to SIGKILL', async () => {
  for (const options of [{}, { ignoreEnd: true }, { ignoreEnd: true, ignoreTerm: true }]) {
    const channel = new StdioChannel(stdioConfig(options), process.cwd(), 150);
    await new McpClient(channel).connect(signal());
    const started = Date.now();
    await channel.close();
    const elapsed = Date.now() - started;
    if (!options.ignoreEnd) assert.ok(elapsed < 150, `graceful close took ${elapsed} ms`);
    else assert.ok(elapsed >= 140, `escalation took only ${elapsed} ms`);
    await assert.rejects(channel.request({ jsonrpc: '2.0', id: 1, method: 'ping' }, { signal: signal() }), /process exited/);
  }
});

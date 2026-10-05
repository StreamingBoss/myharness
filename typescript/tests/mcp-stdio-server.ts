import { FixtureServer, type FixtureOptions } from './mcp-fixture.js';
import type { RpcResponse } from '../src/mcp/protocol.js';

/** The fixture as a real stdio MCP server process. Options arrive in MCP_FIXTURE. */
const options = JSON.parse(process.env.MCP_FIXTURE ?? '{}') as FixtureOptions & { noise?: number; ignoreEnd?: boolean; ignoreTerm?: boolean; exitOnCall?: boolean; hangCalls?: boolean };
const server = new FixtureServer({ ...options, ...(options.hangCalls ? { call: () => 'hang' as const } : {}) });
const waiters = new Map<unknown, (response: RpcResponse) => void>();
const write = (value: unknown) => {
  const line = JSON.stringify(value) + '\n', half = Math.floor(line.length / 2);
  // Split each message across two writes to exercise framing.
  process.stdout.write(line.slice(0, half)); process.stdout.write(line.slice(half));
};
process.stderr.write(`fixture started with ${process.env.FIXTURE_LABEL ?? 'no label'}\n`);
for (let line = 0; line < (options.noise ?? 0); line++) process.stdout.write(`not JSON ${line}\n\n`);
if (options.ignoreTerm) process.on('SIGTERM', () => undefined);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>; buffer = buffer.slice(newline + 1);
    if (!('method' in message)) { waiters.get(message.id)?.(message as unknown as RpcResponse); continue; }
    if (options.exitOnCall && message.method === 'tools/call') process.exit(3);
    void server.handle(message as never, request => new Promise(resolve => { waiters.set(request.id, resolve); write(request); }))
      .then(response => { if (response) write(response); });
  }
});
process.stdin.on('end', () => { if (!options.ignoreEnd) process.exit(0); });
if (options.ignoreEnd) setInterval(() => undefined, 1000); // stays alive after stdin closes

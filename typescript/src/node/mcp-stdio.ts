import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { McpChannel } from '../mcp/client.js';
import type { StdioConfig } from '../mcp/manager.js';
import { isRequest, isResponse, type RpcNotification, type RpcRequest, type RpcResponse } from '../mcp/protocol.js';

/** stdio transport: newline-delimited JSON-RPC with a child process. Node-only adapter. */
export class StdioChannel implements McpChannel {
  readonly transport = 'stdio';
  onRequest?: (request: RpcRequest) => RpcResponse;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<RpcRequest['id'], { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>();
  private readonly errors: string[] = [];
  private buffer = '';
  private ended: Error | undefined;
  private readonly exited: Promise<void>;

  constructor(config: StdioConfig, root: string, private readonly graceMs = 2000) {
    this.child = spawn(config.command, config.args, { cwd: path.resolve(root, config.cwd ?? '.'), env: { ...process.env, ...config.env }, stdio: 'pipe' });
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.read(chunk));
    this.child.stderr.on('data', (chunk: string) => this.remember(chunk));
    this.child.stdin.on('error', () => undefined); // reported through 'exit' or 'error'
    this.exited = new Promise(resolve => {
      this.child.on('error', error => { this.fail(new Error(`could not start '${config.command}': ${error.message}`)); resolve(); });
      this.child.on('exit', (code, signal) => { this.fail(new Error(`the MCP server process exited (${signal ?? `code ${code}`})`)); resolve(); });
    });
  }

  private remember(text: string): void {
    this.errors.push(...text.split('\n').filter(Boolean));
    this.errors.splice(0, Math.max(0, this.errors.length - 50));
  }
  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { this.remember(`[stdout is not JSON-RPC] ${line}`); continue; }
      if (isResponse(message)) { this.pending.get(message.id!)?.resolve(message); this.pending.delete(message.id!); }
      else if (isRequest(message)) this.write(this.onRequest!(message));
    }
  }
  private fail(error: Error): void {
    this.ended ??= error;
    for (const waiter of this.pending.values()) waiter.reject(this.ended);
    this.pending.clear();
  }
  private write(message: RpcRequest | RpcNotification | RpcResponse): void {
    if (this.ended) throw this.ended;
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(message: RpcRequest, options: { signal: AbortSignal }): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) { reject(options.signal.reason as Error); return; }
      this.pending.set(message.id, { resolve, reject });
      options.signal.addEventListener('abort', () => { this.pending.delete(message.id); reject(options.signal.reason as Error); }, { once: true });
      try { this.write(message); } catch (error) { this.pending.delete(message.id); reject(error as Error); }
    });
  }
  async notify(message: RpcNotification): Promise<void> { this.write(message); }
  stderr(): string[] { return [...this.errors]; }

  /** Close stdin, wait, then SIGTERM, then SIGKILL. */
  async close(): Promise<void> {
    const wait = () => Promise.race([this.exited.then(() => true), new Promise<boolean>(resolve => setTimeout(resolve, this.graceMs, false).unref())]);
    if (this.ended) return;
    this.child.stdin.end();
    if (await wait()) return;
    this.child.kill('SIGTERM');
    if (await wait()) return;
    this.child.kill('SIGKILL');
    await this.exited;
  }
}

import { DiagnosticError, failureDetails } from '../failure.js';
import { timeoutDuration } from '../error-messages.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** Private, bounded NDJSON channel. An interrupted exchange invalidates the process. */
export class TokenizerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private failure: string | undefined;
  private busy = false;
  constructor(executable: string, file: string) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('LLAMA_ARG_')));
    this.child = spawn(executable, ['-m', file], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
    this.child.stderr.resume(); // Never expose native logs, paths or prompt contents to the UI.
    this.child.on('error', error => { this.failure = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Tokenizer helper is not installed. Build myharness-tokenizer and set MYHARNESS_LLAMA_TOKENIZER, then restart the bridge.'
      : 'Could not start tokenizer helper. Check MYHARNESS_LLAMA_TOKENIZER and executable permissions.'; });
    this.child.on('exit', () => { this.failure = 'Tokenizer helper exited. Check GGUF compatibility and retry inspection.'; });
    this.child.stdin.on('error', () => { this.failure = 'Tokenizer helper input channel failed. Retry inspection.'; });
  }
  get failed(): boolean { return this.failure !== undefined; }
  close(): void { this.child.kill('SIGKILL'); }
  async exchange(signal: AbortSignal, content?: string, timeoutMs = 30_000): Promise<unknown> {
    signal.throwIfAborted();
    if (this.failure) throw new Error(this.failure);
    if (this.busy) throw new Error('Tokenizer helper is busy. Retry after the current inspection.');
    const input = content === undefined ? undefined : JSON.stringify({ content });
    if (input !== undefined && Buffer.byteLength(input) > 8 * 1024 * 1024) throw new Error('Prompt exceeds the tokenizer helper input limit (8 MiB).');
    this.busy = true;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const cleanup = () => {
          this.child.stdout.off('data', data); this.child.off('error', failed); this.child.off('exit', exited);
          this.child.stdin.off('error', failed); signal.removeEventListener('abort', aborted);
        };
        const fail = (message: string) => { cleanup(); this.failure = message; this.close(); reject(new DiagnosticError(failureDetails(message, 'harness', 'Token inspection', 'You can keep chatting. Retry token inspection after checking its setup.', timeoutMs))); };
        const failed = () => fail(this.failure!);
        const exited = () => fail('Tokenizer helper exited before responding. Check GGUF compatibility and retry inspection.');
        const aborted = () => fail(`Token inspection was cancelled or did not finish in time. Retry inspection. [Time limit: ${timeoutDuration(timeoutMs)}]`);
        const data = (chunk: Buffer) => {
          if (size + chunk.length > 64 * 1024 * 1024) { fail('Tokenizer helper response exceeded 64 MiB.'); return; }
          chunks.push(chunk); size += chunk.length;
          const newline = chunk.indexOf(10);
          if (newline < 0) return;
          try {
            if (newline !== chunk.length - 1) throw new Error('extra output');
            const result: unknown = JSON.parse(Buffer.concat(chunks, size).subarray(0, size - 1).toString('utf8'));
            cleanup(); resolve(result);
          } catch { fail('Tokenizer helper returned invalid protocol data. Rebuild the helper and retry inspection.'); }
        };
        this.child.stdout.on('data', data); this.child.once('error', failed); this.child.once('exit', exited);
        this.child.stdin.once('error', failed); signal.addEventListener('abort', aborted, { once: true });
        if (input !== undefined) this.child.stdin.write(input + '\n');
      });
    } finally { this.busy = false; }
  }
}

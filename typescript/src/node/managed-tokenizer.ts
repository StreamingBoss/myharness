import type { InspectionProgress } from '../tokenization.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OllamaAdapter, type FetchLike } from '../ollama.js';
import type { TokenizerBinding } from '../llama-tokenizer.js';

/** Safe setup failures may be displayed without exposing process output or paths. */
export class TokenizerSetupError extends Error {}
export interface ManagedTokenizerOptions {
  executable?: string; models?: Record<string, string>; startupTimeoutMs?: number; windowsMountRoot?: string;
}
/** Windows Ollama reports drive paths; WSL reads those files through its drive mounts. */
export function modelFilePath(file: string, windowsMountRoot = '/mnt'): string {
  const drive = /^([a-z]):[\\/](.*)$/i.exec(file);
  return drive ? path.join(windowsMountRoot, drive[1]!.toLowerCase(), drive[2]!.replace(/\\/g, '/')) : file;
}
interface Running { child: ChildProcess; key: string; binding: TokenizerBinding; failure?: string }

/** One operator-authorized llama.cpp process. Never starts a shell or downloads models. */
export class ManagedTokenizer {
  private running: Running | undefined;
  private readonly lifetime = new AbortController();
  constructor(private readonly options: ManagedTokenizerOptions, private readonly ollamaUrl: string, private readonly fetch_: FetchLike) {
    if (options.models !== undefined && (!options.models || typeof options.models !== 'object' || Array.isArray(options.models) || Object.values(options.models).some(file => typeof file !== 'string' || !path.isAbsolute(file)))) throw new TokenizerSetupError('MYHARNESS_TOKENIZER_MODELS must map exact Ollama model IDs to absolute GGUF file paths.');
  }
  close(): void { this.lifetime.abort(); this.stop(); }
  private stop(): void { this.running?.child.kill('SIGKILL'); this.running = undefined; }

  async binding(model: string, signal: AbortSignal, progress?: InspectionProgress): Promise<TokenizerBinding> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) throw new TokenizerSetupError('Choose a valid exact Ollama model ID before starting its tokenizer.');
    const requestSignal = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.options.startupTimeoutMs ?? 30_000)]);
    requestSignal.throwIfAborted();
    progress?.('locating');
    let file: string, identity: string;
    if (this.options.models && Object.hasOwn(this.options.models, model)) {
      file = this.options.models[model]!; identity = 'operator-configured GGUF for ' + model;
    } else {
      const host = new URL(this.ollamaUrl).hostname;
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new TokenizerSetupError('Ollama runs on another host. Set MYHARNESS_TOKENIZER_MODELS to a matching local GGUF, or configure an existing tokenizer with MYHARNESS_TOKENIZERS.');
      let data: Record<string, unknown>;
      try { data = await new OllamaAdapter(this.fetch_, this.ollamaUrl).request('show', { model }, requestSignal); }
      catch { throw new TokenizerSetupError('Could not locate the Ollama model. Check OLLAMA_URL and that the selected model is installed.'); }
      const modelfile = typeof data.modelfile === 'string' ? data.modelfile : '';
      const from = /^\s*FROM\s+(.+?)\s*$/mi.exec(modelfile)?.[1];
      if (!from || /^\s*ADAPTER\s/mi.test(modelfile)) throw new TokenizerSetupError('Ollama did not provide a usable model file. Configure a matching local GGUF with MYHARNESS_TOKENIZER_MODELS.');
      file = modelFilePath(from.replace(/^"(.*)"$/, '$1'), this.options.windowsMountRoot);
      if (!path.isAbsolute(file)) throw new TokenizerSetupError('The Ollama model file is not accessible locally. Set MYHARNESS_TOKENIZER_MODELS to its matching absolute GGUF path.');
      identity = 'Ollama-reported GGUF ' + path.basename(file);
    }
    let key: string;
    try {
      file = await realpath(file);
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      const handle = await open(file, 'r');
      try {
        const magic = Buffer.alloc(4); await handle.read(magic, 0, 4, 0);
        if (magic.toString('ascii') !== 'GGUF') throw new Error('not GGUF');
      } finally { await handle.close(); }
      key = JSON.stringify([model, file, info.size, info.mtimeMs]);
    } catch { throw new TokenizerSetupError('The matching GGUF is missing, unreadable or invalid on the bridge machine. For Docker, WSL or remote Ollama, set MYHARNESS_TOKENIZER_MODELS to an accessible matching file.'); }
    requestSignal.throwIfAborted();
    if (this.running?.key === key && !this.running.failure) { progress?.('reusing'); return this.running.binding; }
    progress?.('loading');
    this.stop();
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    requestSignal.throwIfAborted();
    // Strip llama argument environment defaults: they must not enable tools or change fixed endpoints.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('LLAMA_ARG_')));
    const child = spawn(this.options.executable ?? 'llama-server', ['-m', file, '--alias', model, '--host', '127.0.0.1', '--port', String(port), '-c', '512', '-ngl', '0', '--parallel', '1'], { shell: false, stdio: 'ignore', env });
    const running: Running = { child, key, binding: { url: `http://127.0.0.1:${port}`, alias: model, identity } };
    this.running = running;
    child.on('error', error => { running.failure = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'llama-server is not installed or cannot be found. Install llama.cpp and set MYHARNESS_LLAMA_SERVER to its llama-server executable, then restart the bridge.'
      : 'Could not start llama-server. Check MYHARNESS_LLAMA_SERVER and executable permissions.'; });
    child.on('exit', () => { running.failure = 'llama-server exited. Check that llama.cpp supports this GGUF and that enough memory is available.'; });
    try {
      while (true) {
        requestSignal.throwIfAborted();
        if (running.failure) throw new TokenizerSetupError(running.failure);
        try {
          const response = await this.fetch_(running.binding.url + '/v1/models', { method: 'GET', signal: AbortSignal.any([requestSignal, AbortSignal.timeout(1000)]), redirect: 'error' });
          const data = await response.json() as { data?: { id: string }[] };
          if (response.ok && data.data?.some(item => item.id === model)) return running.binding;
        } catch { /* A newly spawned server may not be listening or ready yet. */ }
        await delay(100, undefined, { signal: requestSignal });
      }
    } catch (error) {
      this.stop();
      if (error instanceof TokenizerSetupError) throw error;
      throw new TokenizerSetupError(requestSignal.aborted && !signal.aborted && !this.lifetime.signal.aborted
        ? 'llama-server did not become ready within 30 seconds. Check model compatibility and available memory, or configure a separately started tokenizer with MYHARNESS_TOKENIZERS.'
        : 'Tokenizer startup was cancelled. Retry inspection after reconnecting if necessary.');
    }
  }
}

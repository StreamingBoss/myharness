import { timeoutDuration } from '../error-messages.js';
import type { InspectionProgress } from '../tokenization.js';
import { TokenizerProcess } from './tokenizer-process.js';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { OllamaAdapter, type FetchLike } from '../ollama.js';
import type { PromptTokenizer } from '../llama-tokenizer.js';
import { tokenPiece } from '../tokenization.js';

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
interface Running { process: TokenizerProcess; key: string; binding: PromptTokenizer }

/** One operator-authorized llama.cpp process. Never starts a shell or downloads models. */
export class ManagedTokenizer {
  private running: Running | undefined;
  private readonly lifetime = new AbortController();
  constructor(private readonly options: ManagedTokenizerOptions, private readonly ollamaUrl: string, private readonly fetch_: FetchLike) {
    if (options.models !== undefined && (!options.models || typeof options.models !== 'object' || Array.isArray(options.models) || Object.values(options.models).some(file => typeof file !== 'string' || !path.isAbsolute(file)))) throw new TokenizerSetupError('MYHARNESS_TOKENIZER_MODELS must map exact Ollama model IDs to absolute GGUF file paths.');
  }
  close(): void { this.lifetime.abort(); this.stop(); }
  private stop(): void { this.running?.process.close(); this.running = undefined; }

  async binding(model: string, signal: AbortSignal, progress?: InspectionProgress): Promise<PromptTokenizer> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) throw new TokenizerSetupError('Choose a valid exact Ollama model ID before starting its tokenizer.');
    const startupTimeoutMs = this.options.startupTimeoutMs ?? 30_000;
    const requestSignal = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(startupTimeoutMs)]);
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
    if (this.running?.key === key && !this.running.process.failed) { progress?.('reusing'); return this.running.binding; }
    progress?.('loading');
    this.stop();
    const process = new TokenizerProcess(this.options.executable ?? 'myharness-tokenizer', file);
    const binding: PromptTokenizer = { alias: model, identity, tokenize: async (content, signal) => {
      try {
        const result = await process.exchange(AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(30_000)]), content) as { tokens?: { id: unknown; bytes: unknown }[] } | null;
        if (!result || !Array.isArray(result.tokens)) throw new Error('Token inspection returned no token pieces to display. Retry inspection.');
        return { label: 'Ollama-rendered prompt', tokens: result.tokens.map(token => tokenPiece(token.id, token.bytes)) };
      } catch (error) {
        process.close();
        if (this.running?.process === process) this.running = undefined;
        throw error;
      }
    } };
    this.running = { process, key, binding };
    try {
      const ready = await process.exchange(requestSignal, undefined, startupTimeoutMs) as { ready?: unknown; protocol?: unknown; vocab_only?: unknown } | null;
      if (!ready || ready.ready !== true || ready.protocol !== 1 || ready.vocab_only !== true) throw new Error('Tokenizer helper returned an incompatible readiness response. Build the vocabulary-only helper and retry.');
      return binding;
    } catch (error) {
      process.close();
      if (this.running?.process === process) this.running = undefined;
      throw new TokenizerSetupError(requestSignal.aborted
        ? (!signal.aborted && !this.lifetime.signal.aborted ? `Tokenizer helper did not become ready before the startup deadline. [Time limit: ${timeoutDuration(startupTimeoutMs)}] Check GGUF compatibility or configure MYHARNESS_TOKENIZERS.` : 'Tokenizer startup was cancelled. Retry inspection after reconnecting if necessary.')
        : (error as Error).message);
    }
  }
}

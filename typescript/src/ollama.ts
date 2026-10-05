import type { ModelOption } from "./model.js";
import type { ModelRequest } from "./core.js";
import { unavailable, type TokenInspection } from './tokenization.js';
import { tokenizeWithLlama, type TokenizerBinding } from './llama-tokenizer.js';

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (input: string, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponse>;

/** Fetch adapter usable in Node and browser Workers for Ollama's newline-delimited `/api/chat` stream. */
export class OllamaAdapter {
  readonly provider = 'ollama';
  constructor(private readonly fetch_: FetchLike, private readonly baseUrl: string, private readonly tokenizers: Record<string, TokenizerBinding> = {}) {}
  requestMetadata(): Record<string, unknown> { return { provider: this.provider }; }

  async inspectTokens(payload: ModelRequest, signal?: AbortSignal): Promise<TokenInspection> {
    const result = unavailable(payload.model, this.provider, 'Ollama does not expose input token IDs through its normal chat API.');
    const data = await this.request('chat', { ...payload, stream: false, _debug_render_only: true, options: { ...payload.options, num_predict: 1 } }, signal);
    const prompt = (data._debug_info as { rendered_template?: unknown } | undefined)?.rendered_template;
    if (typeof prompt !== 'string') {
      result.explanation = 'This Ollama version did not return a rendered prompt. Token inspection needs support for _debug_render_only.';
      return result;
    }
    result.renderedPrompt = prompt;
    result.source = 'Ollama debug renderer';
    result.limitations.push('This is a new inspection request. On older servers that ignore the debug flag it may generate at most one token, and no rendered prompt is shown.');
    result.coverage = 'Prompt text returned by a separate render-only request with the saved messages, system instructions and tools.';
    const binding = this.tokenizers[payload.model];
    if (!binding) {
      result.explanation = 'Ollama returned its rendered prompt, but no matching tokenizer service is configured for this exact model. The text below is not a token sequence.';
      return result;
    }
    const group = await tokenizeWithLlama(this.fetch_, binding, prompt, signal);
    return { ...result, source: `llama.cpp tokenizer: ${binding.identity}`, fidelity: 'configured-tokenizer',
      explanation: 'Each coloured piece is a token returned by the configured tokenizer for the Ollama-rendered prompt. Click a piece for its ID and raw bytes.',
      limitations: ['Tokenization was performed separately, not captured during inference.', 'The configured model identity is supplied by the operator; matching model aliases do not prove matching vocabularies.', 'Automatic BOS/EOS insertion is disabled. Special markers in the prompt are parsed. Runner-specific additions or later truncation may differ.', 'Rendering now may differ from the original request if the Ollama model or server changed.'],
      count: group.tokens.length, groups: [group] };
  }

  private fetch(input: string, init: Parameters<FetchLike>[1]): Promise<FetchResponse> {
    // Browser/Worker fetch rejects an adapter object as its receiver.
    const fetch_ = this.fetch_;
    return fetch_(input, init);
  }

  async *streamChat(payload: ModelRequest, signal?: AbortSignal): AsyncGenerator<string> {
    const response = await this.fetch(`${this.baseUrl}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Ollama request failed with HTTP ${response.status}`);
    if (!response.body) throw new Error("Ollama returned no response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try { while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield line;
        newline = buffered.indexOf("\n");
      }
      if (done) break;
    }
    const finalLine = buffered.trim();
    if (finalLine) yield finalLine;
    } finally { await reader.cancel(); reader.releaseLock(); }
  }

  async request(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetch(`${this.baseUrl}/api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Ollama request failed with HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  }

  async listModels(): Promise<ModelOption[]> {
    const response = await this.fetch(`${this.baseUrl}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Could not list Ollama models (HTTP ${response.status}). Check the server URL and OLLAMA_ORIGINS.`);
    const data = await response.json() as { models?: { name?: unknown }[] };
    if (!data || !Array.isArray(data.models)) throw new Error('Ollama returned an invalid model list.');
    const names = data.models.map(model => model?.name).filter((name): name is string => typeof name === 'string' && name.length > 0);
    return [...new Set(names)].sort().map(id => ({ id, label: id }));
  }

  async contextLength(model: string): Promise<number> {
    const data = await this.request('show', { model });
    const info = data.model_info as Record<string, unknown> | undefined;
    const context = info?.[`${info['general.architecture']}.context_length`];
    if (typeof context !== "number" || !Number.isInteger(context) || context <= 0) {
      throw new Error(`Ollama did not report a context length for '${model}'`);
    }
    return context;
  }
}

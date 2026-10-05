import type { ModelRequest } from '../core.js';
import type { ModelPort } from '../harness.js';
import { OllamaAdapter } from '../ollama.js';
import { unavailable, type TokenInspection } from '../tokenization.js';
import { DemoModel, DEMO_MODEL } from './demo.js';

export class BrowserModel implements ModelPort {
  private readonly demo = new DemoModel();
  constructor(public ollama = new OllamaAdapter(fetch, 'http://localhost:11434')) {}
  requestMetadata(payload: ModelRequest): Record<string, unknown> { return { provider: payload.model === DEMO_MODEL ? 'demo' : 'ollama' }; }
  inspectTokens(payload: ModelRequest, signal?: AbortSignal): Promise<TokenInspection> {
    return payload.model === DEMO_MODEL ? Promise.resolve(unavailable(payload.model, 'demo', 'The scripted demo is not an LLM and has no model tokenizer.')) : this.ollama.inspectTokens(payload, signal);
  }
  streamChat(payload: ModelRequest, signal?: AbortSignal): AsyncIterable<string> {
    return payload.model === DEMO_MODEL ? this.demo.streamChat(payload, signal) : this.ollama.streamChat(payload, signal);
  }
  request(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (payload as { model: string }).model === DEMO_MODEL ? this.demo.request(endpoint, payload) : this.ollama.request(endpoint, payload, signal);
  }
}

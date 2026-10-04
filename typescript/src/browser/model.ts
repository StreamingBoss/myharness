import type { ModelRequest } from '../core.js';
import type { ModelPort } from '../harness.js';
import { OllamaAdapter } from '../ollama.js';
import { DemoModel, DEMO_MODEL } from './demo.js';

export class BrowserModel implements ModelPort {
  private readonly demo = new DemoModel();
  constructor(public ollama = new OllamaAdapter(fetch, 'http://localhost:11434')) {}
  streamChat(payload: ModelRequest, signal?: AbortSignal): AsyncIterable<string> {
    return payload.model === DEMO_MODEL ? this.demo.streamChat(payload, signal) : this.ollama.streamChat(payload, signal);
  }
  request(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (payload as { model: string }).model === DEMO_MODEL ? this.demo.request(endpoint, payload) : this.ollama.request(endpoint, payload, signal);
  }
}

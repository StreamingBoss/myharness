import type { ModelRequest } from './core.js';
import type { ModelPort } from './harness.js';
import type { FetchLike } from './ollama.js';
import { LegacyModelAdapter, PROVIDERS, type ModelAdapter, type ModelDescription, type ModelEvent, type ModelResult, type Provider } from './model.js';
import { CloudAdapter, type CloudProvider } from './cloud.js';
import { unavailable, type TokenInspection } from './tokenization.js';

export interface ModelConfiguration { provider?: string; mode?: string; model?: string; url?: string; apiKey?: string; contextLength?: number; maxOutputTokens?: number }
export function modelConfiguration(value: Record<string, unknown>): ModelConfiguration {
  if (typeof value.provider !== 'string' && typeof value.mode !== 'string') throw new Error('Invalid model settings');
  for (const key of ['provider', 'mode', 'model', 'url', 'apiKey']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error('Invalid model settings');
  for (const key of ['contextLength', 'maxOutputTokens']) if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) <= 0)) throw new Error('Model limits must be positive integers');
  return value as ModelConfiguration;
}
export function providerName(value: string): Provider {
  if (!PROVIDERS.includes(value as Provider)) throw new Error('Choose MYHARNESS_PROVIDER or browser provider: demo, ollama, gemini, openai, anthropic or vertex.');
  return value as Provider;
}
export function configuredModel(provider: Provider, model?: string): string {
  const result = model?.trim() || (provider === 'gemini' ? 'gemini-3.8-flash' : provider === 'demo' ? 'scripted-demo' : provider === 'ollama' ? 'qwen3:8b' : '');
  if (!result || /[\s/?#]/.test(result)) throw new Error('Enter an explicit API model ID.');
  return result;
}

/** Provider registry and ephemeral credential vault. No keys are returned through inspection. */
export class ProviderRouter implements ModelAdapter {
  selected: Provider;
  private readonly keys = new Map<string, string>();
  constructor(private readonly fetch_: FetchLike, private readonly ports: Partial<Record<Provider, ModelPort>>, selected: Provider = 'ollama', keys: Partial<Record<CloudProvider, string>> = {}) {
    this.selected = selected;
    for (const [provider, key] of Object.entries(keys)) this.keys.set(provider, key);
  }
  setKey(provider: Provider, key: string): void { this.keys.set(provider, key); }
  forget(provider: Provider): void { this.keys.delete(provider); }
  setLegacy(provider: Provider, port: ModelPort): void { this.ports[provider] = port; }
  adapter(provider: string = this.selected, key?: string): ModelAdapter {
    const name = providerName(provider);
    if (name === 'gemini' || name === 'openai' || name === 'anthropic') return new CloudAdapter(name, this.fetch_, key ?? this.keys.get(name) ?? '');
    const port = this.ports[name]; if (!port) throw new Error(`Provider ${name} is not configured in this runtime.`);
    return new LegacyModelAdapter(port);
  }
  ready(provider: string): boolean { try { return this.adapter(provider).ready(provider); } catch { return false; } }
  prepare(input: ModelRequest): Record<string, unknown> { return this.adapter(input.provider).prepare(input); }
  describe(model: string, signal?: AbortSignal): Promise<ModelDescription> { return this.adapter().describe(model, signal); }
  stream(input: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> { return this.adapter(input.provider).stream(input, signal); }
  complete(input: ModelRequest, signal?: AbortSignal): Promise<ModelResult> { return this.adapter(input.provider).complete(input, signal); }
  requestMetadata(input: ModelRequest): Record<string, unknown> {
    const name = input.provider ?? this.selected, adapter = this.adapter(name);
    if (adapter instanceof LegacyModelAdapter) return adapter.port.requestMetadata?.(input) ?? {};
    return { provider: name, wire_request: adapter.prepare(input) };
  }
  inspectTokens(input: ModelRequest, signal?: AbortSignal): Promise<TokenInspection> {
    const adapter = this.adapter(input.provider);
    if (adapter instanceof LegacyModelAdapter && adapter.port.inspectTokens) return adapter.port.inspectTokens(input, signal);
    return Promise.resolve(unavailable(input.model, input.provider ?? this.selected, this.selected === 'demo' ? 'The scripted demo is not an LLM and has no model tokenizer.' : 'Individual input token IDs are not available through this adapter.'));
  }
}

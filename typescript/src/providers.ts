import type { ModelRequest } from './core.js';
import type { ModelPort } from './harness.js';
import type { FetchLike } from './ollama.js';
import { LegacyModelAdapter, PROVIDERS, type ModelAdapter, type ModelDescription, type ModelEvent, type ModelResult, type Provider } from './model.js';
import { CloudAdapter, type CloudProvider } from './cloud.js';
import { CHAT_COMPLETIONS_PROVIDERS, ChatCompletionsAdapter, customEndpoint, type ChatCompletionsProvider } from './chat-completions.js';
import { unavailable, type TokenInspection, type InspectionProgress } from './tokenization.js';

export interface ModelConfiguration { provider?: string; mode?: string; model?: string; url?: string; apiKey?: string; contextLength?: number; maxOutputTokens?: number }
export function modelConfiguration(value: Record<string, unknown>): ModelConfiguration {
  if (typeof value.provider !== 'string' && typeof value.mode !== 'string') throw new Error('Invalid model settings');
  for (const key of ['provider', 'mode', 'model', 'url', 'apiKey']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error('Invalid model settings');
  for (const key of ['contextLength', 'maxOutputTokens']) if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) <= 0)) throw new Error('Model limits must be positive integers');
  return value as ModelConfiguration;
}
export function providerName(value: string): Provider {
  if (!PROVIDERS.includes(value as Provider)) throw new Error('Choose MYHARNESS_PROVIDER or browser provider: demo, ollama, gemini, openai, anthropic, openrouter, groq, mistral, cerebras, custom or vertex.');
  return value as Provider;
}
export function configuredModel(provider: Provider, model?: string): string {
  const result = model?.trim() || (provider === 'gemini' ? 'gemini-3.8-flash' : provider === 'demo' ? 'scripted-demo' : provider === 'ollama' ? 'qwen3:8b' : '');
  // OpenRouter and Groq IDs may name the vendor first, such as openai/gpt-5 or deepseek/deepseek-chat:free.
  if (!result || (CHAT_COMPLETIONS_PROVIDERS.includes(provider as ChatCompletionsProvider) ? /[\s?#]|^\/|\/$|\/\// : /[\s/?#]/).test(result)) throw new Error('Enter an explicit API model ID.');
  return result;
}

/** Provider registry and ephemeral credential vault. No keys are returned through inspection. */
export class ProviderRouter implements ModelAdapter {
  selected: Provider;
  private readonly keys = new Map<string, string>();
  /** Addresses of user-named servers, kept in memory like keys. */
  private readonly bases = new Map<string, string>();
  constructor(private readonly fetch_: FetchLike, private readonly ports: Partial<Record<Provider, ModelPort>>, selected: Provider = 'ollama', keys: Partial<Record<CloudProvider | ChatCompletionsProvider, string>> = {}) {
    this.selected = selected;
    for (const [provider, key] of Object.entries(keys)) this.keys.set(provider, key);
  }
  setKey(provider: Provider, key: string): void { this.keys.set(provider, key); }
  setBase(provider: Provider, url: string): void { this.bases.set(provider, customEndpoint(url)); }
  clearKeys(): void { this.keys.clear(); }
  forget(provider: Provider): void { this.keys.delete(provider); }
  setLegacy(provider: Provider, port: ModelPort): void { this.ports[provider] = port; }
  adapter(provider: string = this.selected, key?: string, url?: string): ModelAdapter {
    const name = providerName(provider);
    if (CHAT_COMPLETIONS_PROVIDERS.includes(name as ChatCompletionsProvider)) return new ChatCompletionsAdapter(name as ChatCompletionsProvider, this.fetch_, key ?? this.keys.get(name) ?? '', name === 'custom' ? this.customBase(url) : undefined);
    if (name === 'gemini' || name === 'openai' || name === 'anthropic') return new CloudAdapter(name, this.fetch_, key ?? this.keys.get(name) ?? '');
    const port = this.ports[name]; if (!port) throw new Error(`Provider ${name} is not configured in this runtime.`);
    return new LegacyModelAdapter(port);
  }
  private customBase(url?: string): string | undefined { return url === undefined ? this.bases.get('custom') ?? '' : customEndpoint(url); }
  ready(provider: string): boolean { try { return this.adapter(provider).ready(provider); } catch { return false; } }
  prepare(input: ModelRequest): Record<string, unknown> { return this.adapter(input.provider).prepare(input); }
  describe(model: string, signal?: AbortSignal): Promise<ModelDescription> { return this.adapter().describe(model, signal); }
  async vocabularyInfo(model: string, signal?: AbortSignal): Promise<Record<string, unknown>> { return await this.adapter().vocabularyInfo?.(model, signal) ?? {}; }
  stream(input: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> { return this.adapter(input.provider).stream(input, signal); }
  complete(input: ModelRequest, signal?: AbortSignal): Promise<ModelResult> { return this.adapter(input.provider).complete(input, signal); }
  requestMetadata(input: ModelRequest): Record<string, unknown> {
    const name = input.provider ?? this.selected, adapter = this.adapter(name);
    if (adapter instanceof LegacyModelAdapter) return adapter.port.requestMetadata?.(input) ?? {};
    return { provider: name, wire_request: adapter.prepare(input) };
  }
  inspectTokens(input: ModelRequest, signal?: AbortSignal, progress?: InspectionProgress): Promise<TokenInspection> {
    const adapter = this.adapter(input.provider);
    if (adapter instanceof LegacyModelAdapter && adapter.port.inspectTokens) return adapter.port.inspectTokens(input, signal, progress);
    return Promise.resolve(unavailable(input.model, input.provider ?? this.selected, this.selected === 'demo' ? 'The scripted demo is not an LLM and has no model tokenizer.' : 'Individual input token IDs are not available through this adapter.'));
  }
}

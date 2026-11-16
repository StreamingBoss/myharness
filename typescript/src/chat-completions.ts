import { DiagnosticError, failureDetails } from './failure.js';
import type { ChatMessage, ModelRequest, ToolCall } from './core.js';
import type { FetchLike, FetchResponse } from './ollama.js';
import { validateCalls, type ModelAdapter, type ModelDescription, type ModelEvent, type ModelOption, type ModelResult, type ModelUsage } from './model.js';
import { readSSE } from './sse.js';
import { unavailable, type TokenInspection } from './tokenization.js';

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const list = (value: unknown): Data[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Services that speak OpenAI-compatible Chat Completions, and `custom` for any server the user names. One adapter serves them all. */
export type ChatCompletionsProvider = 'openrouter' | 'groq' | 'mistral' | 'cerebras' | 'custom';
export const CHAT_COMPLETIONS_PROVIDERS: readonly ChatCompletionsProvider[] = ['openrouter', 'groq', 'mistral', 'cerebras', 'custom'];
interface Preset {
  name: string;
  /** Empty for `custom`: the user supplies the address. */
  base: string;
  /** How `describe` checks the key and model: OpenRouter's own endpoints, or the model listing. */
  describe: 'openrouter' | 'listing';
  /** Mistral rejects fields it does not know, and Groq and Cerebras document the newer name. */
  maxTokens: 'max_tokens' | 'max_completion_tokens';
  /** Extra request headers. Only OpenRouter takes one; the others refuse unknown headers in a browser preflight. */
  headers: Record<string, string>;
  models: string;
  /** Keeps models that can take tool definitions, when the listing says so. */
  keep(model: Data): boolean;
}
const PRESETS: Record<ChatCompletionsProvider, Preset> = {
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', describe: 'openrouter', maxTokens: 'max_tokens', headers: { 'x-openrouter-title': 'MyHarness' }, models: '/models?supported_parameters=tools', keep: () => true },
  // Groq lists speech, text-to-speech and safety-classifier models beside chat models.
  groq: { name: 'Groq', base: 'https://api.groq.com/openai/v1', describe: 'listing', maxTokens: 'max_completion_tokens', headers: {}, models: '/models', keep: model => model.active !== false && !/whisper|tts|orpheus|guard/i.test(text(model.id)) },
  mistral: { name: 'Mistral', base: 'https://api.mistral.ai/v1', describe: 'listing', maxTokens: 'max_tokens', headers: {}, models: '/models', keep: model => object(model.capabilities).function_calling === true },
  cerebras: { name: 'Cerebras', base: 'https://api.cerebras.ai/v1', describe: 'listing', maxTokens: 'max_completion_tokens', headers: {}, models: '/models', keep: () => true },
  custom: { name: 'Custom server', base: '', describe: 'listing', maxTokens: 'max_tokens', headers: {}, models: '/models', keep: () => true },
};

/**
 * Validates the address of a user-named server and returns it without a trailing slash. HTTPS works for any host; plain HTTP
 * only for this computer or the local network, where servers such as LM Studio and llama.cpp listen. A password in the address is refused.
 */
export function customEndpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('Enter the full address of your server, for example https://host/v1 or http://localhost:1234/v1.'); }
  const local = /^(localhost|\[::1\]|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|[^.]+\.local)$/i.test(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new Error('Use an https:// address (http:// only for this computer or your local network) with no password, query or fragment.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function argumentsObject(value: string): Data {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Invalid tool arguments; no tools were executed.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid tool arguments; no tools were executed.');
  return parsed as Data;
}

/** Message content is a string, or (Mistral reasoning models) a list of text and thinking parts. */
function contentParts(value: unknown): { content: string; thinking: string } {
  if (typeof value === 'string') return { content: value, thinking: '' };
  let content = '', thinking = '';
  for (const part of list(value)) {
    if (part.type === 'text') content += text(part.text);
    else if (part.type === 'thinking') thinking += list(part.thinking).map(item => text(item.text)).join('');
  }
  return { content, thinking };
}

/** Chat Completions history. Assistant turns are replayed exactly as the provider returned them, with any reasoning details. */
function history(provider: string, messages: ChatMessage[]): Data[] {
  return messages.map(message => {
    if (message.role === 'assistant' && message.continuation) {
      if (message.continuation.provider !== provider) throw new Error('Conversation belongs to another provider. Start a new session.');
      return structuredClone(message.continuation.items[0]!);
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('Tool result is missing its call ID. Start a new session.');
      return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
    }
    if (message.tool_calls?.length) throw new Error('Native tool history is missing. Start a new session.');
    return { role: message.role, content: message.content };
  });
}

/** Streamed reasoning details arrive in fragments sharing an index; their text fields are joined. */
function mergeDetails(details: Data[], part: Data): void {
  const previous = typeof part.index === 'number' ? details.find(item => item.index === part.index && item.type === part.type) : undefined;
  if (!previous) { details.push({ ...part }); return; }
  for (const [key, value] of Object.entries(part)) {
    if (typeof value === 'string' && ['text', 'summary', 'data'].includes(key)) previous[key] = text(previous[key]) + value;
    else previous[key] = value;
  }
}

/**
 * OpenAI-compatible Chat Completions adapter for OpenRouter, Groq, Mistral and Cerebras.
 * Stateless and transport-free: the key is a private, ephemeral capability and never part of the prepared body.
 */
export class ChatCompletionsAdapter implements ModelAdapter {
  private readonly preset: Preset;
  private readonly base: string;
  constructor(readonly provider: ChatCompletionsProvider, private readonly fetch_: FetchLike, private readonly apiKey: string, base?: string) { this.preset = PRESETS[provider]; this.base = base ?? this.preset.base; }
  /** A named service needs its key. A custom server needs its address; many local servers need no key at all. */
  ready(): boolean { return this.provider !== 'custom' ? Boolean(this.apiKey.trim()) : Boolean(this.base); }
  prepare(input: ModelRequest): Data {
    const tools = input.tools ?? [];
    return { model: input.model, messages: history(this.provider, input.messages), stream: input.stream, [this.preset.maxTokens]: input.options.num_predict ?? 2048, ...(tools.length ? { tools } : {}) };
  }
  /** Models that accept tool definitions: the harness needs tools to act. */
  async listModels(): Promise<ModelOption[]> {
    const page = object(await (await this.send(this.base + this.preset.models, 'GET', undefined, undefined, 10_000)).json());
    const models = new Map<string, ModelOption>();
    for (const model of list(page.data)) { const id = text(model.id); if (id && this.preset.keep(model)) models.set(id, { id, label: text(model.name) || id }); }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  async describe(model: string, signal?: AbortSignal): Promise<ModelDescription> {
    if (this.preset.describe === 'openrouter') {
      await this.send(`${this.base}/key`, 'GET', undefined, signal);
      await this.send(`${this.base}/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`, 'GET', undefined, signal);
    } else {
      // The listing checks the key and the model in one request, whatever characters the model ID holds.
      const page = object(await (await this.send(this.base + this.preset.models, 'GET', undefined, signal)).json());
      if (!list(page.data).some(item => item.id === model && this.preset.keep(item))) throw new Error(`${this.provider} request failed (HTTP 404). Check the model ID and that it accepts tools.`);
    }
    return { provider: this.provider, ready: true, template: `${this.preset.name} constructs the model's internal prompt template; it is not exposed.`, parameters: 'Stateless text and harness tools. Context limit is a user-configured working limit.' };
  }
  requestMetadata(input: ModelRequest): Data { return { provider: this.provider, wire_request: this.prepare(input) }; }
  async inspectTokens(input: ModelRequest): Promise<TokenInspection> {
    return unavailable(input.model, this.provider, `${this.preset.name} does not expose individual input token IDs. Generation usage is shown separately.`);
  }
  private async send(url: string, method: 'GET' | 'POST', body?: Data, signal?: AbortSignal, timeoutMs = 180_000): Promise<FetchResponse> {
    if (!this.ready()) throw new Error(this.provider === 'custom' ? 'Enter the address of your server before continuing.' : `Enter an API key for ${this.provider} before continuing.`);
    const headers = { 'content-type': 'application/json', ...(this.apiKey.trim() ? { authorization: `Bearer ${this.apiKey}` } : {}), ...this.preset.headers };
    // Detached first: a browser's native fetch refuses to be called as a method of this adapter.
    const fetch_ = this.fetch_;
    let response: FetchResponse;
    try { response = await fetch_(url, { method, headers, redirect: 'error', ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); }
    catch { if (signal?.aborted) throw new Error('stopped by the user'); throw new DiagnosticError(failureDetails(`Could not connect to ${this.provider}. Check browser access and your network connection.`, 'model', this.provider, 'Check the model service and network connection, then retry.', timeoutMs)); }
    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403 ? 'Check your API key and account access.'
        : response.status === 402 ? (this.provider === 'openrouter' ? 'Your OpenRouter credits are used up. Add credits or choose a free model (its ID ends in :free).' : 'Your account has no credits left. Check billing with the provider.')
        : response.status === 404 ? 'Check the model ID and its availability on your account.' : response.status === 429 ? 'Quota or rate limit reached. Wait before retrying or check your provider account.' : 'Check provider availability and request limits.';
      throw new Error(`${this.provider} request failed (HTTP ${response.status}). ${reason}`);
    }
    return response;
  }
  async complete(input: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    const response = await this.send(`${this.base}/chat/completions`, 'POST', this.prepare({ ...input, stream: false }), signal);
    return this.normalize(object(await response.json()));
  }
  async *stream(input: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
    const response = await this.send(`${this.base}/chat/completions`, 'POST', this.prepare({ ...input, stream: true }), signal);
    const calls = new Map<number, { id: string; name: string; arguments: string }>(), details: Data[] = [];
    let content = '', reasoning = '', finish = '', usage: unknown;
    for await (const event of readSSE(response)) {
      if (event.error) throw new Error(`${this.provider} generation failed; no tools were executed.`);
      const choice = list(event.choices)[0] ?? {}, delta = object(choice.delta), parts = contentParts(delta.content);
      const part = parts.content, thought = text(delta.reasoning) + parts.thinking;
      content += part; reasoning += thought;
      if (part || thought) yield { type: 'delta', content: part, thinking: thought, terminal: false };
      for (const detail of list(delta.reasoning_details)) mergeDetails(details, detail);
      for (const call of list(delta.tool_calls)) {
        const id = text(call.id), index = Number(call.index ?? 0);
        const current = calls.get(index) ?? { id: '', name: '', arguments: '' }, fn = object(call.function);
        current.id ||= id; current.name += text(fn.name); current.arguments += text(fn.arguments);
        calls.set(index, current);
      }
      if (choice.finish_reason) finish = text(choice.finish_reason);
      // Groq reports streamed usage under x_groq.
      if (event.usage) usage = event.usage; else if (object(event.x_groq).usage) usage = object(event.x_groq).usage;
    }
    if (!finish) throw new Error('Provider stream ended before completion; no tools were executed.');
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
    const message = { role: 'assistant', content, ...(reasoning ? { reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(details.length ? { reasoning_details: details } : {}) };
    yield { type: 'completed', result: this.normalize({ choices: [{ message, finish_reason: finish }], ...(usage ? { usage } : {}) }) };
  }
  private normalize(raw: Data): ModelResult {
    const choice = list(raw.choices)[0] ?? {}, message = object(choice.message), calls: ToolCall[] = [], parts = contentParts(message.content);
    const toolCalls = list(message.tool_calls).map(call => {
      const fn = object(call.function), id = text(call.id), args = text(fn.arguments) || '{}';
      if (!id) throw new Error('Provider tool call is missing its ID; no tools were executed.');
      calls.push({ id, function: { name: text(fn.name), arguments: argumentsObject(args) } });
      return { id, type: 'function', function: { name: text(fn.name), arguments: args } };
    });
    validateCalls(calls);
    const details = list(message.reasoning_details);
    const replay = { role: 'assistant', content: parts.content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(details.length ? { reasoning_details: details } : {}) };
    const usage = object(raw.usage), resultUsage: ModelUsage = {};
    const counts = { input: usage.prompt_tokens, output: usage.completion_tokens, cached: object(usage.prompt_tokens_details).cached_tokens, reasoning: object(usage.completion_tokens_details).reasoning_tokens };
    for (const [key, value] of Object.entries(counts)) { const count = number(value); if (count !== undefined) resultUsage[key as keyof ModelUsage] = count; }
    const reason = text(choice.finish_reason);
    const status = reason === 'length' ? 'length' : reason === 'content_filter' ? 'blocked' : ['stop', 'tool_calls'].includes(reason) ? 'completed' : 'failed';
    return { message: { role: 'assistant', content: replay.content, ...(calls.length ? { tool_calls: calls } : {}), continuation: { provider: this.provider, items: [replay] } }, thinking: text(message.reasoning) + parts.thinking, usage: resultUsage, status, raw };
  }
}

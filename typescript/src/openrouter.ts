import { DiagnosticError, failureDetails } from './failure.js';
import type { ChatMessage, ModelRequest, ToolCall } from './core.js';
import type { FetchLike, FetchResponse } from './ollama.js';
import { validateCalls, type ModelAdapter, type ModelDescription, type ModelEvent, type ModelOption, type ModelResult, type ModelUsage } from './model.js';
import { readSSE } from './sse.js';
import { unavailable, type TokenInspection } from './tokenization.js';

type Data = Record<string, unknown>;
const BASE = 'https://openrouter.ai/api/v1';
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const list = (value: unknown): Data[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function argumentsObject(value: string): Data {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Invalid tool arguments; no tools were executed.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid tool arguments; no tools were executed.');
  return parsed as Data;
}

/** Chat Completions history. Assistant turns are replayed exactly as OpenRouter returned them, with their reasoning details. */
function history(messages: ChatMessage[]): Data[] {
  return messages.map(message => {
    if (message.role === 'assistant' && message.continuation) {
      if (message.continuation.provider !== 'openrouter') throw new Error('Conversation belongs to another provider. Start a new session.');
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
 * OpenRouter adapter (OpenAI-compatible Chat Completions). One key reaches many model vendors.
 * Stateless and transport-free: the key is a private, ephemeral capability and never part of the prepared body.
 */
export class OpenRouterAdapter implements ModelAdapter {
  readonly provider = 'openrouter';
  constructor(private readonly fetch_: FetchLike, private readonly apiKey: string) {}
  ready(): boolean { return Boolean(this.apiKey.trim()); }
  prepare(input: ModelRequest): Data {
    const tools = input.tools ?? [];
    return { model: input.model, messages: history(input.messages), stream: input.stream, max_tokens: input.options.num_predict ?? 2048, ...(tools.length ? { tools } : {}) };
  }
  /** Models that accept tool definitions: the harness needs tools to act. */
  async listModels(): Promise<ModelOption[]> {
    const page = object(await (await this.send(`${BASE}/models?supported_parameters=tools`, 'GET', undefined, undefined, 10_000)).json());
    const models = new Map<string, ModelOption>();
    for (const model of list(page.data)) { const id = text(model.id); if (id) models.set(id, { id, label: text(model.name) || id }); }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  async describe(model: string, signal?: AbortSignal): Promise<ModelDescription> {
    await this.send(`${BASE}/key`, 'GET', undefined, signal);
    await this.send(`${BASE}/models/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`, 'GET', undefined, signal);
    return { provider: this.provider, ready: true, template: 'OpenRouter forwards the request to a model vendor, which constructs its internal prompt template; it is not exposed.', parameters: 'Stateless text and harness tools. Context limit is a user-configured working limit.' };
  }
  requestMetadata(input: ModelRequest): Data { return { provider: this.provider, wire_request: this.prepare(input) }; }
  async inspectTokens(input: ModelRequest): Promise<TokenInspection> {
    return unavailable(input.model, this.provider, 'OpenRouter does not expose individual input token IDs. Generation usage is shown separately.');
  }
  private async send(url: string, method: 'GET' | 'POST', body?: Data, signal?: AbortSignal, timeoutMs = 180_000): Promise<FetchResponse> {
    if (!this.ready()) throw new Error('Enter an API key for openrouter before continuing.');
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, 'x-openrouter-title': 'MyHarness' };
    // Detached first: a browser's native fetch refuses to be called as a method of this adapter.
    const fetch_ = this.fetch_;
    let response: FetchResponse;
    try { response = await fetch_(url, { method, headers, redirect: 'error', ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); }
    catch { if (signal?.aborted) throw new Error('stopped by the user'); throw new DiagnosticError(failureDetails('Could not connect to openrouter. Check browser access and your network connection.', 'model', 'openrouter', 'Check the model service and network connection, then retry.', timeoutMs)); }
    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403 ? 'Check your API key and account access.' : response.status === 402 ? 'Your OpenRouter credits are used up. Add credits or choose a free model (its ID ends in :free).'
        : response.status === 404 ? 'Check the model ID and its availability on your account.' : response.status === 429 ? 'Quota or rate limit reached. Wait before retrying or check your provider account.' : 'Check provider availability and request limits.';
      throw new Error(`openrouter request failed (HTTP ${response.status}). ${reason}`);
    }
    return response;
  }
  async complete(input: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    const response = await this.send(`${BASE}/chat/completions`, 'POST', this.prepare({ ...input, stream: false }), signal);
    return this.normalize(object(await response.json()));
  }
  async *stream(input: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
    const response = await this.send(`${BASE}/chat/completions`, 'POST', this.prepare({ ...input, stream: true }), signal);
    const calls = new Map<number, { id: string; name: string; arguments: string }>(), details: Data[] = [];
    let content = '', reasoning = '', finish = '', usage: unknown;
    for await (const event of readSSE(response)) {
      if (event.error) throw new Error('openrouter generation failed; no tools were executed.');
      const choice = list(event.choices)[0] ?? {}, delta = object(choice.delta);
      const part = text(delta.content), thought = text(delta.reasoning);
      content += part; reasoning += thought;
      if (part || thought) yield { type: 'delta', content: part, thinking: thought, terminal: false };
      for (const detail of list(delta.reasoning_details)) mergeDetails(details, detail);
      for (const call of list(delta.tool_calls)) {
        const index = Number(call.index ?? 0), current = calls.get(index) ?? { id: '', name: '', arguments: '' }, fn = object(call.function);
        current.id ||= text(call.id); current.name += text(fn.name); current.arguments += text(fn.arguments);
        calls.set(index, current);
      }
      if (choice.finish_reason) finish = text(choice.finish_reason);
      if (event.usage) usage = event.usage;
    }
    if (!finish) throw new Error('Provider stream ended before completion; no tools were executed.');
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
    const message = { role: 'assistant', content, ...(reasoning ? { reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(details.length ? { reasoning_details: details } : {}) };
    yield { type: 'completed', result: this.normalize({ choices: [{ message, finish_reason: finish }], ...(usage ? { usage } : {}) }) };
  }
  private normalize(raw: Data): ModelResult {
    const choice = list(raw.choices)[0] ?? {}, message = object(choice.message), calls: ToolCall[] = [];
    const toolCalls = list(message.tool_calls).map(call => {
      const fn = object(call.function), id = text(call.id), args = text(fn.arguments) || '{}';
      if (!id) throw new Error('Provider tool call is missing its ID; no tools were executed.');
      calls.push({ id, function: { name: text(fn.name), arguments: argumentsObject(args) } });
      return { id, type: 'function', function: { name: text(fn.name), arguments: args } };
    });
    validateCalls(calls);
    const details = list(message.reasoning_details);
    const replay = { role: 'assistant', content: text(message.content), ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(details.length ? { reasoning_details: details } : {}) };
    const usage = object(raw.usage), resultUsage: ModelUsage = {};
    const counts = { input: usage.prompt_tokens, output: usage.completion_tokens, cached: object(usage.prompt_tokens_details).cached_tokens, reasoning: object(usage.completion_tokens_details).reasoning_tokens };
    for (const [key, value] of Object.entries(counts)) { const count = number(value); if (count !== undefined) resultUsage[key as keyof ModelUsage] = count; }
    const reason = text(choice.finish_reason);
    const status = reason === 'length' ? 'length' : reason === 'content_filter' ? 'blocked' : ['stop', 'tool_calls'].includes(reason) ? 'completed' : 'failed';
    return { message: { role: 'assistant', content: replay.content, ...(calls.length ? { tool_calls: calls } : {}), continuation: { provider: this.provider, items: [replay] } }, thinking: text(message.reasoning), usage: resultUsage, status, raw };
  }
}

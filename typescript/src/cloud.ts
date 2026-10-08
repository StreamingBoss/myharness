import type { ModelOption } from './model.js';
import type { ChatMessage, ModelRequest, ToolCall } from './core.js';
import type { FetchLike, FetchResponse } from './ollama.js';
import { validateCalls, type ModelAdapter, type ModelDescription, type ModelEvent, type ModelResult, type ModelUsage } from './model.js';
import { readSSE } from './sse.js';
import { unavailable, type TokenInspection } from './tokenization.js';

type Data = Record<string, unknown>;
export type CloudProvider = 'gemini' | 'openai' | 'anthropic';
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const list = (value: unknown): Data[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const endpoints = { gemini: 'https://generativelanguage.googleapis.com/v1beta/interactions', openai: 'https://api.openai.com/v1/responses', anthropic: 'https://api.anthropic.com/v1/messages' };

function argumentsObject(value: unknown): Data {
  let parsed: unknown;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new Error('Invalid tool arguments; no tools were executed.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid tool arguments; no tools were executed.');
  return parsed as Data;
}
function nativeHistory(provider: CloudProvider, messages: ChatMessage[]): Data[] {
  const result: Data[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'assistant' && message.continuation) {
      if (message.continuation.provider !== provider) throw new Error('Conversation belongs to another provider. Start a new session.');
      const items = structuredClone(message.continuation.items);
      if (provider === 'anthropic') result.push({ role: 'assistant', content: items });
      else result.push(...items);
    } else if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('Tool result is missing its call ID. Start a new session.');
      if (provider === 'gemini') result.push({ type: 'function_result', name: message.tool_name, call_id: message.tool_call_id, result: [{ type: 'text', text: message.content }] });
      else if (provider === 'openai') result.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
      else {
        const block = { type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content };
        const previous = result.at(-1);
        if (previous?.role === 'user' && Array.isArray(previous.content)) (previous.content as Data[]).push(block);
        else result.push({ role: 'user', content: [block] });
      }
    } else {
      if (message.tool_calls?.length) throw new Error('Native tool history is missing. Start a new session.');
      if (provider === 'gemini') result.push({ type: message.role === 'assistant' ? 'model_output' : 'user_input', content: [{ type: 'text', text: message.content }] });
      else result.push({ role: message.role, content: message.content });
    }
  }
  return result;
}

/** Stateless native cloud adapter shared by Node and Workers. Keys are private, ephemeral capabilities. */
export class CloudAdapter implements ModelAdapter {
  constructor(readonly provider: CloudProvider, private readonly fetch_: FetchLike, private readonly apiKey: string) {}
  ready(): boolean { return Boolean(this.apiKey.trim()); }
  prepare(input: ModelRequest): Data {
    const system = input.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const history = nativeHistory(this.provider, input.messages), max = input.options.num_predict ?? 2048;
    const tools = (input.tools ?? []).map(t => ({ type: 'function', ...t.function }));
    if (this.provider === 'gemini') return { model: input.model, input: history, system_instruction: system, store: false, stream: input.stream, generation_config: { max_output_tokens: max }, ...(tools.length ? { tools } : {}) };
    if (this.provider === 'openai') return { model: input.model, input: history, instructions: system, store: false, include: ['reasoning.encrypted_content'], stream: input.stream, max_output_tokens: max, ...(tools.length ? { tools: tools.map(tool => ({ ...tool, strict: false })) } : {}) };
    return { model: input.model, messages: history, system, stream: input.stream, max_tokens: max,
      ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}) };
  }
  async listModels(): Promise<ModelOption[]> {
    const base = this.provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/models'
      : this.provider === 'openai' ? 'https://api.openai.com/v1/models' : 'https://api.anthropic.com/v1/models';
    const models = new Map<string, ModelOption>(), cursors = new Set<string>();
    let cursor = '';
    do {
      const url = new URL(base);
      if (cursor) url.searchParams.set(this.provider === 'gemini' ? 'pageToken' : 'after_id', cursor);
      const page = object(await (await this.send(url.href, 'GET', undefined, undefined, 10_000)).json());
      for (const model of list(this.provider === 'gemini' ? page.models : page.data)) {
        const id = this.provider === 'gemini' ? text(model.name).replace(/^models\//, '') : text(model.id);
        if (!id) continue;
        if (this.provider === 'gemini' && (!id.startsWith('gemini-') || !Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes('generateContent'))) continue;
        if (this.provider === 'openai' && (!/^(gpt-|o[1-9])/.test(id) || /audio|realtime|transcribe|tts|image|search|instruct/.test(id))) continue;
        models.set(id, { id, label: text(model.displayName ?? model.display_name) || id });
      }
      cursor = this.provider === 'gemini' ? text(page.nextPageToken) : this.provider === 'anthropic' && page.has_more === true ? text(page.last_id) : '';
      if (cursor && cursors.has(cursor)) throw new Error('The provider returned a repeated model-list page.');
      cursors.add(cursor);
    } while (cursor);
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async describe(model: string, signal?: AbortSignal): Promise<ModelDescription> {
    const url = this.provider === 'gemini' ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`
      : this.provider === 'openai' ? `https://api.openai.com/v1/models/${encodeURIComponent(model)}` : `https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`;
    await this.send(url, 'GET', undefined, signal);
    return { provider: this.provider, ready: true, template: 'The provider constructs its internal prompt template; it is not exposed.', parameters: 'Stateless text and harness tools. Context limit is a user-configured working limit.' };
  }
  requestMetadata(input: ModelRequest): Data { return { provider: this.provider, wire_request: this.prepare(input) }; }
  async inspectTokens(input: ModelRequest): Promise<TokenInspection> {
    return unavailable(input.model, this.provider, 'This adapter does not expose individual input token IDs. Generation usage is shown separately.');
  }
  private async send(url: string, method: 'GET' | 'POST', body?: Data, signal?: AbortSignal, timeoutMs = 180_000): Promise<FetchResponse> {
    if (!this.ready()) throw new Error(`Enter an API key for ${this.provider} before continuing.`);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.provider === 'gemini') headers['x-goog-api-key'] = this.apiKey;
    else if (this.provider === 'openai') headers.authorization = `Bearer ${this.apiKey}`;
    else { headers['x-api-key'] = this.apiKey; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-dangerous-direct-browser-access'] = 'true'; }
    const fetch_ = this.fetch_;
    let response: FetchResponse;
    try { response = await fetch_(url, { method, headers, redirect: 'error', ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); }
    catch { if (signal?.aborted) throw new Error('stopped by the user'); throw new Error(`Could not connect to ${this.provider}. Check browser access and your network connection.`); }
    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403 ? 'Check your API key and account access.' : response.status === 404 ? 'Check the model ID and its availability on your account.' : response.status === 429 ? 'Quota or rate limit reached. Wait before retrying or check your provider account.' : 'Check provider availability and request limits.';
      const retry = response.headers?.get('retry-after');
      throw new Error(`${this.provider} request failed (HTTP ${response.status}). ${reason}${retry ? ` Retry after ${retry.replace(/[^\w .:-]/g, '').slice(0, 80)}.` : ''}`);
    }
    return response;
  }
  async complete(input: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    const response = await this.send(endpoints[this.provider], 'POST', this.prepare({ ...input, stream: false }), signal);
    return this.normalize(object(await response.json()));
  }
  async *stream(input: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
    const response = await this.send(endpoints[this.provider], 'POST', this.prepare({ ...input, stream: true }), signal);
    const items = new Map<number, Data>(), args = new Map<number, string>();
    let raw: Data = {}, ended = false;
    for await (const event of readSSE(response)) {
      const type = text(event.event_type), index = Number(event.index ?? event.output_index ?? 0), delta = object(event.delta);
      if (type === 'error' || type === 'interaction.failed' || type === 'response.failed') throw new Error(`${this.provider} generation failed; no tools were executed.`);
      if (this.provider === 'openai') {
        if (type === 'response.output_item.added' || type === 'response.output_item.done') items.set(index, object(event.item));
        if (type === 'response.function_call_arguments.delta') args.set(index, (args.get(index) ?? '') + text(event.delta));
        if (type === 'response.output_text.delta' || type === 'response.reasoning_summary_text.delta') yield { type: 'delta', content: type === 'response.output_text.delta' ? text(event.delta) : '', thinking: type === 'response.reasoning_summary_text.delta' ? text(event.delta) : '', terminal: false };
        if (type === 'response.completed' || type === 'response.incomplete') { raw = object(event.response); ended = true; }
      } else if (this.provider === 'anthropic') {
        if (type === 'message_start') raw = object(event.message);
        if (type === 'content_block_start') { const block = object(event.content_block); items.set(index, block); if (block.type === 'text') yield { type: 'delta', content: text(block.text), thinking: '', terminal: false }; }
        if (type === 'content_block_delta') {
          const block = items.get(index); if (!block) throw new Error('Provider delta has no matching content block.');
          if (delta.type === 'input_json_delta') args.set(index, (args.get(index) ?? '') + text(delta.partial_json));
          else if (delta.type === 'signature_delta') block.signature = text(block.signature) + text(delta.signature);
          else {
            const key = delta.type === 'thinking_delta' ? 'thinking' : 'text', value = text(delta[key]); block[key] = text(block[key]) + value;
            yield { type: 'delta', content: key === 'text' ? value : '', thinking: key === 'thinking' ? value : '', terminal: false };
          }
        }
        if (type === 'message_delta') raw = { ...raw, ...delta, usage: { ...object(raw.usage), ...object(event.usage) } };
        if (type === 'message_stop') ended = true;
      } else {
        if (type === 'step.start' || type === 'step.stop') {
          if (event.step) { const step = object(event.step); items.set(index, step); if (type === 'step.start' && step.type === 'model_output') yield { type: 'delta', content: list(step.content).map(c => text(c.text)).join(''), thinking: '', terminal: false }; }
        }
        if (type === 'step.delta') {
          const step = items.get(index); if (!step) throw new Error('Provider delta has no matching step.');
          if (delta.type === 'arguments_delta' || delta.type === 'arguments') args.set(index, (args.get(index) ?? '') + text(delta.type === 'arguments_delta' ? delta.arguments : delta.partial_arguments));
          else if (delta.type === 'thought_signature') step.signature = delta.signature;
          else if (delta.type === 'text' || delta.type === 'thought_summary') {
            const key = delta.type === 'text' ? 'content' : 'summary';
            const value = text(key === 'content' ? delta.text : object(delta.content).text);
            const content = list(step[key]); content.push({ type: 'text', text: value }); step[key] = content;
            yield { type: 'delta', content: key === 'content' ? value : '', thinking: key === 'summary' ? value : '', terminal: false };
          }
        }
        if (type === 'interaction.completed' || type === 'interaction.complete' || type === 'interaction.incomplete') { raw = object(event.interaction); ended = true; }
      }
    }
    if (!ended) throw new Error('Provider stream ended before completion; no tools were executed.');
    const ordered = [...items.entries()].sort(([a], [b]) => a - b).map(([index, item]) => {
      if (args.has(index)) item[this.provider === 'anthropic' ? 'input' : 'arguments'] = this.provider === 'openai' ? args.get(index) : argumentsObject(args.get(index));
      return item;
    });
    const key = this.provider === 'gemini' ? 'steps' : this.provider === 'openai' ? 'output' : 'content';
    if (!Array.isArray(raw[key]) || !(raw[key] as unknown[]).length) raw[key] = ordered;
    yield { type: 'completed', result: this.normalize(raw) };
  }
  private normalize(raw: Data): ModelResult {
    const items = list(raw[this.provider === 'gemini' ? 'steps' : this.provider === 'openai' ? 'output' : 'content']);
    const calls: ToolCall[] = [], parts: string[] = [], thoughts: string[] = [];
    for (const item of items) {
      if (item.type === 'function_call' || item.type === 'tool_use') {
        const id = text(this.provider === 'openai' ? item.call_id : item.id);
        if (!id) throw new Error('Provider tool call is missing its ID; no tools were executed.');
        calls.push({ id, function: { name: text(item.name), arguments: argumentsObject(item.arguments ?? item.input ?? {}) } });
      } else if (item.type === 'text') parts.push(text(item.text));
      else if (item.type === 'thinking') thoughts.push(text(item.thinking));
      else if (item.type === 'thought' || item.type === 'reasoning') thoughts.push(list(item.summary).map(c => text(c.text)).join(''));
      else if (item.type === 'model_output' || item.type === 'message') {
        for (const content of list(item.content)) if (content.type === 'text' || content.type === 'output_text') parts.push(text(content.text));
      }
    }
    validateCalls(calls);
    const usage = object(raw.usage), resultUsage: ModelUsage = {};
    const counts = this.provider === 'gemini' ? { input: usage.total_input_tokens, output: usage.total_output_tokens, cached: usage.total_cached_tokens, reasoning: usage.total_thought_tokens }
      : { input: usage.input_tokens, output: usage.output_tokens, cached: usage.cache_read_input_tokens ?? object(usage.input_tokens_details).cached_tokens, reasoning: object(usage.output_tokens_details).reasoning_tokens };
    for (const [key, value] of Object.entries(counts)) { const count = number(value); if (count !== undefined) resultUsage[key as keyof ModelUsage] = count; }
    const reason = text(raw.stop_reason ?? object(raw.incomplete_details).reason ?? raw.status);
    const status = ['max_tokens', 'max_output_tokens', 'incomplete'].includes(reason) ? 'length' : ['refusal', 'blocked', 'content_filter'].includes(reason) ? 'blocked'
      : ['completed', 'requires_action', 'end_turn', 'tool_use', 'stop_sequence'].includes(reason) ? 'completed' : 'failed';
    return { message: { role: 'assistant', content: parts.join(''), ...(calls.length ? { tool_calls: calls } : {}), continuation: { provider: this.provider, items } }, thinking: thoughts.join(''), usage: resultUsage, status, raw };
  }
}

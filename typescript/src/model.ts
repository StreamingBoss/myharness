import type { ChatMessage, ModelChunk, ModelRequest, ToolCall, ToolDefinition } from './core.js';
import type { ModelPort } from './harness.js';
import { unavailable, type TokenInspection, type InspectionPort } from './tokenization.js';

export type Provider = 'demo' | 'ollama' | 'gemini' | 'openai' | 'anthropic' | 'vertex';
export const PROVIDERS: readonly Provider[] = ['demo', 'ollama', 'gemini', 'openai', 'anthropic', 'vertex'];
export interface ModelOption { id: string; label: string }
export interface ModelDescription { provider: string; ready: boolean; template: string; parameters: string }
export interface ModelUsage { input?: number; output?: number; cached?: number; reasoning?: number }
export interface ModelResult {
  message: ChatMessage; thinking: string; usage: ModelUsage;
  status: 'completed' | 'length' | 'blocked' | 'failed'; raw: Record<string, unknown>;
}
export type ModelEvent = { type: 'delta'; content: string; thinking: string; terminal: boolean } | { type: 'completed'; result: ModelResult };
/** Transport-free boundary. Prepared bodies contain no authentication material. */
export interface ModelAdapter extends InspectionPort {
  prepare(input: ModelRequest): Record<string, unknown>;
  describe(model: string, signal?: AbortSignal): Promise<ModelDescription>;
  ready(provider: string): boolean;
  stream(input: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  complete(input: ModelRequest, signal?: AbortSignal): Promise<ModelResult>;
}

export function validateCalls(calls: ToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    const args = call.function.arguments;
    if (!call.function.name || (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args)))) throw new Error('The model returned invalid tool arguments; no tools were executed.');
    if (call.id) {
      if (ids.has(call.id)) throw new Error('The model returned duplicate tool-call IDs; no tools were executed.');
      ids.add(call.id);
    }
  }
}

/** Validate the whole cloud tool batch before applying any effects. */
export function validateToolBatch(calls: ToolCall[], tools: ToolDefinition[]): void {
  validateCalls(calls);
  for (const call of calls) {
    const definition = tools.find(tool => tool.function.name === call.function.name);
    if (!definition) throw new Error('The model requested an unavailable tool; no tools were executed.');
    const schema = definition.function.parameters as { required?: string[]; properties?: Record<string, { type: string }> };
    const args = call.function.arguments ?? {};
    for (const name of schema.required ?? []) if (args[name] === undefined) throw new Error(`Missing required argument '${name}' for tool '${call.function.name}'; no tools were executed. Send another message to retry.`);
    for (const [name, value] of Object.entries(args)) {
      const type = schema.properties?.[name]?.type;
      if ((type === 'string' && typeof value !== 'string') || (type === 'integer' && !Number.isInteger(value))) throw new Error(`Invalid argument '${name}' for tool '${call.function.name}': expected ${type}; no tools were executed.`);
    }
  }
}

/** Compatibility for existing Ollama, Vertex, scripted and injected model ports. */
export class LegacyModelAdapter implements ModelAdapter {
  constructor(readonly port: ModelPort) {}
  ready(): boolean { return true; }
  requestMetadata(input: ModelRequest): Record<string, unknown> { return this.port.requestMetadata?.(input) ?? {}; }
  inspectTokens(input: ModelRequest, signal?: AbortSignal): Promise<TokenInspection> { return this.port.inspectTokens?.(input, signal) ?? Promise.resolve(unavailable(input.model, this.port.provider ?? 'ollama', 'This model adapter does not support token inspection.')); }
  prepare(input: ModelRequest): Record<string, unknown> { return this.port.requestMetadata?.(input).wire_request as Record<string, unknown> ?? input as unknown as Record<string, unknown>; }
  async describe(model: string, signal?: AbortSignal): Promise<ModelDescription> {
    if (!this.port.request) throw new Error('Model adapter does not support inspection or compaction');
    const data = await this.port.request('show', { model }, signal);
    return { provider: this.port.provider ?? 'ollama', ready: true, template: String(data.template ?? ''), parameters: String(data.parameters ?? '') };
  }
  async *stream(input: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
    yield* legacyEvents(this.port.streamChat(input, signal), () => Boolean(signal?.aborted));
  }
  async complete(input: ModelRequest, signal?: AbortSignal): Promise<ModelResult> {
    if (!this.port.request) throw new Error('Model adapter does not support inspection or compaction');
    const raw = await this.port.request('chat', input, signal);
    const message = raw.message as ChatMessage;
    if (!message || typeof message.content !== 'string') throw new Error('the model returned invalid summary text');
    return { message, thinking: '', usage: {}, status: raw.done_reason === 'length' ? 'length' : 'completed', raw };
  }
}

export async function* legacyEvents(stream: AsyncIterable<string>, stopped: () => boolean = () => false): AsyncGenerator<ModelEvent> {
  let final: ModelChunk = { message: {} };
  const text: string[] = [], thinking: string[] = [], calls: ToolCall[] = [], parts: Record<string, unknown>[] = [];
  for await (const raw of stream) {
    const chunk = JSON.parse(raw) as ModelChunk; final = chunk;
    const content = chunk.message.content ?? '', thought = chunk.message.thinking ?? '';
    text.push(content); thinking.push(thought);
    calls.push(...chunk.message.tool_calls ?? []); parts.push(...chunk.message.provider_parts ?? []);
    yield { type: 'delta', content, thinking: thought, terminal: Boolean(chunk.done) };
  }
  if (stopped()) return;
  if (!final.done) throw new Error('Model stream ended before completion or returned an empty reply; no tools were executed.');
  validateCalls(calls);
  yield { type: 'completed', result: { message: { role: 'assistant', content: text.join(''), ...(calls.length ? { tool_calls: calls } : {}), ...(parts.length ? { provider_parts: parts } : {}) }, thinking: thinking.join(''),
    usage: { input: final.prompt_eval_count ?? 0, output: final.eval_count ?? 0 }, status: (final as ModelChunk & { done_reason?: string }).done_reason === 'length' ? 'length' : 'completed', raw: final as unknown as Record<string, unknown> } };
}

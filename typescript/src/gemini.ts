import type { ChatMessage, ModelRequest } from './core.js';
import type { FetchLike } from './ollama.js';
import { base64Bytes, tokenPiece, unavailable, type TokenInspection } from './tokenization.js';

type Part = Record<string, unknown>;
interface Content { role: string; parts: Part[] }
export type GeminiConnection = { kind: 'developer'; apiKey: string } | { kind: 'vertex'; project: string; location: string; accessToken: string };
interface GeminiResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  modelVersion?: string;
}

/** Preserve provider parts (including function-call IDs and thought signatures) across tool turns. */
export function geminiPayload(payload: ModelRequest): Record<string, unknown> {
  const contents: Content[] = [], system: Part[] = [];
  let pending: { name: string; id?: string }[] = [];
  for (const message of payload.messages) {
    if (message.role === 'system') { system.push({ text: message.content }); continue; }
    let parts: Part[];
    if (message.provider_parts) parts = structuredClone(message.provider_parts);
    else if (message.role === 'tool') {
      const index = pending.findIndex(call => call.name === message.tool_name);
      const call = index >= 0 ? pending.splice(index, 1)[0] : undefined;
      parts = [{ functionResponse: { name: message.tool_name, response: { result: message.content }, ...(call?.id ? { id: call.id } : {}) } }];
    } else {
      parts = [...(message.content ? [{ text: message.content }] : []), ...(message.tool_calls ?? []).map(call => ({ functionCall: { name: call.function.name, args: call.function.arguments ?? {} } }))];
    }
    if (message.role === 'assistant') pending = parts.filter(part => part.functionCall).map(part => part.functionCall as { name: string; id?: string });
    const role = message.role === 'assistant' ? 'model' : 'user';
    // Gemini expects all results from a parallel tool batch in a single user turn.
    const previous = contents.at(-1);
    if (message.role === 'tool' && previous?.role === 'user') previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return { contents, ...(system.length ? { systemInstruction: { parts: system } } : {}),
    ...(payload.tools?.length ? { tools: [{ functionDeclarations: payload.tools.map(tool => ({ name: tool.function.name, description: tool.function.description, parametersJsonSchema: tool.function.parameters })) }] } : {}) };
}
function generationPayload(payload: ModelRequest): Record<string, unknown> {
  const options = payload.options as { num_predict?: number };
  return { ...geminiPayload(payload), generationConfig: options.num_predict ? { maxOutputTokens: options.num_predict } : {} };
}
function normalized(data: GeminiResponse): Record<string, unknown> {
  const candidate = data.candidates?.[0], parts = candidate?.content?.parts ?? [];
  const text = parts.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
  const thinking = parts.filter(part => typeof part.text === 'string' && part.thought).map(part => part.text).join('');
  const calls = parts.filter(part => part.functionCall).map(part => { const call = part.functionCall as { name: string; args?: Record<string, unknown> }; return { function: { name: call.name, arguments: call.args ?? {} } }; });
  return { message: { content: text, thinking, tool_calls: calls, provider_parts: parts }, done: true,
    done_reason: candidate?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
    prompt_eval_count: data.usageMetadata?.promptTokenCount ?? 0,
    eval_count: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
    ...(data.usageMetadata?.cachedContentTokenCount !== undefined ? { cached_count: data.usageMetadata.cachedContentTokenCount } : {}),
    ...(data.usageMetadata?.thoughtsTokenCount !== undefined ? { reasoning_count: data.usageMetadata.thoughtsTokenCount } : {}),
    provider: 'gemini', model_version: data.modelVersion };
}

/** Remote Gemini adapter. Secrets belong to the adapter, never request events or session exports. */
export class GeminiAdapter {
  readonly provider: string;
  constructor(private readonly fetch_: FetchLike, private readonly connection: GeminiConnection) {
    this.provider = connection.kind === 'vertex' ? 'gemini-vertex' : 'gemini-developer';
    const values = connection.kind === 'developer' ? [connection.apiKey] : [connection.project, connection.location, connection.accessToken];
    if (values.some(value => !value.trim())) throw new Error('Gemini connection credentials and project/location must not be empty');
  }
  requestMetadata(payload: ModelRequest): Record<string, unknown> { return { provider: this.provider, wire_request: generationPayload(payload) }; }
  private endpoint(model: string, method: string): string {
    if (!/^gemini-[\w.-]+$/.test(model)) throw new Error('Select an explicit Gemini model ID (gemini-…)');
    if (this.connection.kind === 'developer') return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${method}`;
    const { project, location } = this.connection;
    if (!/^[\w-]+$/.test(project) || !/^[\w-]+$/.test(location)) throw new Error('Invalid Vertex project or location');
    const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:${method}`;
  }
  private async call(model: string, method: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const headers = this.connection.kind === 'developer' ? { 'x-goog-api-key': this.connection.apiKey } : { authorization: `Bearer ${this.connection.accessToken}` };
    const response = await this.fetch_(this.endpoint(model, method), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
    // Do not echo provider errors: these can contain credentials or request contents.
    if (!response.ok) throw new Error(`Gemini ${method} failed (HTTP ${response.status}). Check credentials, model support and quota.`);
    return await response.json() as Record<string, unknown>;
  }
  async *streamChat(payload: ModelRequest, signal?: AbortSignal): AsyncGenerator<string> {
    yield JSON.stringify(await this.request('chat', payload, signal));
  }
  async request(endpoint: string, value: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (endpoint === 'show') return { template: 'Gemini formats chat on the provider server. Its complete internal template is not exposed.', parameters: 'Remote Gemini; usage counts come from the provider.' };
    if (endpoint !== 'chat') throw new Error('Unsupported Gemini inspection endpoint');
    const payload = value as ModelRequest & { think?: boolean; options: { num_predict?: number } };

    // Preserve the model default thinking policy; signatures are retained in provider_parts.
    const data = await this.call(payload.model, 'generateContent', generationPayload(payload), signal);
    return normalized(data as GeminiResponse);
  }
  async inspectTokens(payload: ModelRequest, signal?: AbortSignal): Promise<TokenInspection> {
    const wire = geminiPayload(payload), result = unavailable(payload.model, this.provider, 'Gemini does not expose its complete internal inference input sequence.');
    if (this.connection.kind === 'developer') {
      const data = await this.call(payload.model, 'countTokens', { generateContentRequest: { model: `models/${payload.model}`, ...wire } }, signal);
      if (!Number.isInteger(data.totalTokens) || (data.totalTokens as number) < 0) throw new Error('Gemini did not return a valid token count');
      return { ...result, source: 'Gemini Developer API countTokens', fidelity: 'count-only', count: data.totalTokens as number,
        explanation: 'Google returned a token count for this saved request. This API does not return individual input token pieces or IDs; no coloured token sequence is available.',
        coverage: 'Submitted contents, system instructions and function declarations, through generateContentRequest.',
        limitations: ['A separate count request is not an inference trace; its count may differ from generation usage.', 'Hidden provider formatting and internal tokens are not exposed.'] };
    }
    // computeTokens supports text-only content, not the full GenerateContentRequest.
    const groups: TokenInspection['groups'] = [];
    for (const [index, message] of payload.messages.entries()) {
      if (!message.content || message.role === 'tool') continue;
      const role = message.role === 'assistant' ? 'model' : 'user';
      const data = await this.call(payload.model, 'computeTokens', { contents: [{ role, parts: [{ text: message.content }] }] }, signal);
      const infos = data.tokensInfo as { tokenIds?: unknown[]; tokens?: unknown[] }[] | undefined;
      if (!Array.isArray(infos) || !infos.length) throw new Error('Gemini did not return token pieces for this model');
      const tokens = infos.flatMap(info => {
        if (!Array.isArray(info.tokenIds) || !Array.isArray(info.tokens) || info.tokenIds.length !== info.tokens.length) throw new Error('Gemini returned inconsistent token IDs and pieces');
        return info.tokenIds.map((id, i) => tokenPiece(id, base64Bytes(info.tokens![i])));
      });
      groups.push({ label: `Message ${index + 1} · ${message.role} text`, tokens });
    }
    return { ...result, source: 'Vertex AI computeTokens', fidelity: 'provider-content', groups, count: groups.reduce((total, group) => total + group.tokens.length, 0),
      explanation: 'Each coloured piece and ID was returned by Google for the selected model, tokenizing the saved message text separately. Click a piece for its ID and bytes.',
      coverage: 'Text of system, user and assistant messages. System text is submitted as user text solely for tokenization.',
      limitations: ['Exact provider tokenization of these text segments; not a capture of the full inference input.', 'Function declarations, function calls/results, thought signatures, role markers and hidden formatting are excluded.', 'Counts cover only the displayed text, so they need not equal the generation input count.', 'Model aliases may resolve to a newer revision when inspection runs.'] };
  }
}

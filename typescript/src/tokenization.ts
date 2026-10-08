import type { ModelRequest } from './core.js';

/** Evidence about tokenization, never an implicit claim of inference capture. */
export interface TokenPiece { id: string; bytes: number[] }
export interface TokenGroup { label: string; tokens: TokenPiece[] }
export interface TokenInspection {
  model: string;
  provider: string;
  source: string;
  fidelity: 'provider-content' | 'configured-tokenizer' | 'count-only' | 'unavailable';
  explanation: string;
  coverage: string;
  limitations: string[];
  groups: TokenGroup[];
  renderedPrompt?: string;
  count?: number;
  measuredCount?: number;
}
export const TOKENIZATION_PROGRESS = {
  inspecting: 'Inspecting saved request…',
  locating: 'Locating the matching Ollama model file…',
  loading: 'Loading the tokenizer model in llama.cpp… First startup can take time.',
  reusing: 'Reusing the running tokenizer…',
  rendering: 'Rendering the saved prompt with Ollama…',
  tokenizing: 'Tokenizing the rendered prompt with llama.cpp…',
};
export type TokenizationStage = keyof typeof TOKENIZATION_PROGRESS;
export type InspectionProgress = (stage: TokenizationStage) => void;
export interface TokenizationProgress { sessionId: string; eventIndex: number; stage: TokenizationStage; message: string }
export interface InspectionPort {
  readonly provider?: string;
  requestMetadata?(payload: ModelRequest): Record<string, unknown>;
  inspectTokens?(payload: ModelRequest, signal?: AbortSignal, progress?: InspectionProgress): Promise<TokenInspection>;
}
export function unavailable(model: string, provider: string, explanation: string): TokenInspection {
  return { model, provider, source: 'No token sequence available', fidelity: 'unavailable', explanation,
    coverage: 'No token pieces or IDs are shown.', limitations: ['No inference input sequence was captured.'], groups: [] };
}
/** IDs are strings: some providers encode int64 IDs as JSON strings. */
export function tokenPiece(id: unknown, piece: unknown): TokenPiece {
  if (!((typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) || (typeof id === 'string' && /^\d+$/.test(id)))) throw new Error('Tokenizer returned an invalid token ID');
  const bytes = typeof piece === 'string' ? [...new TextEncoder().encode(piece)] : piece;
  if (!Array.isArray(bytes) || !bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('Tokenizer returned invalid token bytes');
  return { id: String(id), bytes };
}
export function base64Bytes(value: unknown): number[] {
  if (typeof value !== 'string') throw new Error('Tokenizer returned invalid base64 bytes');
  return [...atob(value)].map(character => character.charCodeAt(0));
}
/** Restored requests are data; reject malformed exports rather than inspecting arbitrary objects. */
export function savedModelRequest(value: unknown): ModelRequest {
  const data = value as Partial<ModelRequest> | null;
  if (!data || typeof data.model !== 'string' || !Array.isArray(data.messages) || !data.messages.every(message => message && ['system', 'user', 'assistant', 'tool'].includes(message.role) && typeof message.content === 'string') || !data.options || !Number.isInteger(data.options.num_ctx)) throw new Error('Saved model request is invalid');
  return structuredClone(data) as ModelRequest;
}

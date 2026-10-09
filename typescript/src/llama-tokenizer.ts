import type { FetchLike } from './ollama.js';
import { tokenPiece, type TokenGroup } from './tokenization.js';

export interface PromptTokenizer { alias: string; identity: string; tokenize(content: string, signal: AbortSignal): Promise<TokenGroup> }
export interface TokenizerBinding { url: string; alias: string; identity: string }
/** Explicit per-model bindings; never guess a tokenizer from a model-name substring. */
export function tokenizerBindings(text: string): Record<string, TokenizerBinding> {
  const data = JSON.parse(text) as Record<string, TokenizerBinding>;
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('MYHARNESS_TOKENIZERS must be a JSON object');
  for (const binding of Object.values(data)) {
    if (!binding || typeof binding.url !== 'string' || typeof binding.alias !== 'string' || !binding.alias || typeof binding.identity !== 'string' || !binding.identity) throw new Error('Each tokenizer binding needs url, alias and identity');
    const url = new URL(binding.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Tokenizer URL must be HTTP(S), without credentials, query or fragment');
  }
  return data;
}
export async function tokenizeWithLlama(fetch_: FetchLike, binding: TokenizerBinding, content: string, signal?: AbortSignal): Promise<TokenGroup> {
  const base = binding.url.replace(/\/$/, '');
  const timeout = AbortSignal.timeout(30_000), requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const models = await fetch_(`${base}/v1/models`, { method: 'GET', signal: requestSignal });
  if (!models.ok) throw new Error(`Tokenizer model lookup failed (HTTP ${models.status})`);
  const catalog = await models.json() as { data?: { id: string }[] };
  if (!catalog.data?.some(model => model.id === binding.alias)) throw new Error('Configured tokenizer model alias does not match the running tokenizer service');
  const response = await fetch_(`${base}/tokenize`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: requestSignal,
    body: JSON.stringify({ model: binding.alias, content, add_special: false, parse_special: true, with_pieces: true }) });
  if (!response.ok) throw new Error(`Tokenizer request failed (HTTP ${response.status})`);
  const data = await response.json() as { tokens?: { id: unknown; piece: unknown }[] };
  if (!Array.isArray(data.tokens)) throw new Error('Tokenizer did not return token pieces');
  return { label: 'Ollama-rendered prompt', tokens: data.tokens.map(token => tokenPiece(token.id, token.piece)) };
}

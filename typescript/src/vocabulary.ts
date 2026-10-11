import { describeSpecialToken, type SpecialToken } from './special-tokens.js';
/** The model's vocabulary: every token it can read or write, with its ID. Pure data; the runtime supplies the model description. */

export type VocabularyKind = 'normal' | 'unknown' | 'control' | 'user-defined' | 'unused' | 'byte';
export interface VocabularyEntry { id: number; piece: string; kind: VocabularyKind; hex: string; partial: boolean; special?: SpecialToken }
export interface VocabularyQuery { search?: unknown; exact?: unknown; around?: unknown; start?: unknown; limit?: unknown }
export type VocabularyPage =
  | { available: false; reason: string }
  | { available: true; model: string; tokenizer: string; tokenizer_note: string; size: number; counts: Record<VocabularyKind, number>; reserved: { bos?: number; eos?: number; pad?: number };
      mode: 'browse' | 'around' | 'search'; start: number; limit: number; entries: VocabularyEntry[]; matches?: number; focus?: number };

export const DEFAULT_PAGE = 100, MAX_PAGE = 500, MAX_SEARCH = 200;
const KINDS: VocabularyKind[] = ['normal', 'unknown', 'control', 'user-defined', 'unused', 'byte'];
const NOTES: Record<string, string> = {
  gpt2: 'Byte-level BPE (Qwen, Llama 3, GPT-style models). Pieces are stored with their bytes written as printable characters; the pieces below are decoded back to the real text, and a leading space is a part of the piece.',
  llama: 'SentencePiece (Llama 2, Mistral, Gemma). Spaces are stored as ▁ and shown below as ordinary spaces; characters without their own token are stored as single-byte tokens.',
};

/** GPT-2's reversible mapping from every byte to a printable character; this is its inverse. */
const BYTE_OF = (() => {
  const keep = new Set<number>(), map = new Map<string, number>();
  for (const [from, to] of [[33, 126], [161, 172], [174, 255]] as const) for (let byte = from; byte <= to; byte++) keep.add(byte);
  let next = 256;
  for (let byte = 0; byte < 256; byte++) map.set(String.fromCodePoint(keep.has(byte) ? byte : next++), byte);
  return map;
})();

const encoder = new TextEncoder();
function pieceBytes(stored: string, kind: VocabularyKind, tokenizer: string): number[] {
  if (kind === 'byte') { const match = /^<0x([0-9A-Fa-f]{2})>$/.exec(stored); if (match) return [parseInt(match[1]!, 16)]; }
  if (kind !== 'normal' && kind !== 'byte') return [...encoder.encode(stored)];
  if (tokenizer === 'gpt2') return [...stored].flatMap(character => BYTE_OF.has(character) ? [BYTE_OF.get(character)!] : [...encoder.encode(character)]);
  return [...encoder.encode(tokenizer === 'llama' ? stored.replaceAll('▁', ' ') : stored)];
}
function decode(bytes: number[]): { text: string; partial: boolean } {
  try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes)), partial: false }; }
  catch { return { text: bytes.map(byte => '\\x' + byte.toString(16).padStart(2, '0').toUpperCase()).join(''), partial: true }; }
}

export class Vocabulary {
  private constructor(readonly model: string, readonly tokenizer: string, private readonly entries: VocabularyEntry[], private readonly lower: string[], private readonly reserved: Record<string, number>) {}

  /** Reads the tokenizer fields of an Ollama `show` response made with `verbose: true`. */
  static parse(model: string, info: unknown): Vocabulary | undefined {
    const data = (info && typeof info === 'object' ? info : {}) as Record<string, unknown>;
    const tokens = data['tokenizer.ggml.tokens'], types = data['tokenizer.ggml.token_type'];
    if (!Array.isArray(tokens) || !tokens.length || !tokens.every(token => typeof token === 'string')) return undefined;
    const tokenizer = typeof data['tokenizer.ggml.model'] === 'string' ? data['tokenizer.ggml.model'] : 'unknown';
    const entries = (tokens as string[]).map((stored, id): VocabularyEntry => {
      const type = Array.isArray(types) ? types[id] : undefined;
      const kind = Number.isInteger(type) && type >= 1 && type <= 6 ? KINDS[type - 1]! : 'normal';
      const bytes = pieceBytes(stored, kind, tokenizer), { text, partial } = decode(bytes);
      const special = kind === 'normal' || kind === 'byte' ? undefined : describeSpecialToken(text);
      return { id, piece: text, kind, hex: bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' '), partial, ...(special ? { special } : {}) };
    });
    const reserved: Record<string, number> = {};
    for (const [key, name] of [['bos', 'bos_token_id'], ['eos', 'eos_token_id'], ['pad', 'padding_token_id']] as const) {
      const id = data[`tokenizer.ggml.${name}`];
      if (Number.isInteger(id) && (id as number) >= 0 && (id as number) < entries.length) reserved[key] = id as number;
    }
    return new Vocabulary(model, tokenizer, entries, entries.map(entry => entry.partial ? '' : entry.piece.toLowerCase()), reserved);
  }

  get size(): number { return this.entries.length; }

  /** A window of entries in ID order, around an ID, or the matches of a search (substring, or the whole piece). */
  page(query: VocabularyQuery): VocabularyPage {
    const limit = count(query.limit, 'limit', DEFAULT_PAGE, 1, MAX_PAGE);
    const counts = Object.fromEntries(KINDS.map(kind => [kind, 0])) as Record<VocabularyKind, number>;
    for (const entry of this.entries) counts[entry.kind]++;
    const base = { available: true as const, model: this.model, tokenizer: this.tokenizer, tokenizer_note: NOTES[this.tokenizer] ?? `Tokenizer type “${this.tokenizer}”. Pieces are shown as stored, without decoding.`,
      size: this.size, counts, reserved: this.reserved, limit };
    if (query.search !== undefined && query.search !== '') {
      if (typeof query.search !== 'string' || query.search.length > MAX_SEARCH) throw new RangeError(`search must be text of at most ${MAX_SEARCH} characters`);
      const needle = query.search.toLowerCase(), exact = query.exact === true;
      const found = this.entries.filter((entry, id) => exact ? !entry.partial && entry.piece === query.search : this.lower[id]!.includes(needle));
      return { ...base, mode: 'search', start: 0, entries: found.slice(0, limit), matches: found.length };
    }
    if (query.around !== undefined) {
      const focus = count(query.around, 'around', 0, 0, this.size - 1), start = Math.max(0, Math.min(focus - Math.floor(limit / 2), this.size - limit));
      return { ...base, mode: 'around', start, entries: this.entries.slice(start, start + limit), focus };
    }
    const start = count(query.start, 'start', 0, 0, this.size - 1);
    return { ...base, mode: 'browse', start, entries: this.entries.slice(start, start + limit) };
  }
}

function count(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

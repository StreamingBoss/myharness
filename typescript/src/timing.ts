import type { ChatMessage, ModelRequest, ToolDefinition } from './core.js';
import type { ModelUsage } from './model.js';
/** Where a model call's time and memory go: prefill, decode, prompt reuse and the KV cache. Pure functions only. */

/** Durations a provider reports for one model call, in milliseconds. */
export interface ModelTiming { load_ms?: number; prefill_ms?: number; decode_ms?: number; total_ms?: number }
/** Clock readings the harness takes around one model call. */
export interface MeasuredTiming { started: number; firstDelta?: number; completed: number; streamed: boolean }
export interface TimingSummary {
  /** provider: the provider split prefill from decode. harness: only the harness clock. none: nothing measured. */
  source: 'provider' | 'harness' | 'none';
  streamed: boolean;
  wall_ms?: number; ttft_ms?: number; load_ms?: number;
  prefill_ms?: number; prefill_tps?: number;
  decode_ms?: number; decode_tps?: number; tpot_ms?: number;
  input?: number; output?: number; cached?: number;
  thinking_tokens?: number; thinking_exact?: boolean;
}
export interface PrefixReuse {
  change: 'first request' | 'model' | 'context window' | 'tools' | 'system prompt' | 'conversation rewritten' | 'thinking dropped' | 'appended' | 'none';
  /** Index of the first message that differs from the previous request. */
  changed_index?: number;
  reused_messages: number; total_messages: number;
  reused_tokens_est: number; new_tokens_est: number;
}
export interface RoundTiming {
  round: number; tokens_in?: number; tokens_out?: number;
  wall_ms?: number; prefill_ms?: number; decode_ms?: number; tool_ms?: number;
}
export type KvEstimate =
  | { available: true; architecture: string; layers: number; kv_heads: number; key_length: number; value_length: number; sliding_window: boolean;
      bytes_per_token: number; working_context: number; working_bytes: number; model_context?: number; model_bytes?: number }
  | { available: false; reason: string };

type Loose<T> = { [K in keyof T]?: T[K] | undefined };
/** Drops undefined fields, which optional properties may not hold. */
function defined<T extends object>(value: Loose<T>): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
const rate = (tokens: number | undefined, ms: number | undefined): number | undefined => tokens && ms ? tokens / ms * 1000 : undefined;

export function timingSummary(usage: ModelUsage, provider: ModelTiming | undefined, measured: MeasuredTiming | undefined, thinkingText = '', answerText = ''): TimingSummary {
  const input = usage.input, output = usage.output;
  const wall = measured ? measured.completed - measured.started : provider?.total_ms;
  const ttft = measured?.streamed && measured.firstDelta !== undefined ? measured.firstDelta - measured.started : undefined;
  // Without a provider count, split the measured output by the share of thinking text; only without any count fall back to ~4 characters per token.
  const thinking = usage.reasoning ?? (!thinkingText ? undefined : output === undefined ? Math.ceil(thinkingText.length / 4) : Math.round(output * thinkingText.length / (thinkingText.length + answerText.length)));
  const common = { streamed: measured?.streamed ?? false, wall_ms: wall, ttft_ms: ttft, input, output, cached: usage.cached, thinking_tokens: thinking, thinking_exact: thinking === undefined ? undefined : usage.reasoning !== undefined };
  if (provider?.prefill_ms !== undefined || provider?.decode_ms !== undefined) {
    return defined<TimingSummary>({ ...common, source: 'provider', load_ms: provider.load_ms,
      prefill_ms: provider.prefill_ms, prefill_tps: rate(input, provider.prefill_ms),
      decode_ms: provider.decode_ms, decode_tps: rate(output, provider.decode_ms), tpot_ms: output && provider.decode_ms !== undefined ? provider.decode_ms / output : undefined });
  }
  if (ttft !== undefined && output !== undefined && output > 1) {
    // The first token arrives at TTFT; the remaining ones are decoded one by one after it.
    const decode = measured!.completed - measured!.firstDelta!;
    return defined<TimingSummary>({ ...common, source: 'harness', decode_ms: decode, decode_tps: rate(output - 1, decode), tpot_ms: decode / (output - 1) });
  }
  return defined<TimingSummary>({ ...common, source: measured ? 'harness' : 'none' });
}

/** Compares a request with the previous one in the order a chat template renders it: tools, system, conversation. */
export function prefixReuse(previous: ModelRequest | undefined, current: ModelRequest, estimate: (messages: ChatMessage[], tools: ToolDefinition[]) => number): PrefixReuse {
  const tools = current.tools ?? [], total = estimate(current.messages, tools), count = current.messages.length;
  const none = (change: PrefixReuse['change']): PrefixReuse => ({ change, reused_messages: 0, total_messages: count, reused_tokens_est: 0, new_tokens_est: total });
  if (!previous) return none('first request');
  if (previous.model !== current.model || previous.provider !== current.provider) return none('model');
  if (previous.options.num_ctx !== current.options.num_ctx) return none('context window');
  if (JSON.stringify(previous.tools ?? []) !== JSON.stringify(tools)) return none('tools');
  let reused = 0;
  while (reused < count && reused < previous.messages.length && JSON.stringify(previous.messages[reused]) === JSON.stringify(current.messages[reused])) reused++;
  const reusedTokens = Math.min(total, estimate(current.messages.slice(0, reused), tools));
  const { thinking, ...sent } = (previous.messages[reused] ?? {}) as ChatMessage & { thinking?: string };
  const change: PrefixReuse['change'] = reused === count ? 'none' : current.messages[reused]!.role === 'system' ? 'system prompt' : reused === previous.messages.length ? 'appended'
    // The model generated its thinking, but the harness sends the reply back without it.
    : thinking && JSON.stringify(sent) === JSON.stringify(current.messages[reused]) ? 'thinking dropped' : 'conversation rewritten';
  return { change, ...(change === 'none' ? {} : { changed_index: reused }), reused_messages: reused, total_messages: count, reused_tokens_est: reusedTokens, new_tokens_est: total - reusedTokens };
}

export function kvCacheEstimate(info: Record<string, unknown>, workingContext: number): KvEstimate {
  const architecture = info['general.architecture'];
  const field = (name: string): number | undefined => {
    const value = info[`${String(architecture)}.${name}`];
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const layers = field('block_count'), heads = field('attention.head_count'), kvHeads = field('attention.head_count_kv') ?? heads, embedding = field('embedding_length');
  const keyLength = field('attention.key_length') ?? (embedding && heads ? embedding / heads : undefined);
  const valueLength = field('attention.value_length') ?? keyLength;
  if (typeof architecture !== 'string' || !layers || !kvHeads || !keyLength || !valueLength) return { available: false, reason: 'The model did not report its layer and attention-head sizes, so its KV-cache size cannot be estimated.' };
  // Keys and values for every layer and every key/value head, at 2 bytes per value (the f16 default).
  const perToken = layers * kvHeads * (keyLength + valueLength) * 2, modelContext = field('context_length');
  return defined<KvEstimate & { available: true }>({ available: true, architecture, layers, kv_heads: kvHeads, key_length: keyLength, value_length: valueLength,
    sliding_window: field('attention.sliding_window') !== undefined, bytes_per_token: perToken, working_context: workingContext, working_bytes: perToken * workingContext,
    model_context: modelContext, model_bytes: modelContext && perToken * modelContext });
}

const number = (value: number): string => Math.round(value).toLocaleString('en');
function duration(ms: number): string {
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1).replace(/\.0$/, '') : Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1).replace(/\.?0+$/, '')} s`;
}
function bytes(value: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB'], unit = Math.min(3, Math.floor(Math.log2(value) / 10));
  value /= 1024 ** unit;
  return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2).replace(/\.?0+$/, '')} ${units[unit]}`;
}

export function timingText(summary: TimingSummary, prefix?: PrefixReuse): string {
  const lines: string[] = [];
  if (summary.load_ms !== undefined) lines.push(`load      ${duration(summary.load_ms)}  ${summary.load_ms >= 1000 ? 'the model was loaded into memory first (cold start: nothing was cached)' : 'the model was already in memory'}`);
  if (summary.prefill_ms !== undefined) {
    // Prefer Ollama's own count of reused tokens; otherwise scale the harness estimate to the measured prompt size.
    const share = prefix ? prefix.reused_tokens_est / (prefix.reused_tokens_est + prefix.new_tokens_est || 1) : 0;
    const reused = summary.input === undefined ? prefix?.reused_tokens_est ?? 0 : Math.round(summary.input * share);
    const reuse = summary.cached !== undefined
      ? (summary.cached ? `\n          ${number(summary.cached)} of these tokens were reused from the KV cache (reported by Ollama)${summary.input === undefined ? '' : `, so only ${number(summary.input - summary.cached)} had to be computed`}. The tokens/s above counts all prompt tokens, so reuse can make prefill look implausibly fast.` : '\n          Ollama reports that none of these tokens were reused from its KV cache: all of them were computed.')
      : reused > 0 ? `\n          ≈${number(reused)} of these tokens matched the previous request. Ollama keeps their KV cache, so only about ${number(summary.input === undefined ? prefix!.new_tokens_est : summary.input - reused)} had to be computed. The tokens/s above counts all prompt tokens, so reuse can make prefill look implausibly fast.` : '';
    lines.push(`prefill   ${summary.input === undefined ? '' : `${number(summary.input)} prompt tokens in `}${duration(summary.prefill_ms)}${summary.prefill_tps ? ` = ${number(summary.prefill_tps)} tokens/s` : ''}  reads the whole prompt in parallel (compute-bound)${reuse}`);
  }
  if (summary.ttft_ms !== undefined) lines.push(`first token after ${duration(summary.ttft_ms)}  (time to first token${summary.source === 'provider' ? ': load + prefill + one decode step' : ': queueing, network and prefill on the provider; the parts cannot be told apart here'})`);
  if (summary.decode_ms !== undefined) {
    lines.push(`decode    ${summary.output === undefined ? '' : `${number(summary.output)} output tokens in `}${duration(summary.decode_ms)}${summary.decode_tps ? ` = ${number(summary.decode_tps)} tokens/s` : ''}${summary.tpot_ms !== undefined ? `, ${duration(summary.tpot_ms)} per token` : ''}  writes one token at a time (memory-bandwidth-bound)${summary.source === 'harness' ? '; measured in the harness, includes network' : ''}`);
  }
  if (summary.source !== 'provider' && !summary.streamed) lines.push(summary.source === 'none' ? 'No timing is available for this response.' : 'not streamed: the reply arrived in one piece, so prefill and decode cannot be told apart here');
  if (summary.cached && summary.prefill_ms === undefined) lines.push(`cache     ${number(summary.cached)}${summary.input === undefined ? '' : ` of ${number(summary.input)}`} input tokens were read from the provider's prompt cache instead of being prefilled again`);
  if (summary.thinking_tokens !== undefined) lines.push(`thinking  ${summary.thinking_exact ? '' : '≈'}${number(summary.thinking_tokens)}${summary.output === undefined ? '' : ` of ${number(summary.output)}`} output tokens were thinking${summary.thinking_exact ? ' (reported by the provider)' : ' (estimated from the share of thinking text)'}; they are decoded like the answer and cost the same time`);
  if (summary.wall_ms !== undefined) lines.push(`total     ${duration(summary.wall_ms)}`);
  return lines.join('\n');
}

export function prefixText(prefix: PrefixReuse): string {
  const tokens = (count: number): string => `≈${number(count)} tokens`;
  const at = prefix.changed_index === undefined ? '' : `message ${prefix.changed_index + 1} of ${prefix.total_messages}`;
  switch (prefix.change) {
    case 'first request': return `First request since this session was loaded: the harness has no earlier request to compare with. All ${tokens(prefix.new_tokens_est)} need prefill, unless the provider still holds an identical start from earlier in its cache (a very fast prefill in TIMING shows that).`;
    case 'model': return `The model changed since the previous request, so nothing can be reused. All ${tokens(prefix.new_tokens_est)} need prefill.`;
    case 'context window': return `The context window (num_ctx) changed. Ollama reloads the model with a new KV cache, so all ${tokens(prefix.new_tokens_est)} need prefill.`;
    case 'tools': return `The tool definitions changed (a tool was ticked or unticked, or an MCP server changed). They are near the start of the prompt, so all ${tokens(prefix.new_tokens_est)} need prefill again.`;
    case 'system prompt': return `The system prompt changed at ${at} (instructions, agent, skills, MCP or project file). Everything from there on, ${tokens(prefix.new_tokens_est)}, needs prefill again; only ${tokens(prefix.reused_tokens_est)} before it can be reused.`;
    case 'thinking dropped': return `The model's previous reply (${at}) started with thinking that the harness does not send back, so the prompt now differs from what the model generated: its KV cache matches only up to that reply. ${tokens(prefix.reused_tokens_est)} before it can be reused; the reply without its thinking and everything after it, ${tokens(prefix.new_tokens_est)}, need prefill again.`;
    case 'conversation rewritten': return `The harness rewrote earlier history: ${at} differs from the previous request (old tool output trimmed, conversation compacted or memory changed). Everything after it, ${tokens(prefix.new_tokens_est)}, needs prefill again; ${tokens(prefix.reused_tokens_est)} before it can be reused.`;
    case 'appended': return `The first ${prefix.reused_messages} of ${prefix.total_messages} messages are identical to the previous request (${tokens(prefix.reused_tokens_est)}). A provider prompt cache or Ollama's KV cache can reuse them; only the ${tokens(prefix.new_tokens_est)} added since need prefill.`;
    case 'none': return `Identical to the previous request (${tokens(prefix.reused_tokens_est)}); all of it can be reused.`;
  }
}

export function turnTotals(rounds: RoundTiming[]): Omit<RoundTiming, 'round'> & { rounds: number } {
  const sum = (key: keyof Omit<RoundTiming, 'round'>): number | undefined => rounds.some(round => round[key] !== undefined) ? rounds.reduce((total, round) => total + (round[key] ?? 0), 0) : undefined;
  return defined({ rounds: rounds.length, tokens_in: sum('tokens_in'), tokens_out: sum('tokens_out'), wall_ms: sum('wall_ms'), prefill_ms: sum('prefill_ms'), decode_ms: sum('decode_ms'), tool_ms: sum('tool_ms') });
}

export function turnTimelineText(rounds: RoundTiming[]): string {
  const cell = (value: number | undefined, format: (value: number) => string, width: number): string => (value === undefined ? '—' : format(value)).padStart(width);
  const widest = Math.max(1, ...rounds.map(round => round.tokens_in ?? 0));
  const rows = rounds.map(round => `${String(round.round).padStart(5)}  ${cell(round.tokens_in, number, 8)}  ${cell(round.tokens_out, number, 7)}  ${cell(round.prefill_ms, duration, 8)}  ${cell(round.decode_ms, duration, 8)}  ${cell(round.wall_ms, duration, 8)}  ${cell(round.tool_ms, duration, 8)}  ${'█'.repeat(Math.round(20 * (round.tokens_in ?? 0) / widest))}`);
  const totals = turnTotals(rounds);
  return [`round     input   output   prefill    decode      model     tools  input size`, ...rows, '',
    `${totals.rounds} model calls${totals.tokens_in === undefined ? '' : `, ${number(totals.tokens_in)} input tokens sent in total`}${totals.tokens_out === undefined ? '' : `, ${number(totals.tokens_out)} output tokens`}${totals.wall_ms === undefined ? '' : `; model time ${duration(totals.wall_ms)}`}${totals.tool_ms === undefined ? '' : `, tool time ${duration(totals.tool_ms)}`}.`,
    'Every round sends the whole conversation again, so the input grows each round while the output stays small. Unchanged earlier messages can be reused from the cache; tool results added since must be prefilled.'].join('\n');
}

export function kvText(estimate: KvEstimate): string {
  if (!estimate.available) return estimate.reason;
  return [`${estimate.architecture}: ${estimate.layers} layers × ${estimate.kv_heads} key/value heads × (${estimate.key_length} + ${estimate.value_length}) values × 2 bytes`,
    `= ${bytes(estimate.bytes_per_token)} for every token kept in context`, '',
    `working context ${number(estimate.working_context)} tokens → ${bytes(estimate.working_bytes)}`,
    ...(estimate.model_context ? [`model maximum   ${number(estimate.model_context)} tokens → ${bytes(estimate.model_bytes!)}`] : []), '',
    'The KV cache stores the keys and values computed for every token, so they are not recomputed for each new token. Ollama reserves it for the whole context window when the model loads, even for a short conversation, which is why a larger context window needs more memory.',
    `Assumes the default f16 cache: OLLAMA_KV_CACHE_TYPE=q8_0 halves it and q4_0 quarters it.${estimate.sliding_window ? ' This model uses sliding-window attention on some layers, so its real cache is smaller.' : ''}`].join('\n');
}

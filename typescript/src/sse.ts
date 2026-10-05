import type { FetchResponse } from './ollama.js';

/** UTF-8/CRLF-safe SSE reader. Releases the stream on completion, error or cancellation. */
export async function* readSSE(response: FetchResponse): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('The provider returned no response body.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', data: string[] = [], event = '';
  function parse(): Record<string, unknown> | undefined {
    const value = data.join('\n'); data = [];
    if (!value || value === '[DONE]') return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(value) as Record<string, unknown>; } catch { throw new Error('Invalid provider stream event.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid provider stream event.');
    return { ...parsed, event_type: parsed.event_type ?? parsed.type ?? event };
  }
  try {
    while (true) {
      const next = await reader.read(); buffer += decoder.decode(next.value, { stream: !next.done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (!line) { const parsed = parse(); event = ''; if (parsed) yield parsed; }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
      if (next.done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
        const parsed = parse(); if (parsed) yield parsed;
        break;
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

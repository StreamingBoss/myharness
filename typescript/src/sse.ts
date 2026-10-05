import type { FetchResponse } from './ollama.js';

/** UTF-8/CRLF-safe raw SSE events. Releases the stream on completion, error or cancellation. */
export async function* sseEvents(response: Pick<FetchResponse, 'body'>): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) throw new Error('The provider returned no response body.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', data: string[] = [], event = '';
  try {
    while (true) {
      const next = await reader.read(); buffer += decoder.decode(next.value, { stream: !next.done });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (!line) { if (data.length) yield { event, data: data.join('\n') }; data = []; event = ''; }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
      if (next.done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
        if (data.length) yield { event, data: data.join('\n') };
        break;
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

/** JSON provider events from an SSE stream. */
export async function* readSSE(response: FetchResponse): AsyncGenerator<Record<string, unknown>> {
  for await (const { event, data } of sseEvents(response)) {
    if (!data || data === '[DONE]') continue;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { throw new Error('Invalid provider stream event.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid provider stream event.');
    yield { ...parsed, event_type: parsed.event_type ?? parsed.type ?? event };
  }
}

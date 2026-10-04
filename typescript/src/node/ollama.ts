import type { ModelRequest } from "../core.js";

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}

export type FetchLike = (input: string, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string }) => Promise<FetchResponse>;

/** Node runtime adapter for Ollama's newline-delimited `/api/chat` stream. */
export class OllamaAdapter {
  constructor(private readonly fetch_: FetchLike, private readonly baseUrl: string) {}

  async *streamChat(payload: ModelRequest): AsyncGenerator<string> {
    const response = await this.fetch_(`${this.baseUrl}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Ollama request failed with HTTP ${response.status}`);
    if (!response.body) throw new Error("Ollama returned no response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield line;
        newline = buffered.indexOf("\n");
      }
      if (done) break;
    }
    const finalLine = buffered.trim();
    if (finalLine) yield finalLine;
  }

  async contextLength(model: string): Promise<number> {
    const response = await this.fetch_(`${this.baseUrl}/api/tags`, { method: "GET" });
    if (!response.ok) throw new Error(`Ollama model lookup failed with HTTP ${response.status}`);
    const data = await response.json();
    const models = (data as { models?: unknown }).models;
    const match = Array.isArray(models)
      ? models.find((entry): entry is { name?: unknown; details?: { context_length?: unknown } } => typeof entry === "object" && entry !== null && (entry as { name?: unknown }).name === model)
      : undefined;
    const context = match?.details?.context_length;
    if (typeof context !== "number" || !Number.isInteger(context) || context <= 0) {
      throw new Error(`Ollama did not report a context length for '${model}'`);
    }
    return context;
  }
}

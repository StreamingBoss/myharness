import { createServer, type Server } from 'node:http';

export interface HelperFixtureOptions {
  /** Website origins this stand-in serves, like the real helper's --origin. */
  origins: string[];
  ollamaUrl?: string;
  protocol?: number;
  /** Token pieces for a model and text; `undefined` answers as the real helper does when it finds no model file. */
  tokens?: (model: string, content: string) => { identity: string; tokens: { id: unknown; bytes: unknown }[] } | undefined;
}
export interface HelperFixture { server: Server; base: string; port: number; requests: { route: string; body: Record<string, unknown> }[]; close(): Promise<void> }

/**
 * Scripted stand-in for the native tokenizer helper (native/tokenizer), speaking its protocol over real
 * loopback HTTP, including the Host and Origin checks. native/tokenizer/tests/verify.py checks the real
 * program against the same protocol, and scripts/smoke-token-helper.mjs checks both together.
 */
export async function helperFixture(options: HelperFixtureOptions, port = 0): Promise<HelperFixture> {
  const requests: HelperFixture['requests'] = [];
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin, json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}` || !origin || !options.origins.includes(origin)) { json(403, { error: 'This website is not allowed to use the tokenizer helper' }); return; }
    response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); response.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    let text = ''; for await (const chunk of request) text += String(chunk);
    const body = JSON.parse(text) as Record<string, unknown>; requests.push({ route: request.url!, body });
    if (request.url === '/v1/info') { json(200, { value: { protocol: options.protocol ?? 2, ollamaUrl: options.ollamaUrl ?? 'http://localhost:11434', models: [], automatic: true } }); return; }
    if (request.url === '/v1/tokenize') {
      const result = options.tokens?.(String(body.model), String(body.content));
      if (result) json(200, { value: result }); else json(422, { error: 'Ollama did not report a usable model file. Set MYHARNESS_TOKENIZER_MODELS where the helper runs to a matching local GGUF file.' });
      return;
    }
    json(404, { error: 'Tokenizer helper route not found' });
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const actual = (server.address() as { port: number }).port;
  return { server, base: `http://127.0.0.1:${actual}`, port: actual, requests, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

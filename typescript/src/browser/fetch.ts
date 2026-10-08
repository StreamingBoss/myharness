import { failureDetails } from '../failure.js';
import { BackendError } from '../harness.js';
import { WorkerClient } from './client.js';
import { agentRoute, agentQuery } from '../transport.js';

/** Logs browser MCP storage through the local static server when served on localhost. */
export async function reportBrowserMcpConfig(client: WorkerClient): Promise<void> {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('managed') === '1') return;
  if (typeof location === 'undefined' || !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  try {
    const configuration = await client.call('mcpConfiguration') as { config: unknown };
    const url = new URL('/__debug/mcp-config', location.origin);
    url.search = location.search;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(configuration) });
    if (!response.ok) console.warn('Could not print MCP configuration in the static server console:', await response.text());
  } catch (error) { console.warn('Could not print MCP configuration in the static server console:', error); }
}

/** Compatibility transport for the existing UI; requests travel to a Worker. */
export function browserFetch(client: WorkerClient) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    try {
      const url = new URL(input, 'https://browser.invalid'), route = url.pathname, method = init.method ?? 'GET';
      const value = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackendError('Expected a JSON object');
      let action = '', payload = value, status = 200;
      const agent = agentRoute(method, route);
      if (agent) return Response.json(await client.call(agent.action, { ...value, ...agentQuery(url.searchParams), ...(agent.id ? { id: agent.id } : {}) }), { status: 200 });
      if (route === '/chat' || route === '/compact') {
        if (method !== 'POST') throw new BackendError('Not found', 404);
        const iterator = client.stream(route.slice(1), value), first = await iterator.next();
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { if (first.done) controller.close(); else controller.enqueue(encoder.encode(JSON.stringify(first.value) + '\n')); },
          async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(JSON.stringify(next.value) + '\n')); } catch (error) { controller.error(error); } },
          async cancel() { await client.call('stop'); await iterator.return(undefined); },
        }), { headers: { 'content-type': 'application/x-ndjson' } });
      }
      const session = route === '/sessions/import' ? null : route.match(/^\/sessions\/([^/]+)(?:\/(activate|export))?$/);
      if (session) {
        payload = { ...value, id: decodeURIComponent(session[1]!) };
        if (method === 'GET') action = 'getSession';
        else if (method === 'PATCH' && !session[2]) action = 'patchSession';
        else if (method === 'POST' && session[2] === 'activate') action = 'activateSession';
      } else if (method === 'GET') {
        if (route === '/tokenize/progress') action = 'tokenizationProgress';
        else if (route === '/bootstrap' || route === '/sessions' || route === '/mcp') action = route.slice(1);
        else if (route === '/mcp/config') action = 'mcpConfiguration';
        else if (route === '/mcp/registry') { action = 'mcpRegistry'; payload = Object.fromEntries(url.searchParams); }
        else if (route === '/browse') { action = 'browse'; const path = url.searchParams.get('path'); payload = path ? { path } : {}; if (url.searchParams.get('bridge') === '1') payload.bridge = true; }
      } else if (method === 'POST') {
        if (route === '/sessions') action = 'newSession';
        else if (route === '/sessions/import') { action = 'importSession'; status = 201; }
        else if (['/reset', '/stop', '/approve', '/explore', '/project', '/tokenize'].includes(route)) action = route.slice(1);
        else if (route === '/mcp/add') action = 'addMcp';
        else if (route === '/mcp/reload') action = 'reloadMcp';
        else if (route === '/mcp/preview') action = 'previewMcp';
      } else if (method === 'PUT' && route === '/mcp/config') { action = 'configureMcp'; payload = value.config as Record<string, unknown>; }
      if (!action) throw new BackendError('Not found', 404);
      const result = await client.call(action, payload);
      if (action === 'addMcp' || action === 'configureMcp') await reportBrowserMcpConfig(client);
      return Response.json(result, { status });
    } catch (error) { return Response.json({ error: String(error instanceof Error ? error.message : error), failure: failureDetails(error) }, { status: error instanceof BackendError ? error.status : 400 }); }
  };
}

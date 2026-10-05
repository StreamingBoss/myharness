import { BackendError } from '../harness.js';
import { WorkerClient } from './client.js';

/** Compatibility transport for the existing UI; requests travel to a Worker. */
export function browserFetch(client: WorkerClient) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    try {
      const url = new URL(input, 'https://browser.invalid'), route = url.pathname, method = init.method ?? 'GET';
      const value = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackendError('Expected a JSON object');
      let action = '', payload = value, status = 200;
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
      const session = route.match(/^\/sessions\/([^/]+)(?:\/(activate|export))?$/);
      if (session) {
        payload = { ...value, id: decodeURIComponent(session[1]!) };
        if (method === 'GET') action = 'getSession';
        else if (method === 'PATCH' && !session[2]) action = 'patchSession';
        else if (method === 'POST' && session[2] === 'activate') action = 'activateSession';
      } else if (method === 'GET') {
        if (route === '/bootstrap' || route === '/sessions') action = route.slice(1);
        else if (route === '/browse') { action = 'browse'; const path = url.searchParams.get('path'); payload = path ? { path } : {}; }
      } else if (method === 'POST') {
        if (route === '/sessions') action = 'newSession';
        else if (route === '/sessions/import') { action = 'importSession'; status = 201; }
        else if (['/reset', '/stop', '/approve', '/explore', '/project', '/tokenize'].includes(route)) action = route.slice(1);
      }
      if (!action) throw new BackendError('Not found', 404);
      return Response.json(await client.call(action, payload), { status });
    } catch (error) { return Response.json({ error: String(error instanceof Error ? error.message : error) }, { status: error instanceof BackendError ? error.status : 400 }); }
  };
}

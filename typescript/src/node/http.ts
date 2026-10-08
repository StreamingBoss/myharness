import { failureDetails } from '../failure.js';
import { modelConfiguration } from '../providers.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { NodeHarness, BackendError } from './harness.js';
import { sessionSummary } from './sessions.js';
import type { CoreEvent } from '../core.js';
import { turnAction as action, agentRoute, agentAction, agentQuery } from '../transport.js';

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  const value: unknown = text ? JSON.parse(text) : {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BackendError('Expected a JSON object');
  return value as Record<string, unknown>;
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
}
async function stream(response: ServerResponse, events: AsyncGenerator<CoreEvent>, harness: NodeHarness): Promise<void> {
  const first = await events.next();
  const cancel = () => { if (!response.writableFinished) harness.stop(); };
  response.on('close', cancel);
  try {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let next = first;
    while (!next.done) {
      if (response.destroyed) break;
      response.write(JSON.stringify(next.value) + '\n');
      next = await events.next();
    }
    response.end();
  } finally { response.off('close', cancel); await events.return(undefined); }
}

export function createHarnessServer(harness: NodeHarness, options: { projectRoot?: string; uiOrigins?: string } = {}): Server {
  const root = options.projectRoot ?? process.cwd();
  const allowed = new Set((options.uiOrigins ?? '').split(',').map(origin => origin.trim()).filter(Boolean));
  return createServer(async (request, response) => {
    try {
      const origin = request.headers.origin;
      if (origin && allowed.has(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url!, 'http://localhost'), route = url.pathname;
      if (request.method === 'GET' && (route === '/' || /^\/static\/[\w.-]+$/.test(route))) {
        const file = route === '/' ? path.join(root, 'web/templates/index.html') : path.join(root, 'web', route);
        if (!existsSync(file)) throw new BackendError('Not found', 404);
        response.writeHead(200, { 'content-type': route === '/' ? 'text/html; charset=utf-8' : 'application/javascript' }); response.end(await readFile(file)); return;
      }
      const browserAssets: Record<string, string> = { '/guide.html': 'text/html; charset=utf-8', '/index.html': 'text/html; charset=utf-8', '/guide-ui.js': 'application/javascript', '/managed-worker.js': 'application/javascript', '/library.json': 'application/json', '/browser-ui.js': 'application/javascript', '/backend-worker.js': 'application/javascript', '/browser-backend.js': 'application/javascript' };
      if (request.method === 'GET' && browserAssets[route]) {
        const file = path.join(root, 'dist/browser', route.slice(1));
        if (!existsSync(file)) throw new BackendError('Build the browser distribution before opening Guide & Setup.', 404);
        response.writeHead(200, { 'content-type': browserAssets[route] }); response.end(await readFile(file)); return;
      }
      if (request.method === 'GET' && route === '/tokenize/progress') { send(response, 200, await harness.tokenizationProgress()); return; }
      if (request.method === 'GET' && route === '/bootstrap') { send(response, 200, await harness.bootstrap()); return; }
      const agent = agentRoute(request.method!, route);
      if (agent) {
        const value = { ...(request.method === 'GET' ? agentQuery(url.searchParams) : await body(request)), ...(agent.id ? { id: agent.id } : {}) };
        send(response, 200, await agentAction(harness, agent.action, value)); return;
      }
      if (request.method === 'GET' && route === '/sessions') { send(response, 200, { active_id: harness.activeSessionRecord().id, sessions: (await harness.listSessions()).map(sessionSummary) }); return; }
      if (request.method === 'POST' && route === '/sessions') {
        const value = await body(request);
        send(response, 200, { session: await harness.newSession(typeof value.name === 'string' ? value.name : 'New session'), sessions: (await harness.listSessions()).map(sessionSummary) }); return;
      }
      if (request.method === 'POST' && route === '/sessions/import') {
        send(response, 201, { session: sessionSummary(await harness.importSession(await body(request))), sessions: (await harness.listSessions()).map(sessionSummary) }); return;
      }
      const match = route.match(/^\/sessions\/([^/]+)(?:\/(activate|export))?$/);
      if (match) {
        const id = decodeURIComponent(match[1]!);
        if (request.method === 'POST' && match[2] === 'activate') { send(response, 200, await harness.activateSession(id)); return; }
        if (request.method === 'PATCH' && !match[2]) { send(response, 200, await harness.patchSession(id, await body(request))); return; }
        if (request.method === 'GET') {
          const record = await harness.getSession(id);
          if (match[2] === 'export') response.setHeader('Content-Disposition', `attachment; filename="${record.name.slice(0, 60).replace(/["\r\n]/g, '_') || 'session'}.json"`);
          send(response, 200, record); return;
        }
      }
      if (request.method === 'POST' && route === '/model') { const value = await body(request); if (value.apiKey !== undefined) throw new BackendError('Node HTTP uses server environment credentials.'); await harness.configureModel(modelConfiguration(value)); send(response, 200, { ok: true }); return; }
      if (request.method === 'GET' && route === '/mcp') { send(response, 200, harness.mcpStatus()); return; }
      if (request.method === 'GET' && route === '/mcp/config') { send(response, 200, await harness.mcpConfiguration()); return; }
      if (request.method === 'PUT' && route === '/mcp/config') { send(response, 200, await harness.configureMcp((await body(request)).config)); return; }
      if (request.method === 'GET' && route === '/mcp/registry') { send(response, 200, await harness.searchMcpRegistry({ search: url.searchParams.get('search') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined, source: url.searchParams.get('source') ?? undefined })); return; }
      if (request.method === 'POST' && route === '/mcp/preview') { send(response, 200, await harness.previewMcp(await body(request))); return; }
      if (request.method === 'POST' && route === '/mcp/add') { send(response, 200, await harness.addMcp(await body(request))); return; }
      if (request.method === 'POST' && route === '/mcp/reload') { send(response, 200, await harness.reloadMcp()); return; }
      if (request.method === 'POST' && route === '/reset') { await harness.reset(); send(response, 200, { memory: harness.memoryText() }); return; }
      if (request.method === 'POST' && route === '/stop') { harness.stop(); send(response, 200, { ok: true }); return; }
      if (request.method === 'POST' && route === '/approve') {
        const value = await body(request);
        if (typeof value.approved !== 'boolean') throw new BackendError('approved must be a JSON boolean');
        if (typeof value.id !== 'string' || !harness.approve(value.id, value.approved)) throw new BackendError('this change is no longer waiting for an answer', 404);
        send(response, 200, { ok: true }); return;
      }
      if (request.method === 'POST' && route === '/chat') { await stream(response, harness.submit(action(await body(request), true)), harness); return; }
      if (request.method === 'POST' && route === '/compact') {
        const value = await body(request);
        await stream(response, harness.compact({ ...(typeof value.session_id === 'string' ? { sessionId: value.session_id } : {}), ...(typeof value.use_memory === 'boolean' ? { useMemory: value.use_memory } : {}) }), harness); return;
      }
      if (request.method === 'POST' && route === '/tokenize') {
        const value = await body(request);
        send(response, 200, await harness.tokenize(value.event_index as number, typeof value.session_id === 'string' ? value.session_id : undefined)); return;
      }
      if (request.method === 'POST' && route === '/explore') { send(response, 200, await harness.explore(action(await body(request), false))); return; }
      if (request.method === 'POST' && route === '/project') {
        const value = await body(request);
        if (typeof value.path !== 'string') throw new BackendError('path must be a string');
        send(response, 200, await harness.setProject(value.path)); return;
      }
      if (request.method === 'GET' && route === '/browse') {
        const raw = url.searchParams.get('path') || harness.state.workspace, folder = path.resolve(raw.replace(/^~(?=\/|$)/, homedir()));
        if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new BackendError(`'${raw}' is not a folder`);
        const entries = await readdir(folder, { withFileTypes: true });
        send(response, 200, { path: folder, parent: path.dirname(folder) === folder ? null : path.dirname(folder), folders: entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1) }); return;
      }
      send(response, 404, { error: 'Not found' });
    } catch (error) {
      if (response.headersSent) { response.end(JSON.stringify({ type: 'stopped', reason: `Turn failed: ${(error as Error).message}`, failure: failureDetails(error) }) + '\n'); }
      else send(response, error instanceof BackendError ? error.status : 400, { error: (error as Error).message, failure: failureDetails(error) });
    }
  });
}

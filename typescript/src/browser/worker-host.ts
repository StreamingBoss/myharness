import { modelConfiguration } from '../providers.js';
import { BackendError } from '../harness.js';
import type { CoreEvent } from '../core.js';
import { turnAction } from '../transport.js';
import { sessionSummary } from '../sessions.js';
import type { BrowserHarness } from './harness.js';
import type { LocalDirectory } from './local.js';

export interface RpcRequest { id: string; action: string; payload: Record<string, unknown> }
export type RpcMessage =
  | { id: string; type: 'result'; value: unknown }
  | { id: string; type: 'event'; event: CoreEvent }
  | { id: string; type: 'done' }
  | { id: string; type: 'error'; message: string; status: number };

/** Worker transport only. All harness decisions live in the shared backend. */
export class WorkerHost {
  private backend: Promise<BrowserHarness> | undefined;
  private readonly streams = new Map<string, { iterator: AsyncGenerator<CoreEvent>; cancelled: boolean }>();
  constructor(private readonly load: () => Promise<BrowserHarness>, private readonly send: (message: RpcMessage) => void) {}

  async handle(request: RpcRequest): Promise<void> {
    const { id, action, payload } = request;
    try {
      const backend = await (this.backend ??= this.load());
      if (action === 'cancel') {
        const stream = this.streams.get(id);
        if (stream) { stream.cancelled = true; backend.stop(); }
        return;
      }
      if (action === 'chat' || action === 'compact') {
        const iterator = action === 'chat' ? backend.submit(turnAction(payload, true)) : backend.compact({ ...(typeof payload.session_id === 'string' ? { sessionId: payload.session_id } : {}), ...(typeof payload.use_memory === 'boolean' ? { useMemory: payload.use_memory } : {}) });
        const stream = { iterator, cancelled: false }; this.streams.set(id, stream);
        try { for await (const event of iterator) { if (stream.cancelled) break; this.send({ id, type: 'event', event }); } }
        finally { this.streams.delete(id); await iterator.return(undefined); }
        this.send({ id, type: 'done' }); return;
      }
      let value: unknown;
      switch (action) {
        case 'bootstrap': value = await backend.bootstrap(); break;
        case 'sessions': value = { active_id: backend.activeSessionRecord().id, sessions: (await backend.listSessions()).map(sessionSummary) }; break;
        case 'newSession': value = { session: await backend.newSession(typeof payload.name === 'string' ? payload.name : 'New session'), sessions: (await backend.listSessions()).map(sessionSummary) }; break;
        case 'getSession': value = await backend.getSession(String(payload.id)); break;
        case 'patchSession': value = await backend.patchSession(String(payload.id), payload); break;
        case 'activateSession': value = await backend.activateSession(String(payload.id)); break;
        case 'importSession': value = { session: sessionSummary(await backend.importSession(payload)), sessions: (await backend.listSessions()).map(sessionSummary) }; break;
        case 'reset': await backend.reset(); value = { memory: backend.memoryText() }; break;
        case 'stop': backend.stop(); value = { ok: true }; break;
        case 'approve':
          if (typeof payload.approved !== 'boolean') throw new BackendError('approved must be a JSON boolean');
          if (typeof payload.id !== 'string' || !backend.approve(payload.id, payload.approved)) throw new BackendError('this change is no longer waiting for an answer', 404);
          value = { ok: true }; break;
        case 'project': if (typeof payload.path !== 'string') throw new BackendError('path must be a string'); value = await backend.setProject(payload.path); break;
        case 'browse': value = backend.browse(typeof payload.path === 'string' ? payload.path : backend.state.workspace); break;
        case 'tokenize': value = await backend.tokenize(payload.event_index as number, typeof payload.session_id === 'string' ? payload.session_id : undefined); break;
        case 'explore': value = await backend.explore(turnAction(payload, false)); break;
        case 'importProject': value = await backend.importProject(payload); break;
        case 'exportProject': value = await backend.exportProject(); break;
        case 'attachLocalFolder': value = await backend.attachLocalFolder(payload.handle as LocalDirectory); break;
        case 'listModels': value = await backend.listModels(modelConfiguration(payload)); break;
        case 'configureModel': await backend.configureModel(modelConfiguration(payload)); value = { ok: true }; break;
        case 'forgetApiKey': backend.forgetApiKey(); value = { ok: true }; break;
        case 'mcp': value = backend.mcpStatus(); break;
        case 'reloadMcp': value = await backend.reloadMcp(); break;
        case 'configureMcp': value = await backend.configureMcp(payload); break;
        default: throw new BackendError('Unknown backend action', 404);
      }
      this.send({ id, type: 'result', value });
    } catch (error) { this.send({ id, type: 'error', message: String(error instanceof Error ? error.message : error), status: error instanceof BackendError ? error.status : 400 }); }
  }
}

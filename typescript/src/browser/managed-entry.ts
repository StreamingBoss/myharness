import { ManagedSession } from './managed.js';
import { ManagedHost } from './managed-host.js';
import { loadBrowserHarness } from './startup.js';
import type { RpcMessage, RpcRequest } from './worker-host.js';

export async function startManagedWorker(scope: {
  location: { href: string }; postMessage(message: RpcMessage): void;
  addEventListener(type: string, listener: (event: { data: RpcRequest }) => void): void;
}): Promise<() => void> {
  const url = new URL(scope.location.href);
  const pending: RpcRequest[] = [];
  let host: ManagedHost | undefined;
  scope.addEventListener('message', event => { if (host) void host.handle(event.data); else pending.push(event.data); });
  const session = new ManagedSession(await loadBrowserHarness(url.searchParams.get('database') ?? 'myharness-guide-personal-v1', new URL('library.json', url).href, url.searchParams.get('temporary') !== '0'), url.searchParams.get('temporary') !== '0');
  host = new ManagedHost(session, message => scope.postMessage(message));
  for (const request of pending) await host.handle(request);
  const timer = setInterval(() => { void session.tick().catch(() => undefined); }, 1000);
  return () => { clearInterval(timer); void session.end(); };
}

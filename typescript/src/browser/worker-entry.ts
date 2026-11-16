import { WorkerHost } from './worker-host.js';
import { loadBrowserHarness } from './startup.js';
import type { RpcMessage, RpcRequest } from './worker-host.js';

const scope = self as unknown as { location: { href: string }; postMessage(message: RpcMessage): void; addEventListener(type: string, callback: (event: { data: RpcRequest }) => void): void };
const url = new URL(scope.location.href);
const host = new WorkerHost(() => loadBrowserHarness(url.searchParams.get('database') ?? 'myharness-browser-v1', new URL('library.json', url).href), message => scope.postMessage(message));
scope.addEventListener('message', event => { void host.handle(event.data); });

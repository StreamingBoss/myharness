import { WorkerClient, type WorkerPort } from './client.js';
import { ChannelWorker } from './channel.js';

/** Browser platform adapter only; callable backends never depend on window or opener. */
export async function harnessClient(window_: Window, workerUrl: URL): Promise<WorkerClient> {
  if (new URL(window_.location.href).searchParams.get('managed') !== '1') return new WorkerClient(new Worker(workerUrl, { type: 'module' }) as unknown as WorkerPort);
  if (!window_.opener) throw new Error('Open this managed experiment from Guide & Setup.');
  const opener = window_.opener as Window;
  const port = await new Promise<MessagePort>((resolve, reject) => {
    const timer = setTimeout(() => { window_.removeEventListener('message', ready); reject(new Error('Guide connection timed out. [Time limit: 10 seconds] Keep Guide & Setup open and reopen from Guide & Setup.')); }, 10_000);
    const ready = (event: MessageEvent) => {
      if (event.origin !== window_.location.origin || event.source !== opener || event.data?.type !== 'harness-port' || !event.ports[0]) return;
      clearTimeout(timer); window_.removeEventListener('message', ready); resolve(event.ports[0]);
    };
    window_.addEventListener('message', ready); opener.postMessage({ type: 'harness-ready' }, window_.location.origin);
  });
  // Reloads detach this page. Guide closes explicitly abandoned experiments;
  // delayed heartbeats do not destroy the conversation during browser suspension.
  const client = new WorkerClient(new ChannelWorker(port, false));
  const heartbeat = () => { void client.call('linkHeartbeat').catch(() => undefined); };
  heartbeat();
  const timer = window_.setInterval(heartbeat, 5000);
  const activity = () => { void client.call('activity').catch(() => undefined); };
  window_.addEventListener('pointerdown', activity); window_.addEventListener('keydown', activity);
  window_.addEventListener('pagehide', () => { window_.clearInterval(timer); client.close(); }, { once: true });
  return client;
}

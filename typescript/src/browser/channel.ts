import type { WorkerPort } from './client.js';
import type { RpcMessage, RpcRequest } from './worker-host.js';

interface Port {
  postMessage(value: unknown): void; start(): void; close(): void;
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void;
}
type Listener = (event: { data?: RpcMessage; message?: string }) => void;

/** MessagePort adapter retains WorkerClient's contract without exposing credentials in URLs. */
export class ChannelWorker implements WorkerPort {
  private readonly messages = new Set<Listener>();
  private readonly errors = new Set<Listener>();
  constructor(private readonly port: Port, private readonly endOnClose = true) { port.addEventListener('message', this.receive); port.start(); }
  private readonly receive = (event: { data: unknown }): void => {
    if ((event.data as { type: string }).type === 'closed') { for (const listener of this.errors) listener({ message: 'Managed experiment closed. Return to Guide & Setup.' }); }
    else for (const listener of this.messages) listener({ data: event.data as RpcMessage });
  };
  postMessage(message: RpcRequest): void { this.port.postMessage(message); }
  addEventListener(type: 'message' | 'error', listener: Listener): void { (type === 'message' ? this.messages : this.errors).add(listener); }
  removeEventListener(type: 'message' | 'error', listener: Listener): void { (type === 'message' ? this.messages : this.errors).delete(listener); }
  terminate(): void { if (this.endOnClose) this.port.postMessage({ type: 'link-close' }); this.port.removeEventListener('message', this.receive); this.port.close(); }
}

/** Only the explicitly opened child gets a port; backend broadcasts cannot be discovered by other tabs. */
export class SessionRelay {
  private port: Port | undefined;
  constructor(private readonly worker: WorkerPort, private readonly onClose: () => void) { worker.addEventListener('message', this.receive); }
  private readonly receive = (event: { data?: RpcMessage }): void => { this.port?.postMessage(event.data); };
  private readonly forward = (event: { data: unknown }): void => {
    if ((event.data as { type: string }).type === 'link-close') this.onClose();
    else this.worker.postMessage(event.data as RpcRequest);
  };
  attach(port: Port, replace = false): void {
    if (this.port) {
      if (!replace) throw new Error('This experiment already has a harness tab.');
      this.port.postMessage({ type: 'closed' }); this.port.removeEventListener('message', this.forward); this.port.close();
    }
    this.port = port; port.addEventListener('message', this.forward); port.start();
  }
  close(): void {
    this.worker.removeEventListener('message', this.receive);
    this.port?.postMessage({ type: 'closed' }); this.port?.removeEventListener('message', this.forward); this.port?.close(); this.port = undefined;
  }
}

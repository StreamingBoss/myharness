import { BackendError } from '../harness.js';
import { DiagnosticError, failureDetails } from '../failure.js';
import { WorkerHost, type RpcMessage, type RpcRequest } from './worker-host.js';
import { MANAGED_ACTIONS, ManagedSessionEndedError, type ManagedSession } from './managed.js';

/** Transport adapter for the independent managed backend. */
export class ManagedHost {
  private readonly host: WorkerHost;
  constructor(private readonly session: ManagedSession, private readonly send: (message: RpcMessage) => void) {
    this.host = new WorkerHost(async () => session.harness, send);
  }
  async handle(request: RpcRequest): Promise<void> {
    try {
      if (MANAGED_ACTIONS.includes(request.action)) { this.send({ id: request.id, type: 'result', value: await this.session.call(request.action, request.payload) }); return; }
      this.session.ensureActive();
      await this.session.call('activity');
      if (['configureModel', 'configureModelAndNewSession', 'configureMcp', 'addMcp', 'reloadMcp', 'previewMcp', 'listModels', 'tokenize'].includes(request.action)) {
        const messages: RpcMessage[] = [];
        await this.session.protect(() => new WorkerHost(async () => this.session.harness, message => messages.push(message)).handle(request));
        for (const message of messages) this.send(message);
      } else await this.host.handle(request);
    }
    catch (error) {
      const failure = error instanceof DiagnosticError || error instanceof BackendError ? failureDetails(error) : failureDetails('The managed action could not be completed.', 'harness', `Guide session: ${request.action}`, 'Check the settings for this action in Guide & Setup, then retry.');
      this.send({ id: request.id, type: 'error', message: failure.reason, status: error instanceof ManagedSessionEndedError ? 410 : 400, failure });
    }
  }
}

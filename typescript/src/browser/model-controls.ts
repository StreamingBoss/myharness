import type { ModelConfiguration } from '../providers.js';

export interface ModelView {
  settings(): ModelConfiguration;
  clearKey(): void;
  status(message: string): void;
  render(state: Record<string, unknown>): void;
}
export interface ModelClient { call(action: string, payload?: Record<string, unknown>): Promise<unknown> }
/** UI controller: forwards actions and renders returned state; makes no harness decisions. */
export class ModelControls {
  constructor(private readonly client: ModelClient, private readonly view: ModelView) {}
  async connect(): Promise<void> {
    const settings = this.view.settings(); this.view.clearKey(); this.view.status('Connecting…');
    await this.run('configureModel', settings as Record<string, unknown>);
  }
  async forget(): Promise<void> { await this.run('forgetApiKey', {}); }
  private async run(action: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.client.call(action, payload);
      this.view.render(await this.client.call('bootstrap') as Record<string, unknown>);
      this.view.status('');
    } catch (error) { this.view.status(error instanceof Error ? error.message : String(error)); }
  }
}

import type { ModelConfiguration } from '../providers.js';
import type { ModelOption } from '../model.js';
import type { ModelClient } from './model-controls.js';

export interface ModelPickerView {
  settings(): ModelConfiguration;
  loading(): void;
  render(models: ModelOption[]): void;
  failure(message: string): void;
}

/** View controller: stale model lists cannot replace choices for a newer provider. */
export class ModelPicker {
  private generation = 0;
  constructor(private readonly client: ModelClient, private readonly view: ModelPickerView) {}
  async refresh(): Promise<void> {
    const generation = ++this.generation, settings = this.view.settings();
    this.view.loading();
    try {
      const models = await this.client.call('listModels', settings as Record<string, unknown>) as ModelOption[];
      if (generation === this.generation) this.view.render(models);
    } catch (error) {
      if (generation === this.generation) this.view.failure(error instanceof Error ? error.message : String(error));
    }
  }
}

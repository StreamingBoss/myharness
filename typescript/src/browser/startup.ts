import { BrowserStorage, MemoryStorage } from './storage.js';
import { BrowserHarness } from './harness.js';
import type { Library } from './catalog.js';
import { DEMO_MODEL } from './demo.js';

export async function loadBrowserHarness(database: string, libraryURL: string, temporary = false): Promise<BrowserHarness> {
  const response = await fetch(libraryURL);
  if (!response.ok) throw new Error('Could not load the bundled instruction library');
  const library = await response.json() as Library & { workspace: Record<string, string> };
  const storage = temporary ? new MemoryStorage() : await BrowserStorage.open(database);
  try {
    // The scripted demo is the default: visitors can explore with no model setup. Users connect a real model from the toolbar.
    return await BrowserHarness.open({ storage, library, seed: library.workspace, model: DEMO_MODEL });
  }
  catch (error) { storage.close(); throw error; }
}

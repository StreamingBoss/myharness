import { BrowserStorage } from './storage.js';
import { BrowserHarness } from './harness.js';
import type { Library } from './catalog.js';

export async function loadBrowserHarness(database: string, libraryURL: string): Promise<BrowserHarness> {
  const response = await fetch(libraryURL);
  if (!response.ok) throw new Error('Could not load the bundled instruction library');
  const library = await response.json() as Library & { workspace: Record<string, string> };
  const storage = await BrowserStorage.open(database);
  try { return await BrowserHarness.open({ storage, library, seed: library.workspace }); }
  catch (error) { storage.close(); throw error; }
}

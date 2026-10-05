import { IDBFactory } from 'fake-indexeddb';
import { BrowserStorage } from '../src/browser/storage.js';
import { BrowserHarness } from '../src/browser/harness.js';
import { TOOLS } from '../src/tools.js';
import type { ModelPort } from '../src/harness.js';
export const action = { message: 'List files', useMemory: true, tools: TOOLS.map(tool => tool.function.name), askApproval: true, agent: '', prompt: '' };
export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
export async function fixture(t: { after(callback: () => unknown): void }, modelPort?: ModelPort) {
  const storage = await BrowserStorage.open('test', new IDBFactory()); t.after(() => storage.close());
  const options = { model: 'scripted-demo', storage, library: { agents: {}, prompts: {}, skills: {} }, seed: { 'README.md': 'Hello\n', 'src/main.py': 'print("hello")\n' }, ...(modelPort ? { modelPort } : {}) };
  const backend = await BrowserHarness.open(options);
  return { backend, storage, options };
}

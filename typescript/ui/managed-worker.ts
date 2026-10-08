import { startManagedWorker } from '../src/browser/managed-entry.js';
void startManagedWorker(self as unknown as Parameters<typeof startManagedWorker>[0]).catch(() => { throw new Error('Managed backend unavailable'); });

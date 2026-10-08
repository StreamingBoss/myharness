import { mountGuide } from './guide.js';
import type { WorkerPort } from '../src/browser/client.js';
mountGuide(document, window, {
  worker: url => new Worker(url, { type: 'module' }) as unknown as WorkerPort,
  open: url => window.open(url, '_blank'), channel: () => new MessageChannel(),
});

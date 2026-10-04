import { pathToFileURL } from 'node:url';
import { loadHarness } from './startup.js';
import { createHarnessServer } from './http.js';

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const harness = await loadHarness(env);
  const server = createHarnessServer(harness, { projectRoot: env.MYHARNESS_ROOT ?? process.cwd(), uiOrigins: env.MYHARNESS_UI_ORIGIN ?? '' });
  const port = Number(env.MYHARNESS_PORT ?? '5001');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(`TypeScript harness on http://localhost:${port}`);
  return server;
}
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  try { await startServer(); }
  catch (error) { console.error(`Could not start harness: ${(error as Error).message}`); process.exitCode = 1; }
}

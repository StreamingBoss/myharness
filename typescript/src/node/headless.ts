import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadHarness } from './startup.js';
import type { NodeHarness } from './harness.js';

/** Direct full-backend execution: no HTTP server, templates or browser required. */
export async function headless(args: string[], load = loadHarness, output = console.log): Promise<number> {
  let harness: NodeHarness | undefined;
  let status = 0;
  const stop = () => harness!.stop();
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      tools: { type: 'string' }, 'no-memory': { type: 'boolean' }, approve: { type: 'boolean' }, reset: { type: 'boolean' }, compact: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) { output('Usage: npm run headless:ts -- "message" [--tools read_file,search] [--approve] [--no-memory] [--reset] [--compact]'); return 0; }
    if (!values.reset && !values.compact && !positionals.length) throw new Error('message is required unless --reset or --compact is used');
    harness = await load(); process.on('SIGINT', stop);
    if (values.reset) { await harness.reset(); output(harness.memoryText()); return 0; }
    const session = harness.activeSessionRecord();
    const events = values.compact ? harness.compact() : harness.submit({ message: positionals.join(' '), useMemory: !values['no-memory'], tools: values.tools === undefined ? session.settings.tools : values.tools.split(',').map(name => name.trim()).filter(Boolean), askApproval: true, agent: session.setup.agent, prompt: session.setup.prompt });
    for await (const event of events) {
      output(JSON.stringify(event));
      if (event.type === 'approval') harness.approve(String(event.id), values.approve === true);
    }
    status = harness.stopped() ? 130 : 0;
  } catch (error) { output(`headless harness failed: ${(error as Error).message}`); status = 1; }
  finally { process.off('SIGINT', stop); }
  return status;
}
if (import.meta.url === pathToFileURL(process.argv[1]!).href) process.exitCode = await headless(process.argv.slice(2));

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
      goal: { type: 'boolean' }, 'timeout-ms': { type: 'string' }, 'max-rounds': { type: 'string' }, 'max-requests': { type: 'string' },
    } });
    if (values.help) { output('Usage: npm run headless:ts -- "message" [--goal --timeout-ms 1800000 --max-rounds 10 --max-requests 200] [--tools read_file,search] [--approve] [--no-memory] [--reset] [--compact]'); return 0; }
    if (!values.reset && !values.compact && !positionals.length) throw new Error('message is required unless --reset or --compact is used');
    harness = await load(); process.on('SIGINT', stop);
    if (values.reset) { await harness.reset(); output(harness.memoryText()); return 0; }
    const session = harness.activeSessionRecord();
    const turn = { message: positionals.join(' '), useMemory: !values['no-memory'], tools: values.tools === undefined ? session.settings.tools : values.tools.split(',').map(name => name.trim()).filter(Boolean), askApproval: true, agent: session.setup.agent, prompt: session.setup.prompt };
    if (values.goal && values.compact) throw new Error('--goal and --compact cannot be combined');
    if (values.goal) await harness.startGoal({ objective: turn.message, turn, ...(values['timeout-ms'] === undefined ? {} : { timeoutMs: Number(values['timeout-ms']) }), ...(values['max-rounds'] === undefined ? {} : { maxRounds: Number(values['max-rounds']) }), ...(values['max-requests'] === undefined ? {} : { maxRequests: Number(values['max-requests']) }) });
    const events = values.goal ? harness.subscribeRun(harness.inspectRun()!.id) : values.compact ? harness.compact() : harness.submit(turn);
    for await (const event of events) {
      output(JSON.stringify(event));
      if (event.type === 'approval') harness.approve(String(event.id), values.approve === true);
      if (event.type === 'agent_event' && (event.event as { type: string }).type === 'approval') harness.approve(String((event.event as { id: string }).id), values.approve === true);
    }
    status = values.goal ? (harness.inspectRun()!.status === 'completed' ? 0 : harness.inspectRun()!.status === 'cancelled' ? 130 : 1) : harness.stopped() ? 130 : 0;
  } catch (error) { output(`headless harness failed: ${(error as Error).message}`); status = 1; }
  finally { process.off('SIGINT', stop); await harness?.close(); }
  return status;
}
if (import.meta.url === pathToFileURL(process.argv[1]!).href) process.exitCode = await headless(process.argv.slice(2));

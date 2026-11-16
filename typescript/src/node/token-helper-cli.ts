import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { tokenizerBindings } from '../llama-tokenizer.js';
import { HELPER_DEFAULT_ORIGIN, HELPER_DEFAULT_PORT } from '../helper-protocol.js';
import { TokenHelper, createTokenHelperServer } from './token-helper.js';

/** Starts the tokenizer helper on loopback. With no arguments it serves harnessarium.com on the default port. */
export async function tokenHelperMain(args: string[], output: (line: string) => void = console.log, env: NodeJS.ProcessEnv = process.env): Promise<Server | undefined> {
  const { values } = parseArgs({ args, options: { origin: { type: 'string', multiple: true }, port: { type: 'string', default: String(HELPER_DEFAULT_PORT) }, help: { type: 'boolean' } } });
  if (values.help) {
    output(`token-helper [--origin ${HELPER_DEFAULT_ORIGIN}]... [--port ${HELPER_DEFAULT_PORT}]`);
    output('Shows token pieces for local Ollama models in the MyHarness token viewer. It tokenizes text and does nothing else.');
    output('Optional environment: OLLAMA_URL, MYHARNESS_LLAMA_TOKENIZER, MYHARNESS_TOKENIZER_MODELS, MYHARNESS_TOKENIZERS. See TOKENIZATION.md.');
    return undefined;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Use a valid port');
  const helper = new TokenHelper({
    origins: values.origin?.length ? values.origin : [HELPER_DEFAULT_ORIGIN], ollamaUrl: env.OLLAMA_URL ?? 'http://localhost:11434',
    tokenizers: tokenizerBindings(env.MYHARNESS_TOKENIZERS ?? '{}'),
    managedTokenizer: { executable: env.MYHARNESS_LLAMA_TOKENIZER ?? 'myharness-tokenizer', models: JSON.parse(env.MYHARNESS_TOKENIZER_MODELS ?? '{}') as Record<string, string> },
  });
  const server = createTokenHelperServer(helper);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const stop = () => { server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.on('close', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
  output(`Tokenizer helper on http://127.0.0.1:${(server.address() as { port: number }).port}`);
  output(`Allowed websites: ${[...helper.origins].join(', ')}`);
  output('It only reads tokenizer vocabularies and asks Ollama to render prompts. Stop it with Ctrl+C.');
  return server;
}
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  try { await tokenHelperMain(process.argv.slice(2)); }
  catch (error) {
    console.error((error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? 'Could not start the tokenizer helper: its port is already in use. It may already be running; otherwise choose another port with --port.'
      : 'Could not start the tokenizer helper. Check --origin (an exact website address such as https://harnessarium.com), --port and the tokenizer settings.');
    process.exitCode = 1;
  }
}

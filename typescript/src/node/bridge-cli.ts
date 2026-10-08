import { tokenizerBindings } from '../llama-tokenizer.js';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { NativeBridge, createBridgeServer } from './bridge.js';

export async function bridgeMain(args: string[], output: (line: string) => void = console.log, platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<Server | undefined> {
  const { values } = parseArgs({ args, options: { workspace: { type: 'string' }, origin: { type: 'string' }, port: { type: 'string', default: '5001' }, 'allow-tokenizer': { type: 'boolean' }, 'allow-writes': { type: 'boolean' }, 'allow-commands': { type: 'boolean' }, 'allow-git-writes': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { output('bridge --workspace PATH --origin https://site.example [--port 5001] [--allow-tokenizer] [--allow-writes] [--allow-commands] [--allow-git-writes]; optional MYHARNESS_TOKENIZERS JSON and OLLAMA_URL configure token inspection; --allow-tokenizer uses MYHARNESS_LLAMA_SERVER and optional MYHARNESS_TOKENIZER_MODELS'); return undefined; }
  if (platform === 'win32') throw new Error('Use WSL: native Windows command execution is unsupported.');
  if (!values.workspace || !values.origin) throw new Error('--workspace and --origin are required');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Use a valid port');
  const bridge = new NativeBridge({ ...(values['allow-tokenizer'] ? { managedTokenizer: { executable: env.MYHARNESS_LLAMA_SERVER ?? 'llama-server', models: JSON.parse(env.MYHARNESS_TOKENIZER_MODELS ?? '{}') as Record<string, string> } } : {}), workspace: values.workspace, origin: values.origin, tokenizers: tokenizerBindings(env.MYHARNESS_TOKENIZERS ?? '{}'), ollamaUrl: env.OLLAMA_URL ?? 'http://localhost:11434', grants: { writes: values['allow-writes'] === true, commands: values['allow-commands'] === true, gitWrites: values['allow-git-writes'] === true } });
  const server = createBridgeServer(bridge);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const stop = () => { bridge.close(); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.on('close', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
  output(`Bridge http://127.0.0.1:${(server.address() as { port: number }).port}; origin ${bridge.origin}`);
  output(`Single-use pairing code (valid for five minutes): ${bridge.code}`);
  output('Commands run with your account permissions. The workspace is not an OS sandbox.');
  return server;
}
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  try { await bridgeMain(process.argv.slice(2)); }
  catch (error) {
    console.error((error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? 'Could not start bridge: the port is already in use. The website and bridge need different ports; choose an unused bridge port, for example --port 5002.'
      : 'Could not start bridge. Check workspace, exact origin, grants, and port.');
    process.exitCode = 1;
  }
}

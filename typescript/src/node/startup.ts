import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { NodeHarness } from './harness.js';
import { SessionStore } from './sessions.js';
import { OllamaAdapter } from './ollama.js';
import { GeminiAdapter } from '../gemini.js';
import { tokenizerBindings } from '../llama-tokenizer.js';

export async function loadHarness(env: NodeJS.ProcessEnv = process.env): Promise<NodeHarness> {
  const root = path.resolve(env.MYHARNESS_ROOT ?? process.cwd());
  const settingsFile = path.resolve(env.MYHARNESS_SETTINGS ?? path.join(root, 'settings.json'));
  let workspace = env.MYHARNESS_WORKSPACE ?? path.join(root, 'workspace');
  if (!env.MYHARNESS_WORKSPACE && existsSync(settingsFile)) {
    const saved = JSON.parse(readFileSync(settingsFile, 'utf8')) as { project: string };
    if (existsSync(saved.project) && statSync(saved.project).isDirectory()) workspace = saved.project;
  }
  const model = env.MYHARNESS_MODEL ?? 'qwen3:8b';
  const provider = env.MYHARNESS_PROVIDER ?? 'ollama';
  const ollama = provider === 'ollama'
    ? new OllamaAdapter(fetch, env.OLLAMA_URL ?? 'http://localhost:11434', tokenizerBindings(env.MYHARNESS_TOKENIZERS ?? '{}'))
    : new GeminiAdapter(fetch, provider === 'gemini' ? { kind: 'developer', apiKey: env.GEMINI_API_KEY ?? '' }
      : { kind: 'vertex', project: env.GOOGLE_CLOUD_PROJECT ?? '', location: env.GOOGLE_CLOUD_LOCATION ?? 'global', accessToken: env.GOOGLE_ACCESS_TOKEN ?? '' });
  if (!['ollama', 'gemini', 'vertex'].includes(provider)) throw new Error('Choose MYHARNESS_PROVIDER=ollama, gemini or vertex');
  const contextLength = ollama instanceof OllamaAdapter ? await ollama.contextLength(model) : Number(env.MYHARNESS_CONTEXT_LENGTH ?? 32768);
  if (!Number.isInteger(contextLength) || contextLength <= 0) throw new Error('MYHARNESS_CONTEXT_LENGTH must be a positive integer');
  const harness = new NodeHarness({ workspace, model, contextLength, ollama, projectRoot: root, settingsFile, sessions: new SessionStore(env.MYHARNESS_SESSIONS ?? path.join(root, 'sessions')) });
  await harness.initialize();
  return harness;
}

import { ProviderRouter, configuredModel, providerName } from '../providers.js';
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
  const provider = providerName(env.MYHARNESS_PROVIDER ?? 'ollama');
  const model = configuredModel(provider, env.MYHARNESS_MODEL);
  const ollama = new OllamaAdapter(fetch, env.OLLAMA_URL ?? 'http://localhost:11434', tokenizerBindings(env.MYHARNESS_TOKENIZERS ?? '{}'));
  const router = new ProviderRouter(fetch, { ollama,
    ...(provider === 'vertex' ? { vertex: new GeminiAdapter(fetch, { kind: 'vertex', project: env.GOOGLE_CLOUD_PROJECT ?? '', location: env.GOOGLE_CLOUD_LOCATION ?? 'global', accessToken: env.GOOGLE_ACCESS_TOKEN ?? '' }) } : {})
  }, provider, { gemini: env.GEMINI_API_KEY ?? '', openai: env.OPENAI_API_KEY ?? '', anthropic: env.ANTHROPIC_API_KEY ?? '' });
  const contextLength = Number(env.MYHARNESS_CONTEXT_LENGTH ?? (provider === 'ollama' ? await ollama.contextLength(model) : 8192));
  if (!Number.isInteger(contextLength) || contextLength <= 0) throw new Error('MYHARNESS_CONTEXT_LENGTH must be a positive integer');
  const maxOutput = env.MYHARNESS_MAX_OUTPUT_TOKENS === undefined ? (['gemini', 'openai', 'anthropic'].includes(provider) ? 2048 : undefined) : Number(env.MYHARNESS_MAX_OUTPUT_TOKENS);
  if (maxOutput !== undefined && (!Number.isInteger(maxOutput) || maxOutput <= 0 || maxOutput >= contextLength)) throw new Error('MYHARNESS_MAX_OUTPUT_TOKENS must be positive and smaller than context length');
  const harness = new NodeHarness({ workspace, model, contextLength, modelAdapter: router,
    ...(provider !== 'ollama' ? { provider } : {}), ...(maxOutput === undefined ? {} : { maxOutputTokens: maxOutput }),
    projectRoot: root, settingsFile, sessions: new SessionStore(env.MYHARNESS_SESSIONS ?? path.join(root, 'sessions')) });
  await harness.initialize();
  return harness;
}

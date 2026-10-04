import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { NodeHarness } from './harness.js';
import { SessionStore } from './sessions.js';
import { OllamaAdapter } from './ollama.js';

export async function loadHarness(env: NodeJS.ProcessEnv = process.env): Promise<NodeHarness> {
  const root = path.resolve(env.MYHARNESS_ROOT ?? process.cwd());
  const settingsFile = path.resolve(env.MYHARNESS_SETTINGS ?? path.join(root, 'settings.json'));
  let workspace = env.MYHARNESS_WORKSPACE ?? path.join(root, 'workspace');
  if (!env.MYHARNESS_WORKSPACE && existsSync(settingsFile)) {
    const saved = JSON.parse(readFileSync(settingsFile, 'utf8')) as { project: string };
    if (existsSync(saved.project) && statSync(saved.project).isDirectory()) workspace = saved.project;
  }
  const model = env.MYHARNESS_MODEL ?? 'qwen3:8b';
  const ollama = new OllamaAdapter(fetch, env.OLLAMA_URL ?? 'http://localhost:11434');
  const contextLength = await ollama.contextLength(model);
  const harness = new NodeHarness({ workspace, model, contextLength, ollama, projectRoot: root, settingsFile, sessions: new SessionStore(env.MYHARNESS_SESSIONS ?? path.join(root, 'sessions')) });
  await harness.initialize();
  return harness;
}

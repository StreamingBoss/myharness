// Checks a built tokenizer helper together with the page's own client code: the program starts,
// tokenizes with a real vocabulary file through the TypeScript client, and refuses another website.
// Usage: npm run build:ts && node scripts/smoke-token-helper.mjs <token-helper program> <vocabulary .gguf>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { TokenHelperClient } from '../dist/typescript/src/browser/token-helper.js';

const [program, gguf] = process.argv.slice(2);
const origin = 'http://localhost:5001';
const child = spawn(path.resolve(program), ['--port', '0', '--origin', origin], {
  env: { SystemRoot: process.env.SystemRoot ?? '', MYHARNESS_TOKENIZER_MODELS: JSON.stringify({ 'qwen3:8b': path.resolve(gguf) }) },
  stdio: ['ignore', 'pipe', 'ignore'],
});
try {
  const banner = await new Promise((resolve, reject) => { child.stdout.once('data', chunk => resolve(String(chunk))); child.once('exit', code => reject(new Error('helper exited with ' + code))); });
  const base = /http:\/\/127\.0\.0\.1:\d+/.exec(banner)[0];
  const from = website => (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: website } });
  const client = new TokenHelperClient(base, from(origin));
  const info = await client.connect();
  assert.equal(info.automatic, true); assert.deepEqual(info.models, ['qwen3:8b']);
  const result = await client.tokenize('qwen3:8b', '<|im_start|>user\nRemember 42<|im_end|>\n');
  const pieces = result.tokens.map(token => Buffer.from(token.bytes).toString());
  assert.deepEqual(pieces, ['<|im_start|>', 'user', '\n', 'Remember', ' ', '4', '2', '<|im_end|>', '\n']);
  assert.equal(result.tokens[0].id, 151644); assert.equal(result.identity, 'operator-configured GGUF for qwen3:8b');
  await assert.rejects(new TokenHelperClient(base, from('https://another-website.example')).connect(), /403/);
  console.log('Tokenizer helper works with the page client: ' + pieces.length + ' token pieces from a real vocabulary; other websites refused.');
} finally { child.kill(); }

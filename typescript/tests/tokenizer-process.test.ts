import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { TokenizerProcess } from '../src/node/tokenizer-process.js';
import { ManagedTokenizer } from '../src/node/managed-tokenizer.js';
import { OllamaAdapter } from '../src/ollama.js';

async function fixture(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'tokenizer-channel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'helper');
  await writeFile(executable, `#!/usr/bin/env node
const readline=require('node:readline');
const mode=process.argv[3];
if(mode==='exit')process.exit(1);
console.log('{"ready":true,"protocol":1,"vocab_only":true}');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const text=JSON.parse(line).content;
 if(text==='stall')return;
 if(text==='exit'){process.exit(1);return;}
 if(text==='large'){process.stdout.write('x'.repeat(64*1024*1024+1));return;}
 if(text==='extra'){process.stdout.write('{}\\n{}\\n');return;}
 if(text==='invalid'){console.log('bad');return;}
 if(text==='null'){console.log('null');return;}
 if(text==='shape'){console.log('{}');return;}
 if(text==='token'){console.log('{"tokens":[{"id":-1,"bytes":[]}]}');return;}
 if(text==='fragmented'){process.stdout.write('{');setTimeout(()=>console.log('"tokens":[]}'),10);return;}
 console.log(JSON.stringify({tokens:[{id:1,bytes:[...Buffer.from(text)]}]}));
});
`, { mode: 0o755 });
  const file = path.join(root, 'model.gguf'); await writeFile(file, 'GGUF');
  return { executable, file };
}
const signal = () => new AbortController().signal;

test('private tokenizer channel handles readiness, split responses, reuse and arbitrary text', async t => {
  const f = await fixture(t), process = new TokenizerProcess(f.executable, f.file); t.after(() => process.close());
  assert.equal(process.failed, false);
  assert.deepEqual(await process.exchange(signal()), { ready: true, protocol: 1, vocab_only: true });
  const text = 'é\n\0😀';
  assert.deepEqual(await process.exchange(signal(), text), { tokens: [{ id: 1, bytes: [...Buffer.from(text)] }] });
  assert.deepEqual(await process.exchange(signal(), 'fragmented'), { tokens: [] });
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(process.exchange(aborted.signal));
  await assert.rejects(process.exchange(signal(), 'x'.repeat(8 * 1024 * 1024)), /input limit/);
  assert.deepEqual(await process.exchange(signal(), ''), { tokens: [{ id: 1, bytes: [] }] });
});

test('interrupted or invalid exchanges kill the owned helper and cannot reuse the channel', async t => {
  const f = await fixture(t);
  for (const text of ['invalid', 'extra', 'large', 'exit', 'stall']) {
    const process = new TokenizerProcess(f.executable, f.file); t.after(() => process.close());
    await process.exchange(signal());
    const pending = process.exchange(AbortSignal.timeout(3000), text);
    const rejection = assert.rejects(pending, /invalid protocol|exceeded|exited|cancelled/);
    await assert.rejects(process.exchange(signal(), 'hello'), /busy/);
    await rejection; assert.equal(process.failed, true);
    await assert.rejects(process.exchange(signal(), 'hello'));
  }
  const idle = new TokenizerProcess(f.executable, f.file);
  await idle.exchange(signal()); idle.close(); await delay(20);
  assert.equal(idle.failed, true); await assert.rejects(idle.exchange(signal()), /exited/);
});

test('startup failure and permission errors are sanitized', async t => {
  const f = await fixture(t);
  for (const executable of ['/missing-tokenizer-binary', f.file]) {
    const process = new TokenizerProcess(executable, f.file);
    await assert.rejects(process.exchange(signal()), /not installed|executable permissions/);
    assert.equal(process.failed, true); process.close();
  }
  const process = new TokenizerProcess(f.executable, 'exit');
  await assert.rejects(process.exchange(signal()), /exited/); process.close();
});

test('managed tokenizer validates pieces, kills failed channels and retries with a fresh vocabulary', async t => {
  const f = await fixture(t), manager = new ManagedTokenizer({ executable: f.executable, models: { m: f.file } }, 'http://remote.test', async () => { throw new Error('no HTTP tokenizer allowed'); });
  t.after(() => manager.close());
  for (const text of ['null', 'shape', 'token', 'stall']) {
    const binding = await manager.binding('m', signal());
    await assert.rejects(binding.tokenize(text, AbortSignal.timeout(100)), /pieces|invalid token|cancelled/);
  }
  const binding = await manager.binding('m', signal());
  assert.deepEqual((await binding.tokenize('hello', signal())).tokens, [{ id: '1', bytes: [104,101,108,108,111] }]);
  const adapter = new OllamaAdapter(async () => Response.json({ _debug_info: { rendered_template: 'hello' } }), 'http://renderer.test', {}, { m: binding });
  const result = await adapter.inspectTokens({ model: 'm', stream: true, messages: [], options: { num_ctx: 512 } });
  assert.equal(result.count, 1); assert.equal(result.fidelity, 'configured-tokenizer');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStorage } from '../src/browser/storage.js';
import { CredentialVault } from '../src/browser/vault.js';

const binding = { kind: 'model' as const, id: 'openai', endpoint: 'https://api.openai.com/' };
const password = 'a long private passphrase';

test('vault persists only authenticated ciphertext and binds credentials to the selected connection', async () => {
  const storage = new MemoryStorage(), vault = new CredentialVault(storage);
  assert.deepEqual(vault.status(), { id: '', locked: true }); assert.deepEqual(await vault.list(), []);
  await assert.rejects(vault.create('a', 'short', 'short'), /12 characters/);
  await assert.rejects(vault.create('a', password, 'different'), /matching/);
  await assert.rejects(vault.save(binding, 'secret'), /Unlock/);
  const id = await vault.create('Mine', password, password);
  assert.deepEqual(await vault.list(), [{ id, label: 'Mine' }]);
  await vault.save(binding, 'PRIVATE-KEY');
  const before = await storage.get<Record<string, unknown>>('settings', 'vault-' + id);
  await vault.save(binding, 'PRIVATE-KEY');
  assert.notDeepEqual(await storage.get('settings', 'vault-' + id), before);
  assert.equal(JSON.stringify(await storage.all('settings')).includes('PRIVATE-KEY'), false);
  assert.equal(await vault.read(binding), 'PRIVATE-KEY');
  assert.equal(await vault.read({ ...binding, endpoint: 'https://another.test/' }), undefined);
  assert.equal(await vault.read({ ...binding, id: 'anthropic' }), undefined);
  await vault.forget(binding); assert.equal(await vault.read(binding), undefined);
  await vault.save(binding, 'PRIVATE-KEY'); vault.lock();
  await assert.rejects(vault.read(binding), /Unlock/);
  const other = new CredentialVault(storage); await assert.rejects(other.unlock(id, 'wrong'), /Could not unlock/);
  await other.unlock(id, password); assert.equal(await other.read(binding), 'PRIVATE-KEY'); assert.equal(vault.status().locked, true);
  const record = await storage.get<{ secrets: Record<string, { data: number[] }> }>('settings', 'vault-' + id);
  record!.secrets[JSON.stringify(['model', 'openai', binding.endpoint])]!.data[0]! ^= 1;
  await storage.put('settings', 'vault-' + id, record); await other.unlock(id, password);
  await assert.rejects(other.read(binding));
  await vault.delete(id); assert.deepEqual(await vault.list(), []); await assert.rejects(other.unlock(id, password), /Could not unlock/);
  await storage.put('settings', 'vault-bad', { version: 99 }); await assert.rejects(other.unlock('bad', password));
  storage.close(); assert.deepEqual(await storage.all('settings'), []); assert.equal(await storage.get('settings', 'x'), undefined);
});

test('vault cannot leak results after locking during asynchronous crypto or persistence', async () => {
  const storage = new MemoryStorage();
  let phase = '', entered!: () => void, finish!: () => void;
  const defer = async (name: string) => { if (phase === name) { phase = ''; entered(); await new Promise<void>(resolve => { finish = resolve; }); } };
  const crypto_ = { randomUUID: () => crypto.randomUUID(), getRandomValues: <T extends ArrayBufferView>(value: T) => crypto.getRandomValues(value), subtle: {
    importKey: (...args: Parameters<SubtleCrypto['importKey']>) => crypto.subtle.importKey(...args),
    deriveKey: async (...args: Parameters<SubtleCrypto['deriveKey']>) => { await defer('derive'); return crypto.subtle.deriveKey(...args); },
    encrypt: async (...args: Parameters<SubtleCrypto['encrypt']>) => { await defer('encrypt'); return crypto.subtle.encrypt(...args); },
    decrypt: async (...args: Parameters<SubtleCrypto['decrypt']>) => { await defer('decrypt'); return crypto.subtle.decrypt(...args); },
  } } as unknown as Crypto;
  const vault = new CredentialVault(storage, crypto_);
  const race = async (name: string, operation: () => Promise<unknown>, error = true) => {
    phase = name; const started = new Promise<void>(resolve => { entered = resolve; });
    const work = operation(); const rejected = error ? assert.rejects(work) : work;
    await started; vault.lock(); finish(); await rejected; phase = '';
  };
  await race('derive', () => vault.create('one', password, password));
  const id = await vault.create('one', password, password); await vault.save(binding, 'key');
  await race('derive', () => vault.unlock(id, password));
  await vault.unlock(id, password); await race('encrypt', () => vault.save(binding, 'new'));
  await vault.unlock(id, password); await race('decrypt', () => vault.read(binding));
  await vault.unlock(id, password);
  const original = storage.put.bind(storage);
  storage.put = async (...args) => { await defer('persist'); return original(...args); };
  await race('persist', () => vault.save(binding, 'new'), false);
  await race('persist', () => vault.create('two', password, password));
});

test('concurrent vault mutations preserve unrelated bindings and reject queued operations after lock', async () => {
  const storage = new MemoryStorage(), vault = new CredentialVault(storage), other = { ...binding, id: 'other' };
  await vault.create('Mine', password, password);
  await Promise.all([vault.save(binding, 'first'), vault.save(other, 'second')]); assert.equal(await vault.read(binding), 'first'); assert.equal(await vault.read(other), 'second');
  for (const invalid of [{ ...binding, kind: 'other' }, { ...binding, id: '' }, { ...binding, endpoint: 'file:///etc' }, { ...binding, endpoint: 'https://user:password@api.test' }]) await assert.rejects(vault.save(invalid as typeof binding, 'NO'));
  let finish!: () => void, entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const original = storage.put.bind(storage);
  storage.put = async (...args) => { entered(); await new Promise<void>(resolve => { finish = resolve; }); return original(...args); };
  const first = vault.forget(binding), second = vault.forget(other), third = vault.save(other, 'NO'); const denied = Promise.all([assert.rejects(second), assert.rejects(third)]);
  await started; vault.lock(); finish(); await first; await denied; assert.equal(vault.status().locked, true);
  storage.put = original; await vault.unlock((await vault.list())[0]!.id, password); assert.equal(await vault.read(other), 'second');
  await storage.put('settings', 'ordinary', { unrelated: true }); assert.equal((await vault.list()).length, 1);
});

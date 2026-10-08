import { DiagnosticError } from '../failure.js';
class VaultError extends DiagnosticError {
  constructor(reason: string) { super({ source: 'harness', component: 'Credential vault', reason, recovery: 'Check the vault settings in Guide & Setup and unlock it before using saved credentials.' }); }
}
import type { StoragePort } from './storage.js';

export interface SecretBinding { kind: 'model' | 'mcp' | 'bridge'; id: string; endpoint: string }
interface Cipher { iv: number[]; data: number[] }
interface VaultRecord { id: string; version: 1; label: string; salt: number[]; check: Cipher; secrets: Record<string, Cipher> }
const encoder = new TextEncoder();
const bindingKey = (binding: SecretBinding) => {
  if (!['model', 'mcp', 'bridge'].includes(binding.kind) || !binding.id) throw new VaultError('Invalid credential binding.');
  const endpoint = new URL(binding.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new VaultError('Invalid credential endpoint.');
  return JSON.stringify([binding.kind, binding.id, endpoint.href]);
};

/** Secrets are confined to this instance; persistent records are authenticated ciphertext. */
export class CredentialVault {
  private key: CryptoKey | undefined;
  private record: VaultRecord | undefined;
  private id = '';
  private generation = 0;
  private mutations: Promise<void> = Promise.resolve();
  private mutate(operation: () => Promise<void>): Promise<void> {
    const next = this.mutations.then(operation);
    this.mutations = next.catch(() => undefined);
    return next;
  }
  constructor(private readonly storage: StoragePort, private readonly crypto_: Crypto = crypto) {}
  status() { return { id: this.id, locked: !this.key }; }
  async list(): Promise<{ id: string; label: string }[]> {
    return (await this.storage.all<VaultRecord | null>('settings')).filter((record): record is VaultRecord => !!record && record.version === 1 && typeof record.id === 'string').map(({ id, label }) => ({ id, label }));
  }
  private async derive(passphrase: string, salt: number[]): Promise<CryptoKey> {
    const material = await this.crypto_.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return this.crypto_.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations: 600_000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  private async encrypt(key: CryptoKey, value: string, binding: string): Promise<Cipher> {
    const iv = this.crypto_.getRandomValues(new Uint8Array(12));
    const data = await this.crypto_.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(binding) }, key, encoder.encode(value));
    return { iv: [...iv], data: [...new Uint8Array(data)] };
  }
  private async decrypt(key: CryptoKey, cipher: Cipher, binding: string): Promise<string> {
    const data = await this.crypto_.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(cipher.iv), additionalData: encoder.encode(binding) }, key, new Uint8Array(cipher.data));
    return new TextDecoder().decode(data);
  }
  lock(): void { this.generation++; this.key = undefined; this.record = undefined; }
  async create(label: string, passphrase: string, confirmation: string): Promise<string> {
    if (passphrase.length < 12 || passphrase !== confirmation) throw new VaultError('Use a matching passphrase of at least 12 characters.');
    this.lock();
    const generation = this.generation, id = this.crypto_.randomUUID(), salt = [...this.crypto_.getRandomValues(new Uint8Array(16))];
    const key = await this.derive(passphrase, salt), check = await this.encrypt(key, 'myharness-vault-v1', id);
    if (generation !== this.generation) throw new VaultError('Vault was locked during creation.');
    const record: VaultRecord = { id, version: 1, label, salt, check, secrets: {} };
    await this.storage.put('settings', 'vault-' + id, record);
    if (generation !== this.generation) throw new VaultError('Vault was locked during creation.');
    this.id = id; this.key = key; this.record = record; return id;
  }
  async unlock(id: string, passphrase: string): Promise<void> {
    this.lock(); const generation = this.generation;
    try {
      const record = await this.storage.get<VaultRecord>('settings', 'vault-' + id);
      if (!record || record.version !== 1 || record.id !== id) throw new VaultError('Unsupported vault');
      const key = await this.derive(passphrase, record.salt);
      if (await this.decrypt(key, record.check, id) !== 'myharness-vault-v1' || generation !== this.generation) throw new VaultError('Locked');
      this.id = id; this.key = key; this.record = record;
    } catch { throw new VaultError('Could not unlock this vault. Check the passphrase and vault record.'); }
  }
  private unlocked(): { key: CryptoKey; record: VaultRecord } {
    if (!this.key || !this.record) throw new VaultError('Unlock the credential vault first.');
    return { key: this.key, record: this.record };
  }
  async save(binding: SecretBinding, secret: string): Promise<void> {
    const generation = this.generation;
    return this.mutate(async () => {
    if (generation !== this.generation) throw new VaultError('Vault was locked during saving.');
    const { key, record } = this.unlocked(), name = bindingKey(binding);
    const cipher = await this.encrypt(key, secret, this.id + name);
    if (generation !== this.generation) throw new VaultError('Vault was locked during saving.');
    const next = { ...record, secrets: { ...record.secrets, [name]: cipher } };
    await this.storage.put('settings', 'vault-' + this.id, next);
    if (generation === this.generation) this.record = next;
    });
  }
  async read(binding: SecretBinding): Promise<string | undefined> {
    const { key, record } = this.unlocked(), generation = this.generation, name = bindingKey(binding), cipher = record.secrets[name];
    if (!cipher) return undefined;
    const secret = await this.decrypt(key, cipher, this.id + name);
    if (generation !== this.generation) throw new VaultError('Vault was locked during reading.');
    return secret;
  }
  async forget(binding: SecretBinding): Promise<void> {
    const generation = this.generation;
    return this.mutate(async () => {
    if (generation !== this.generation) throw new VaultError('Vault was locked during removal.');
    const { record } = this.unlocked(), next = { ...record, secrets: { ...record.secrets } };
    delete next.secrets[bindingKey(binding)];
    await this.storage.put('settings', 'vault-' + this.id, next); if (generation === this.generation) this.record = next;
    });
  }
  async delete(id: string): Promise<void> {
    this.lock();
    await this.storage.put('settings', 'vault-' + id, null);
  }
}

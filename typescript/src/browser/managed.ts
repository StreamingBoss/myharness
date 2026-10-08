import { DiagnosticError } from '../failure.js';
class ManagedActionError extends DiagnosticError {
  constructor(reason: string) { super({ source: 'harness', component: 'Guide session', reason, recovery: 'Check the session and connection settings in Guide & Setup.' }); }
}
import { modelConfiguration } from '../providers.js';
import { BrowserStorage, type StoragePort } from './storage.js';
import { CredentialVault, type SecretBinding } from './vault.js';
import type { BrowserHarness } from './harness.js';
import { object, text } from '../bridge/protocol.js';

const endpoints: Record<string, string> = { gemini: 'https://generativelanguage.googleapis.com/', openai: 'https://api.openai.com/', anthropic: 'https://api.anthropic.com/' };
export class ManagedSessionEndedError extends ManagedActionError {}
export const MANAGED_ACTIONS = ['managedStatus', 'linkHeartbeat', 'activity', 'lock', 'endSession', 'bridgeHeartbeat', 'attachBridge', 'detachBridge', 'vaultList', 'vaultCreate', 'vaultUnlock', 'vaultDelete', 'vaultForget', 'forgetModel', 'forgetMcp', 'connectModel', 'saveMcp', 'restoreMcp'];

/** Managed lifecycle and credential policy belong to the backend, never the page. */
export class ManagedSession {
  private vault: CredentialVault | undefined;
  private vaultStorage: StoragePort | undefined;
  private vaultLoading: Promise<CredentialVault> | undefined;
  private activityAt: number;
  private bridgeAt = 0;
  private bridgeActive = false;
  private ended = false;
  private ending: Promise<void> | undefined;
  private locking: Promise<void> | undefined;
  private generation = 0;
  constructor(readonly harness: BrowserHarness, readonly temporary: boolean, private readonly now = Date.now,
    private readonly openVault: () => Promise<StoragePort> = () => BrowserStorage.open('myharness-credentials-v1')) { this.activityAt = now(); }
  private async credentials(): Promise<CredentialVault> {
    if (this.temporary) throw new ManagedActionError('Credential saving is disabled on shared computers.');
    this.vaultLoading ??= this.openVault().then(storage => { if (this.ended) { storage.close(); throw new ManagedActionError('Managed experiment has ended.'); } this.vaultStorage = storage; return this.vault = new CredentialVault(storage); });
    return this.vaultLoading;
  }
  async tick(): Promise<void> {
    if (this.ended) return;
    if (this.temporary && this.now() - this.activityAt >= 600_000) await this.lock();
    if (this.bridgeActive && this.now() - this.bridgeAt >= 5000) {
      this.bridgeAt = this.now();
      try { await this.harness.bridgeHeartbeat(); } catch { if (this.temporary) await this.lock(); }
    }
  }
  async lock(): Promise<void> {
    this.generation++; this.bridgeActive = false; this.vault?.lock();
    this.locking ??= this.harness.lockCredentials().finally(() => { this.locking = undefined; });
    return this.locking;
  }
  async end(): Promise<void> {
    this.ended = true;
    return this.ending ??= (async () => { await this.lock(); await this.harness.close(); this.harness.closeStorage(); this.vaultStorage?.close(); })();
  }
  private modelBinding(provider: string): SecretBinding {
    const endpoint = endpoints[provider]; if (!endpoint) throw new ManagedActionError('Only cloud API keys can be saved.');
    return { kind: 'model', id: provider, endpoint };
  }
  ensureActive(): void { if (this.ended) throw new ManagedSessionEndedError('The Guide session has ended. Return to Guide & Setup and open a new experiment. Keep Guide open while using the harness.'); }
  async protect<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureActive(); const generation = this.generation;
    try { return await operation(); }
    finally { if (generation !== this.generation) { await this.lock(); throw new ManagedActionError('Connection cancelled by credential locking.'); } }
  }
  async call(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (action === 'endSession') { await this.end(); return { ok: true }; }
    this.ensureActive();
    const generation = this.generation;
    switch (action) {
      case 'managedStatus': return { temporary: this.temporary, vault: this.vault?.status() ?? { locked: true, id: '' } };
      case 'linkHeartbeat': return { ok: true };
      case 'activity': this.activityAt = this.now(); return { ok: true };
      case 'lock': await this.lock(); return { ok: true };
      case 'bridgeHeartbeat': await this.harness.bridgeHeartbeat(); return { ok: true };
      case 'detachBridge': await this.harness.detachBridge(); this.bridgeActive = false; return { ok: true };
      case 'attachBridge': await this.harness.attachBridge(text(payload, 'endpoint'), text(payload, 'code'), !this.temporary); if (generation !== this.generation) { await this.lock(); throw new ManagedActionError('Bridge connection cancelled by credential locking.'); } this.bridgeActive = true; return { ok: true, connection: this.harness.bridgeStatus() };
      case 'vaultList': return (await this.credentials()).list();
      case 'vaultCreate':
      case 'vaultUnlock': {
        const vault = await this.credentials();
        const id = action === 'vaultCreate' ? await vault.create(text(payload, 'label'), text(payload, 'passphrase'), text(payload, 'confirmation')) : await vault.unlock(text(payload, 'id'), text(payload, 'passphrase'));
        if (generation !== this.generation) { vault.lock(); throw new ManagedActionError('Vault operation cancelled by credential locking.'); }
        return action === 'vaultCreate' ? { id } : { ok: true };
      }
      case 'vaultDelete': await this.lock(); await (await this.credentials()).delete(text(payload, 'id')); return { ok: true };
      case 'forgetModel': await (await this.credentials()).forget(this.modelBinding(text(payload, 'provider'))); return { ok: true };
      case 'forgetMcp': {
        const vault = await this.credentials();
        for (const [id, raw] of Object.entries(object(object(payload.config).mcpServers))) await vault.forget({ kind: 'mcp', id, endpoint: text(object(raw), 'url') });
        return { ok: true };
      }
      case 'vaultForget': await (await this.credentials()).forget(object(payload.binding) as unknown as SecretBinding); return { ok: true };
      case 'connectModel': {
        const config = modelConfiguration(object(payload.config)), provider = config.provider ?? config.mode!;
        if (payload.restore === true) {
          const key = await (await this.credentials()).read(this.modelBinding(provider));
          if (!key || generation !== this.generation) throw new ManagedActionError('No saved credential for this connection, or the vault was locked.');
          config.apiKey = key;
        }
        await this.harness.configureModel(config, true);
        if (generation !== this.generation) { await this.lock(); throw new ManagedActionError('Connection cancelled by credential locking.'); }
        if (payload.remember === true) {
          const binding = this.modelBinding(provider);
          if (!config.apiKey) throw new ManagedActionError('Enter or restore the API key before saving it.');
          await (await this.credentials()).save(binding, config.apiKey);
        }
        return { ok: true };
      }
      case 'saveMcp':
      case 'restoreMcp': {
        const vault = await this.credentials(), config = structuredClone(object(payload.config)), servers = object(config.mcpServers);
        for (const [id, raw] of Object.entries(servers)) {
          const server = object(raw), binding: SecretBinding = { kind: 'mcp', id, endpoint: text(server, 'url') };
          if (action === 'saveMcp') { if (server.headers !== undefined) await vault.save(binding, JSON.stringify(object(server.headers))); }
          else { const saved = await vault.read(binding); if (saved) server.headers = JSON.parse(saved); }
        }
        if (generation !== this.generation) throw new ManagedActionError('MCP connection cancelled by credential locking.');
        await this.harness.configureMcp(config);
        if (generation !== this.generation) { await this.lock(); throw new ManagedActionError('MCP connection cancelled by credential locking.'); }
        return { ok: true };
      }
      default: throw new ManagedActionError('Unknown managed backend action');
    }
  }
}

import { failureText } from '../src/failure.js';
import { WorkerClient, type WorkerPort } from '../src/browser/client.js';
import { SessionRelay } from '../src/browser/channel.js';

export interface GuidePlatform {
  worker(url: URL): WorkerPort;
  open(url: string): Window | null;
  channel(): MessageChannel;
}

/** View/controller only: all configuration, privacy and execution actions go to the backend. */
export function mountGuide(document_: Document, window_: Window, platform: GuidePlatform): () => void {
  const input = (id: string) => document_.getElementById(id) as HTMLInputElement;
  const status = (message: string) => { input('status').textContent = message; };
  let worker: WorkerPort | undefined, client: WorkerClient | undefined, relay: SessionRelay | undefined, child: Window | null = null;
  let ending: Promise<void> | undefined;
  const notifyHarness = () => { if (child && !child.closed) child.postMessage({ type: 'harness-state-changed' }, window_.location.origin); };
  const clearFields = () => { for (const id of ['api-key', 'passphrase', 'confirmation', 'bridge-code', 'mcp-config']) input(id).value = ''; };
  const end = async () => {
    if (!client) return;
    const current = client;
    ending ??= (async () => {
      try { await current.call('endSession'); } finally { relay!.close(); current.close(); client = undefined; worker = undefined; relay = undefined; child = null; clearFields(); input('bridge-status').textContent = ''; input('model-status').textContent = ''; status('Session ended. Temporary data and unlocked credentials cleared.'); }
    })().finally(() => { ending = undefined; });
    await ending;
  };
  const backend = () => {
    if (!client) {
      const url = new URL('./managed-worker.js', window_.location.href);
      url.searchParams.set('temporary', input('privacy').value === 'shared' ? '1' : '0');
      worker = platform.worker(url); client = new WorkerClient(worker);
      relay = new SessionRelay(worker, () => { void end().catch(() => status('Session connection closed.')); });
    }
    return client;
  };
  const command = (id: string, action: () => Promise<void>) => {
    input(id).addEventListener('click', () => { void action().catch(error => { clearFields(); status(failureText(error, 'Could not complete this action. Check connections, passphrase, mode, and whether the harness is busy.')); }); });
  };
  const models = async () => {
    const config = { provider: input('provider').value, url: input('ollama-url').value, apiKey: input('api-key').value };
    const entries = await backend().call('listModels', config) as { id: string; label: string }[];
    const select = input('model') as unknown as HTMLSelectElement; select.replaceChildren();
    for (const entry of entries) { const option = document_.createElement('option'); option.value = entry.id; option.textContent = entry.label; select.append(option); }
    status(entries.length ? 'Models available. Choose one, then connect.' : 'No models available for this connection.');
  };
  const render = () => {
    const local = input('provider').value === 'ollama', shared = input('privacy').value === 'shared';
    input('ollama-fields').hidden = !local; input('api-fields').hidden = local;
    input('personal-fields').hidden = shared; input('shared-fields').hidden = !shared;
    input('save-key').disabled = shared || local; input('restore-key').disabled = shared || local;
  };
  input('provider').addEventListener('change', () => { input('model-status').textContent = ''; input('api-key').value = ''; input('model').replaceChildren(); render(); });
  input('privacy').addEventListener('change', () => { void end().then(render).catch(() => status('End the current experiment before changing privacy mode.')); });
  command('check-models', models);
  command('connect-model', async () => {
    const button = input('connect-model');
    const report = (message: string) => { input('model-status').textContent = message; status(message); };
    button.disabled = true;
    report('Connecting selected model…');
    try {
      await backend().call('connectModel', { config: { provider: input('provider').value, model: input('model-id').value || input('model').value, url: input('ollama-url').value, ...(input('api-key').value ? { apiKey: input('api-key').value } : {}) }, remember: input('save-key').checked && !input('save-key').disabled, restore: input('restore-key').checked && !input('restore-key').disabled });
      notifyHarness();
      report('Model connected. Open the harness to experiment.');
    } catch (error) {
      report(failureText(error, 'Could not connect to model. Check the provider, model ID, API key or unlocked vault, and whether the harness is busy. For Ollama, check its address and allowed website origin.'));
    } finally {
      input('api-key').value = '';
      button.disabled = false;
    }
  });
  command('list-vaults', async () => {
    const entries = await backend().call('vaultList') as { id: string; label: string }[];
    const select = input('vault') as unknown as HTMLSelectElement; select.replaceChildren();
    for (const entry of entries) { const option = document_.createElement('option'); option.value = entry.id; option.textContent = entry.label; select.append(option); }
    status(entries.length ? 'Select a vault and unlock it.' : 'No saved vaults. Create one to opt in to credential saving.');
  });
  command('create-vault', async () => {
    const value = await backend().call('vaultCreate', { label: input('vault-label').value, passphrase: input('passphrase').value, confirmation: input('confirmation').value }) as { id: string };
    const option = document_.createElement('option'); option.value = value.id; option.textContent = input('vault-label').value;
    input('vault').replaceChildren(option); clearFields(); status('Vault created and unlocked. Saving still requires your explicit choice.');
  });
  command('unlock-vault', async () => { await backend().call('vaultUnlock', { id: input('vault').value, passphrase: input('passphrase').value }); clearFields(); status('Vault unlocked. Select Restore saved key when connecting.'); });
  command('forget-model', async () => { await backend().call('forgetModel', { provider: input('provider').value }); status('Saved model credential removed from this vault. Lock to clear active connections.'); });
  command('forget-mcp', async () => { await backend().call('forgetMcp', { config: JSON.parse(input('mcp-config').value) }); input('mcp-config').value = ''; status('Selected saved MCP credentials removed. Lock to clear active connections.'); });
  command('delete-vault', async () => { await backend().call('vaultDelete', { id: input('vault').value }); notifyHarness(); input('vault').replaceChildren(); clearFields(); status('Encrypted vault deleted. Saved conversations remain.'); });
  command('lock', async () => { await backend().call('lock'); notifyHarness(); clearFields(); input('bridge-status').textContent = ''; input('model-status').textContent = ''; status('Credentials locked and authenticated work stopped.'); });
  input('bridge-origin').textContent = window_.location.origin;
  command('disconnect-bridge', async () => {
    await backend().call('detachBridge'); notifyHarness();
    input('bridge-status').textContent = 'Bridge unpaired. Native bridge tools removed; model connection kept.';
    status(input('bridge-status').textContent);
  });
  command('connect-bridge', async () => {
    const button = input('connect-bridge');
    const report = (message: string) => { input('bridge-status').textContent = message; status(message); };
    button.disabled = true;
    report('Connecting to local bridge…');
    try {
      const result = await backend().call('attachBridge', { endpoint: input('bridge-url').value, code: input('bridge-code').value }) as { connection: { workspace: string; grants: { writes: boolean; commands: boolean; gitWrites: boolean } } };
      const grants = result.connection.grants;
      notifyHarness();
      report(`Native workspace connected: ${result.connection.workspace}. Writes: ${grants.writes ? 'granted' : 'unavailable'}; Bash: ${grants.commands ? 'granted' : 'unavailable'}; Git mutations: ${grants.gitWrites ? 'granted' : 'unavailable'}.`);
    } catch (error) {
      report(failureText(error, '') + `\n\nCould not connect to local bridge.\n\nThis page’s exact origin is ${window_.location.origin}. Start the bridge with:\n--origin ${window_.location.origin}\n\nhttp:// and https:// are different origins. The hostname and website port must also match.\n\nIf the bridge was started with a different origin, stop it with Ctrl+C, restart it with the argument above, and paste the new pairing code.\n\nIf the origin already matches, check that the bridge is running at the entered address and that your browser allows local-network access. Pairing codes expire after five minutes and can only be used once.`);
    } finally {
      input('bridge-code').value = '';
      button.disabled = false;
    }
  });
  command('save-mcp', async () => { await backend().call('saveMcp', { config: JSON.parse(input('mcp-config').value) }); notifyHarness(); input('mcp-config').value = ''; status('MCP credentials saved encrypted and connections configured.'); });
  command('restore-mcp', async () => { await backend().call('restoreMcp', { config: JSON.parse(input('mcp-config').value) }); notifyHarness(); input('mcp-config').value = ''; status('MCP credentials restored for matching connection endpoints.'); });
  command('end-session', end);
  command('open-harness', async () => {
    if (child && !child.closed) { child.focus(); return; }
    backend();
    child = platform.open(new URL('./index.html?managed=1', window_.location.href).href);
    if (!child) throw new Error('Allow this site to open the harness tab.');
    status('Harness opened. Keep this guide tab open.');
  });
  const ready = (event: MessageEvent) => {
    if (!child || event.source !== child || event.origin !== window_.location.origin || event.data?.type !== 'harness-ready') return;
    const channel = platform.channel();
    // Identity and origin were checked above: this is the same authorized tab,
    // possibly reloaded, so retire its previous port before handing off a new one.
    try { relay!.attach(channel.port1, true); child.postMessage({ type: 'harness-port' }, window_.location.origin, [channel.port2]); }
    catch { channel.port1.close(); channel.port2.close(); status('Could not connect the harness tab. Close it and reopen from Guide & Setup.'); }
  };
  const activity = () => { if (client) void client.call('activity').catch(() => undefined); };
  const pagehide = () => { void end().catch(() => undefined); worker?.terminate(); clearFields(); };
  window_.addEventListener('message', ready); window_.addEventListener('pointerdown', activity); window_.addEventListener('keydown', activity); window_.addEventListener('pagehide', pagehide);
  const timer = window_.setInterval(() => { if (child?.closed) void end().catch(() => undefined); }, 1000);
  render();
  return () => {
    window_.clearInterval(timer); window_.removeEventListener('message', ready); window_.removeEventListener('pointerdown', activity); window_.removeEventListener('keydown', activity); window_.removeEventListener('pagehide', pagehide); pagehide();
  };
}

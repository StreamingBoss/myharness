import { ModelPicker } from '../src/browser/model-picker.js';
import { ModelControls } from '../src/browser/model-controls.js';
import { WorkerClient, type WorkerPort } from '../src/browser/client.js';
import { browserFetch } from '../src/browser/fetch.js';

interface BrowserWindow extends Window {
  MYHARNESS_FETCH?: ReturnType<typeof browserFetch>;
  MYHARNESS_EXPORT_SESSION?: (id: string) => Promise<void>;
  harness?: WorkerClient;
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<unknown>;
}

function download(name: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function mountBrowser(): Promise<void> {
  const window_ = window as BrowserWindow;
  const url = new URL('backend-worker.js', import.meta.url);
  const namespace = new URLSearchParams(location.search).get('database'); if (namespace) url.searchParams.set('database', namespace);
  const client = new WorkerClient(new Worker(url, { type: 'module' }) as unknown as WorkerPort);
  window_.harness = client; window_.MYHARNESS_FETCH = browserFetch(client);
  window_.MYHARNESS_EXPORT_SESSION = async id => { const session = await client.call('getSession', { id }) as { name: string }; download(session.name + '.json', session); };
  const bar = document.createElement('div'); bar.id = 'browser-runtime';
  bar.innerHTML = '<strong>Harness backend: browser Worker</strong> · <span id="browser-mode-label"></span><br><label>Model <select id="browser-model-mode"><option value="ollama">Local Ollama</option><option value="gemini">Gemini</option><option value="openai">OpenAI GPT</option><option value="anthropic">Anthropic Claude</option></select></label> <input id="browser-ollama-url" aria-label="Ollama URL" value="http://localhost:11434"><select id="browser-model" aria-label="Model ID" title="Choose a model available from the selected provider." disabled><option value="">Loading models…</option></select><input id="browser-api-key" type="password" aria-label="API key" autocomplete="off" placeholder="Your provider API key"><button id="browser-forget-key">Forget API key</button><details id="browser-token-budgets"><summary>Harness token budgets</summary><p>These are your configured budgets in tokens, not the model’s advertised limits. They stay the same when you switch providers. Changes apply when you start a new session.</p><label title="Memory is trimmed at 75% of this budget; compaction is attempted at 90%.">Working context <input id="browser-context-limit" type="number" value="8192" min="1"></label><label title="Maximum tokens requested per cloud response, including any reasoning tokens counted by the provider.">Maximum output <input id="browser-output-limit" type="number" value="2048" min="1"></label></details><button id="browser-connect">Start new session with this model</button><br><button id="browser-local-folder" title="Open a folder on your computer with direct read/write access. Approved edits are saved to the original files.">Open local folder…</button> <button id="browser-folder-copy-picker" title="Copy the selected folder into browser storage. Only UTF-8 text files are imported; edits affect the copy and leave the original files unchanged." type="button">Import folder copy</button><input id="browser-folder-copy" type="file" aria-label="Import folder copy" webkitdirectory multiple hidden> <button id="browser-project-json-picker" title="Load a project JSON file previously saved with Export project. Restore its files and saved conversations in browser storage, separate from the original local files." type="button">Import JSON project</button><input id="browser-project-json" type="file" aria-label="Import JSON project" accept="application/json,.json" hidden> <button id="browser-export-project" title="Download the current project, its text files and all its sessions as JSON. Full conversation history is included for later restoration.">Export project</button> <button id="browser-mcp-config-picker" type="button" title="Load an MCP configuration JSON file ({&quot;mcpServers&quot;: {...}}). The backend connects to its HTTP servers; stdio servers need the Node runtime. Servers must allow this page origin (CORS). Header values such as tokens stay in Worker memory and are not saved: import the file again after a reload.">Import MCP config</button><input id="browser-mcp-config" type="file" aria-label="Import MCP config" accept="application/json,.json" hidden><span id="browser-runtime-status" role="status"></span>';
  document.body.prepend(bar);
  const status = document.getElementById('browser-runtime-status')!, mode = document.getElementById('browser-model-mode') as HTMLSelectElement;
  const failure = (error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); };
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  const model = document.getElementById('browser-model') as HTMLSelectElement;
  const connect = document.getElementById('browser-connect') as HTMLButtonElement;
  let preferredModel = '';
  const updateConnectionFields = () => {
    const local = mode.value === 'ollama';
    document.getElementById('browser-token-budgets')!.hidden = local;
    input('browser-ollama-url').hidden = !local;
    input('browser-api-key').hidden = local;
    document.getElementById('browser-forget-key')!.hidden = local;
  };
  const render = (state: Record<string, unknown>) => {
    mode.value = state.provider === 'demo' ? 'ollama' : String(state.provider);
    input('browser-context-limit').value = String(state.context_length);
    input('browser-output-limit').value = String(state.max_output_tokens ?? 2048);
    preferredModel = String(state.model);
    model.value = preferredModel;
    input('browser-ollama-url').value = String(state.ollama_url);
    document.getElementById('browser-mode-label')!.textContent = `${state.provider === 'ollama' ? 'Real model · Ollama' : state.provider} · ${state.model} · ${state.ready ? 'ready' : 'enter API key'} · ${state.workspace_kind}`;
    updateConnectionFields();
    window.dispatchEvent(new CustomEvent('myharness:state', { detail: state }));
  };
  const settings = () => ({ provider: mode.value, model: model.value,
      ...(mode.value === 'ollama' ? { url: input('browser-ollama-url').value } : {}),
      ...(mode.value !== 'ollama' ? { contextLength: Number(input('browser-context-limit').value), maxOutputTokens: Number(input('browser-output-limit').value) } : {}),
      ...(mode.value !== 'ollama' && input('browser-api-key').value ? { apiKey: input('browser-api-key').value } : {}) });
  const picker = new ModelPicker(client, {
    settings,
    loading: () => {
      preferredModel = model.value || preferredModel;
      model.replaceChildren(new Option('Loading models…', ''));
      model.disabled = connect.disabled = true; status.textContent = '';
    },
    render: models => {
      model.replaceChildren(...models.map(item => new Option(item.label, item.id)));
      if (models.length) {
        model.value = models.some(item => item.id === preferredModel) ? preferredModel : models[0]!.id;
        model.disabled = connect.disabled = false;
      } else {
        model.replaceChildren(new Option('No models available', ''));
        status.textContent = mode.value === 'ollama' ? 'No installed models found on this Ollama server.' : 'No chat models are available for this provider.';
      }
    },
    failure: message => { model.replaceChildren(new Option('Models unavailable', '')); status.textContent = message; },
  });
  const controls = new ModelControls(client, {
    settings,
    clearKey: () => { input('browser-api-key').value = ''; }, status: message => { status.textContent = message; }, render,
  });
  render(await client.call('bootstrap') as Record<string, unknown>);
  void picker.refresh();
  mode.addEventListener('change', () => {
    preferredModel = ''; model.value = '';
    input('browser-api-key').value = '';
    updateConnectionFields();
    void picker.refresh();
  });
  input('browser-ollama-url').addEventListener('change', () => void picker.refresh());
  input('browser-api-key').addEventListener('change', () => void picker.refresh());
  document.getElementById('browser-connect')!.addEventListener('click', () => void controls.connect());
  document.getElementById('browser-forget-key')!.addEventListener('click', async () => { await controls.forget(); await picker.refresh(); });
  const local = document.getElementById('browser-local-folder') as HTMLButtonElement;
  if (!window_.showDirectoryPicker) { local.disabled = true; local.title = 'Direct folder access needs a supporting browser. Import a folder copy instead.'; }
  local.addEventListener('click', async () => { try { const handle = await window_.showDirectoryPicker!({ mode: 'readwrite' }); await client.call('attachLocalFolder', { handle }); location.reload(); } catch (error) { failure(error); } });
  document.getElementById('browser-folder-copy-picker')!.addEventListener('click', () => input('browser-folder-copy').click());
  document.getElementById('browser-folder-copy')!.addEventListener('change', async event => {
    try {
      const selected = [...(event.target as HTMLInputElement).files!], files = Object.create(null) as Record<string, string>; let skipped = 0;
      const folder = selected[0]!.webkitRelativePath.split('/')[0]!;
      for (const file of selected) { try { const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); if (text.includes('\0')) { skipped++; continue; } files[file.webkitRelativePath.slice(folder.length + 1)] = text; } catch { skipped++; } }
      if (skipped) status.textContent = `Skipped ${skipped} binary/non-UTF8 files.`;
      await client.call('importProject', { format: 'myharness-project', version: 1, root: '/' + folder, files }); location.reload();
    } catch (error) { failure(error); }
  });
  document.getElementById('browser-project-json-picker')!.addEventListener('click', () => input('browser-project-json').click());
  document.getElementById('browser-project-json')!.addEventListener('change', async event => { try { const file = (event.target as HTMLInputElement).files![0]!; await client.call('importProject', JSON.parse(await file.text())); location.reload(); } catch (error) { failure(error); } });
  document.getElementById('browser-mcp-config-picker')!.addEventListener('click', () => input('browser-mcp-config').click());
  document.getElementById('browser-mcp-config')!.addEventListener('change', async event => {
    try {
      const file = (event.target as HTMLInputElement).files![0]!;
      const result = await client.call('configureMcp', JSON.parse(await file.text())) as { servers: { status: string }[] };
      status.textContent = `MCP: ${result.servers.filter(server => server.status === 'connected').length} of ${result.servers.length} servers connected. See Explore → MCP servers.`;
      render(await client.call('bootstrap') as Record<string, unknown>);
    } catch (error) { failure(error); }
  });
  document.getElementById('browser-export-project')!.addEventListener('click', async () => { try { download('myharness-project.json', await client.call('exportProject')); } catch (error) { failure(error); } });
}

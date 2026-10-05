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
  bar.innerHTML = '<strong>Harness backend: browser Worker</strong> · <span id="browser-mode-label"></span><br><label>Model <select id="browser-model-mode"><option value="demo">Scripted demo (not an LLM)</option><option value="ollama">Local Ollama</option></select></label> <input id="browser-ollama-url" aria-label="Ollama URL" value="http://localhost:11434"><input id="browser-model" aria-label="Ollama model" value="qwen3:8b"><button id="browser-connect">Start new session with this model</button><br><button id="browser-local-folder">Open local folder…</button> <label class="browser-import">Import folder copy <input id="browser-folder-copy" type="file" webkitdirectory multiple></label> <label class="browser-import">Import project JSON <input id="browser-project-json" type="file" accept="application/json,.json"></label> <button id="browser-export-project">Export project</button><span id="browser-runtime-status" role="status"></span><details><summary>How this version works</summary>The full harness runs in this browser. The scripted demo follows prepared examples; it does not understand arbitrary questions. Ollama is optional and runs outside the browser. Open local folder grants direct access to that folder; approved edits write back to disk. Imported copies and sessions stay in this browser’s IndexedDB. Bash commands are unavailable. To use Ollama, allow this page’s origin with OLLAMA_ORIGINS. <span id="browser-origin"></span></details>';
  document.body.prepend(bar);
  document.getElementById('browser-origin')!.textContent = 'This origin: ' + location.origin;
  const status = document.getElementById('browser-runtime-status')!, mode = document.getElementById('browser-model-mode') as HTMLSelectElement;
  const failure = (error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); };
  const bootstrap = await client.call('bootstrap') as { model: string; workspace_kind: string; ollama_url: string };
  mode.value = bootstrap.model === 'scripted-demo' ? 'demo' : 'ollama';
  (document.getElementById('browser-ollama-url') as HTMLInputElement).value = bootstrap.ollama_url;
  if (mode.value === 'ollama') (document.getElementById('browser-model') as HTMLInputElement).value = bootstrap.model;
  document.getElementById('browser-mode-label')!.textContent = (mode.value === 'demo' ? 'Scripted teaching examples' : 'Real model via Ollama') + ' · ' + bootstrap.workspace_kind;
  if (mode.value === 'demo') document.getElementById('context-meter')!.title = 'Scripted demo: token counts are estimates from character counts, not measurements from an LLM. Trimming and compaction still use the real harness; demo summaries are scripted.';
  document.getElementById('browser-connect')!.addEventListener('click', async () => {
    try { status.textContent = 'Connecting…'; await client.call('configureModel', { mode: mode.value, model: (document.getElementById('browser-model') as HTMLInputElement).value, url: (document.getElementById('browser-ollama-url') as HTMLInputElement).value }); location.reload(); } catch (error) { failure(error); }
  });
  const local = document.getElementById('browser-local-folder') as HTMLButtonElement;
  if (!window_.showDirectoryPicker) { local.disabled = true; local.title = 'Direct folder access needs a supporting browser. Import a folder copy instead.'; }
  local.addEventListener('click', async () => { try { const handle = await window_.showDirectoryPicker!({ mode: 'readwrite' }); await client.call('attachLocalFolder', { handle }); location.reload(); } catch (error) { failure(error); } });
  document.getElementById('browser-folder-copy')!.addEventListener('change', async event => {
    try {
      const selected = [...(event.target as HTMLInputElement).files!], files = Object.create(null) as Record<string, string>; let skipped = 0;
      const folder = selected[0]!.webkitRelativePath.split('/')[0]!;
      for (const file of selected) { try { const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); if (text.includes('\0')) { skipped++; continue; } files[file.webkitRelativePath.slice(folder.length + 1)] = text; } catch { skipped++; } }
      if (skipped) status.textContent = `Skipped ${skipped} binary/non-UTF8 files.`;
      await client.call('importProject', { format: 'myharness-project', version: 1, root: '/' + folder, files }); location.reload();
    } catch (error) { failure(error); }
  });
  document.getElementById('browser-project-json')!.addEventListener('change', async event => { try { const file = (event.target as HTMLInputElement).files![0]!; await client.call('importProject', JSON.parse(await file.text())); location.reload(); } catch (error) { failure(error); } });
  document.getElementById('browser-export-project')!.addEventListener('click', async () => { try { download('myharness-project.json', await client.call('exportProject')); } catch (error) { failure(error); } });
  const examples = document.createElement('div'); examples.id = 'browser-examples'; examples.textContent = 'Demo examples: ';
  for (const text of ['List files', 'Read README.md', 'Write note.txt: hello', 'Remember 42', 'What do you remember?', 'Show instructions']) { const button = document.createElement('button'); button.textContent = text; button.addEventListener('click', () => { const input = document.getElementById('input') as HTMLTextAreaElement; input.value = text; input.focus(); }); examples.append(button); }
  bar.append(examples);
}

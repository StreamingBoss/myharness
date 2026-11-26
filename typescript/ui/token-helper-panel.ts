import { failureText } from '../src/failure.js';
import { pageTranslator } from '../src/text.js';
import { HELPER_DEFAULT_ORIGIN, HELPER_DOWNLOAD_URL } from '../src/helper-protocol.js';
import type { ModelClient } from '../src/browser/model-controls.js';

/** Optional panel inside the token viewer. The page inserts it and translates it; the controller below only wires it. */
export const TOKEN_HELPER_HTML = `<section id="token-helper" aria-label="Tokenizer helper" hidden>
<p id="token-helper-status" role="status" aria-live="polite"></p>
<details id="token-helper-setup">
<summary title="Optional. Without it the viewer still shows the prompt as Ollama renders it, the token counts and the model vocabulary.">Show token pieces for my Ollama model (optional)</summary>
<p>Ollama does not report how it splits a request into tokens. A small helper program on this computer can: it reads your model's vocabulary and splits the request the same way. It tokenizes text and does nothing else: no files, no commands, no chat.</p>
<ol>
<li data-i18n-html><a id="token-helper-download" href="${HELPER_DOWNLOAD_URL}" target="_blank" rel="noopener" title="Opens the download page on GitHub in a new tab. Choose the file for your system: Linux, macOS or Windows.">Download the tokenizer helper</a> for your system and unpack it.</li>
<li><span data-i18n-html>Start it in a terminal, in the unpacked folder (on Windows, type <code>token-helper.exe</code> instead of <code>./token-helper</code>):</span><pre id="token-helper-command"></pre></li>
<li>Click Connect. After that, this page reconnects by itself whenever the helper is running.</li>
</ol>
<p class="note" data-i18n-html>To start the helper at every login, run the same command once with <code>--install</code> added. The helper only answers the websites named when it starts. Your browser may ask to allow this site to reach devices on your local network.</p>
<button id="token-helper-connect" type="button" title="Connect this page to the tokenizer helper running on this computer, and remember the choice in this browser. No model request is sent.">Connect</button>
</details>
<button id="token-helper-forget" type="button" hidden title="Disconnect the tokenizer helper and stop reconnecting to it. Saved token inspections stay in their sessions.">Forget helper</button>
</section>`;

export interface TokenHelperPanelOptions {
  client: ModelClient;
  /** This page's origin, shown in the helper start command. */
  origin: string;
}
interface HelperStatus { enabled: boolean; connected: boolean }

/** View controller only: connecting, remembering and forgetting the helper are backend actions. */
export function mountTokenHelperPanel(document_: Document, options: TokenHelperPanelOptions): { update(state: Record<string, unknown>): void; shown(): Promise<void> } {
  const node = (id: string) => document_.getElementById(id) as HTMLInputElement;
  const setup = () => node('token-helper-setup') as unknown as HTMLDetailsElement;
  const text = pageTranslator(), { t } = text;
  let status: HelperStatus = { enabled: false, connected: false }, attempted = false, busy = false;
  node('token-helper-command').textContent = options.origin === HELPER_DEFAULT_ORIGIN ? './token-helper' : `./token-helper --origin ${options.origin}`;
  const render = (message?: string) => {
    node('token-helper-forget').hidden = !status.enabled;
    node('token-helper-connect').textContent = status.enabled ? t('Reconnect') : t('Connect');
    node('token-helper-connect').disabled = busy;
    setup().hidden = status.connected;
    if (status.enabled && !status.connected) setup().open = true;
    node('token-helper-status').textContent = message ?? (status.connected ? t('Tokenizer helper connected. Inspect a saved Ollama request to see its token pieces.')
      : status.enabled ? t('The tokenizer helper is not connected. Start it on this computer, then reconnect.') : '');
  };
  const connect = async () => {
    busy = true; render(t('Connecting to the tokenizer helper…'));
    let message: string | undefined;
    try { status = await options.client.call('connectTokenizer') as HelperStatus; }
    catch (error) { message = failureText(error, (error as Error).message, text); }
    busy = false; render(message);
  };
  node('token-helper-connect').addEventListener('click', () => void connect());
  node('token-helper-forget').addEventListener('click', async () => {
    status = await options.client.call('forgetTokenizer') as HelperStatus; attempted = false; render();
  });
  return {
    update(state) {
      // Token pieces through the helper exist for Ollama only; other providers report their own evidence.
      node('token-helper').hidden = state.provider !== 'ollama';
      status = state.tokenizer as HelperStatus; render();
    },
    /** Called when the token view opens: a remembered helper reconnects once per page load, without a click. */
    async shown() {
      status = await options.client.call('tokenizerStatus') as HelperStatus; render();
      if (status.enabled && !status.connected && !attempted && !busy) { attempted = true; await connect(); }
    },
  };
}

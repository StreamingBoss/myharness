import { failureText } from '../src/failure.js';
import type { ModelOption } from '../src/model.js';
import type { ModelClient } from '../src/browser/model-controls.js';

/** First-run card markup. The page inserts it above the chat; the controller below only wires it. */
export const CONNECT_CARD_HTML = `<section id="connect-card" aria-labelledby="connect-title" hidden>
<h2 id="connect-title">Connect a model</h2>
<p class="note">The harness runs in this page. The model is a separate service: the harness sends it requests and shows you each one. Choose where your model runs.</p>
<div class="connect-choices">
<button id="connect-choose-key" type="button" aria-pressed="false" title="Use a model hosted by Gemini, OpenAI, Anthropic, OpenRouter, Mistral, Groq or Cerebras, or a server you name. Requests go from this page to that service; hosted ones are billed to your account."><strong>Use an API key</strong><span>Gemini, OpenAI, Anthropic, OpenRouter, Mistral, Groq, Cerebras or your own server: several have free tiers</span></button>
<button id="connect-choose-ollama" type="button" aria-pressed="false" title="Use a model that Ollama runs on this computer. Choosing this makes the page look for Ollama, so your browser may ask to allow local-network access."><strong>Use Ollama on this computer</strong><span>A local model: requests stay on your machine</span></button>
</div>
<div id="connect-key" class="connect-step" hidden>
<label>Provider <select id="connect-provider" title="The service that runs the model."><option value="gemini">Gemini</option><option value="openai">OpenAI GPT</option><option value="anthropic">Anthropic Claude</option><option value="openrouter">OpenRouter (many models, one key)</option><option value="mistral">Mistral</option><option value="groq">Groq</option><option value="cerebras">Cerebras</option><option value="custom">Custom (OpenAI-compatible)</option></select></label>
<label id="connect-custom" hidden>Server address <input id="connect-custom-url" placeholder="https://host/v1 or http://localhost:1234/v1" spellcheck="false" title="The address of a server that speaks OpenAI-style Chat Completions, such as LM Studio, llama.cpp, vLLM or a company gateway. It must allow this website (CORS). Plain http works only for this computer or your local network."></label>
<label>API key <input id="connect-api-key" type="password" autocomplete="off" placeholder="Paste your key" title="Sent from this page directly to the provider. Kept in memory only: never saved in sessions, settings or exports."></label>
<button id="connect-list" type="button" title="Ask the provider which models this key can use. No model request is sent.">List models</button>
<p class="note">The key is kept in memory only and is never saved. After reloading the page, enter it again.</p>
</div>
<div id="connect-ollama" class="connect-step" hidden>
<div id="connect-ollama-help" hidden>
<p>This page could not reach Ollama at <code id="connect-ollama-shown"></code>. Ollama only answers websites it was told to allow. Quit Ollama if it is running, start it with this page allowed, then try again:</p>
<p class="connect-os">macOS or Linux</p><pre id="connect-ollama-command"></pre>
<p class="connect-os">Windows (PowerShell)</p><pre id="connect-ollama-command-windows"></pre>
<p class="note">Your browser may also ask to allow this site to reach devices on your local network.</p>
</div>
<details><summary>Ollama runs at another address</summary><label>Ollama address <input id="connect-ollama-url" value="http://localhost:11434" spellcheck="false" title="Base URL of the Ollama server. It must allow this page origin."></label></details>
<button id="connect-retry" type="button" title="Look for Ollama again and list its installed models. No model request is sent.">Try again</button>
</div>
<div id="connect-models" class="connect-step" hidden>
<label>Model <select id="connect-model" title="The model this session sends requests to."></select></label>
<button id="connect-go" class="primary" type="button" title="Use this model. The backend checks that it answers, then the chat is ready.">Connect</button>
</div>
<p id="connect-status" role="status" aria-live="polite"></p>
<button id="connect-dismiss" type="button" title="Hide this card until the page is reloaded. You can still read saved sessions; connect a model later in Settings.">Not now</button>
</section>`;

export interface ConnectCardOptions {
  client: ModelClient;
  /** This page's origin, shown in the Ollama start command. */
  origin: string;
  /** Hands fresh backend state to the page after a successful connection. */
  render(state: Record<string, unknown>): void;
}
type Choice = 'key' | 'ollama';
const CLOUD = ['gemini', 'openai', 'anthropic', 'openrouter', 'mistral', 'groq', 'cerebras', 'custom'];

/** View controller only: it lists and connects models through backend actions and renders `model_connected`. */
export function mountConnectCard(document_: Document, options: ConnectCardOptions): { update(state: Record<string, unknown>): void } {
  const node = (id: string) => document_.getElementById(id) as HTMLInputElement;
  const status = (message: string) => { node('connect-status').textContent = message; };
  let choice: Choice | undefined, dismissed = false, generation = 0, prompted = false;
  const settings = (): Record<string, unknown> => choice === 'ollama'
    ? { provider: 'ollama', url: node('connect-ollama-url').value, model: node('connect-model').value }
    : { provider: node('connect-provider').value, model: node('connect-model').value, ...(node('connect-provider').value === 'custom' ? { url: node('connect-custom-url').value } : {}), ...(node('connect-api-key').value ? { apiKey: node('connect-api-key').value } : {}) };
  const reset = () => { generation++; node('connect-models').hidden = true; node('connect-ollama-help').hidden = true; status(''); };
  const show = (next: Choice) => {
    choice = next; reset();
    node('connect-key').hidden = next !== 'key'; node('connect-ollama').hidden = next !== 'ollama';
    node('connect-choose-key').setAttribute('aria-pressed', String(next === 'key'));
    node('connect-choose-ollama').setAttribute('aria-pressed', String(next === 'ollama'));
  };
  const list = async () => {
    reset();
    const current = generation, local = choice === 'ollama', { model: _model, ...query } = settings();
    if (query.provider === 'custom' ? !node('connect-custom-url').value.trim() : !local && !query.apiKey) { status(query.provider === 'custom' ? 'Enter your server address first.' : 'Paste your API key first.'); return; }
    status(local ? 'Looking for Ollama…' : 'Listing models…');
    let models: ModelOption[];
    try { models = await options.client.call('listModels', query) as ModelOption[]; }
    catch (error) {
      if (current !== generation) return;
      if (local) {
        node('connect-ollama-shown').textContent = node('connect-ollama-url').value;
        node('connect-ollama-command').textContent = `OLLAMA_ORIGINS=${options.origin} ollama serve`;
        node('connect-ollama-command-windows').textContent = `$env:OLLAMA_ORIGINS="${options.origin}"; ollama serve`;
        node('connect-ollama-help').hidden = false; status('');
      } else status(failureText(error, (error as Error).message));
      return;
    }
    if (current !== generation) return;
    if (!models.length) { status(local ? 'Ollama is running but has no model installed. Install one, for example with “ollama pull qwen3:8b”, then try again.' : 'This key has no chat models available.'); return; }
    node('connect-model').replaceChildren(...models.map(model => { const option = document_.createElement('option'); option.value = model.id; option.textContent = model.label; return option; }));
    node('connect-model').value = models[0]!.id;
    node('connect-models').hidden = false; status('');
  };
  node('connect-choose-key').addEventListener('click', () => show('key'));
  node('connect-choose-ollama').addEventListener('click', () => { show('ollama'); void list(); });
  node('connect-provider').addEventListener('change', () => { node('connect-api-key').value = ''; node('connect-custom').hidden = node('connect-provider').value !== 'custom'; reset(); });
  node('connect-custom-url').addEventListener('change', () => void list());
  node('connect-ollama-url').addEventListener('change', () => void list());
  node('connect-list').addEventListener('click', () => void list());
  node('connect-retry').addEventListener('click', () => void list());
  node('connect-dismiss').addEventListener('click', () => { dismissed = true; node('connect-card').hidden = true; });
  node('connect-go').addEventListener('click', async () => {
    const button = node('connect-go'), value = settings();
    node('connect-api-key').value = ''; button.disabled = true; status('Connecting…');
    try {
      await options.client.call('configureModel', value);
      status('');
      options.render(await options.client.call('bootstrap') as Record<string, unknown>);
    } catch (error) { node('connect-models').hidden = true; status(failureText(error, (error as Error).message)); }
    finally { button.disabled = false; }
  });
  return {
    update(state) {
      node('connect-card').hidden = dismissed || state.model_connected === true;
      // A saved cloud session after a reload: its key was never stored, so ask for it again once.
      if (!prompted && state.model_connected !== true && state.ready === false && CLOUD.includes(String(state.provider))) {
        prompted = true; show('key'); node('connect-provider').value = String(state.provider);
        node('connect-custom').hidden = state.provider !== 'custom';
        status(state.provider === 'custom' ? 'This session used a custom server. Its address and key are never saved, so enter them again to continue.' : 'This session used an API key, and keys are never saved. Enter it again to continue.');
      }
    },
  };
}

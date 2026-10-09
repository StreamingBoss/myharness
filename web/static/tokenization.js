/* View-only code: inspection and provider decisions belong to the backend. */
(function (global) {
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function pieceText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); }
    catch { return bytes.map(byte => '\\x' + byte.toString(16).padStart(2, '0').toUpperCase()).join(''); }
  }
  class TokenViewer {
    constructor(root, fetchBackend, busy) {
      this.root = root; this.fetchBackend = fetchBackend; this.busy = busy;
      this.epoch = 0; this.cache = new Map(); this.sessionId = '';
      const quota = 'Inspection is a separate request and may use provider quota. Ollama inspection asks its renderer; an older server ignoring the debug flag may generate at most one token. No agent tools are run.';
      const controls = element('div', undefined, 'token-controls');
      const label = element('label', 'Saved model request ');
      this.select = element('select'); this.select.id = 'token-request'; this.select.title = label.title = 'Choose a model request saved in the active session. Selecting it shows cached evidence; use Inspect selected request to fetch new evidence.'; this.select.setAttribute('aria-label', 'Saved model request'); label.append(this.select);
      this.inspect = element('button', 'Inspect selected request'); this.inspect.id = 'token-inspect'; this.inspect.title = 'Ask the backend for tokenizer evidence for this saved request. This separate inspection may use provider quota; it runs no agent tools. Unsupported evidence is reported explicitly.';
      controls.append(label, this.inspect); root.append(controls);
      // Background help is collapsed so the result, and its pieces, start near the top of the small box.
      const intro = element('details'); intro.id = 'token-intro';
      intro.append(element('summary', 'What is this view?'),
        element('p', 'Tokenization splits text into model-specific pieces. Colours show boundaries, not meaning. Numeric IDs identify pieces in this model’s vocabulary; they are not portable between models.'),
        element('p', 'Inspect a saved request to see the best evidence its provider exposes. ' + quota));
      root.append(intro);
      this.summary = element('div'); this.summary.id = 'token-summary'; this.summary.setAttribute('aria-live', 'polite');
      this.groups = element('div'); this.groups.id = 'token-groups';
      this.details = element('pre'); this.details.id = 'token-details';
      this.about = element('div'); this.about.id = 'token-about';
      root.append(this.summary, this.groups, this.details, this.about);
      this.select.addEventListener('change', () => this.showSelected());
      this.inspect.addEventListener('click', () => this.run());
    }
    async refresh(sessionId) {
      const epoch = ++this.epoch, sameSession = this.sessionId === sessionId;
      this.sessionId = sessionId;
      if (!sameSession) {
        this.select.replaceChildren(); this.cache.clear(); this.clear(); this.inspect.disabled = true;
      }
      if (!sessionId) { this.summary.textContent = 'Send a message first; no saved request is available.'; return; }
      try {
        const response = await this.fetchBackend('/sessions/' + encodeURIComponent(sessionId));
        const data = await response.json();
        if (!response.ok) throw new Error(globalThis.MyHarnessErrors ? globalThis.MyHarnessErrors.presentFailure(data.failure, data.error) : data.error);
        if (epoch !== this.epoch) return;
        const previous = this.select.value, evidence = JSON.stringify(this.cache.get(previous));
        this.select.replaceChildren(); this.cache.clear();
        let ordinal = 0;
        (data.events || []).forEach((event, index) => {
          if (event.type === 'request' || (event.type === 'context' && event.action === 'compact_request')) {
            const request = event.type === 'request' ? (event.model_request || JSON.parse(event.parts.join(''))) : event.payload;
            const option = element('option', (++ordinal) + ' · ' + request.model + ' · ' + (event.provider || 'ollama') + (event.type === 'context' ? ' · compaction' : ''));
            option.value = String(index); this.select.append(option);
          } else if (event.type === 'tokenization') this.cache.set(String(event.request_index), event.inspection);
        });
        const options = [...this.select.options];
        this.select.value = options.some(option => option.value === previous) ? previous : (options.at(-1)?.value || '');
        // Updating the list must not redraw unchanged evidence or reset token details/scroll.
        if (!sameSession || this.select.value !== previous || JSON.stringify(this.cache.get(previous)) !== evidence) this.showSelected();
      } catch { if (epoch === this.epoch) this.summary.textContent = 'Could not load saved requests. Choose the active session and try again.'; }
    }
    clear() { this.groups.replaceChildren(); this.summary.replaceChildren(); this.about.replaceChildren(); this.details.textContent = 'Click a token to see its position, ID and bytes.'; this.details.hidden = true; }
    showSelected() {
      this.clear();
      const cached = this.cache.get(this.select.value);
      this.inspect.disabled = !this.select.options.length || !!cached;
      if (cached) this.render(cached);
      else this.summary.textContent = this.select.options.length ? 'Not inspected. Click “Inspect selected request”; no tokenizer call has been made for this view.' : 'Send a message first; no saved request is available.';
    }
    async run() {
      const epoch = this.epoch, sessionId = this.sessionId, index = this.select.value;
      this.clear(); this.summary.textContent = 'Inspecting saved request…'; this.inspect.disabled = true; this.select.disabled = true; this.busy(true);
      let finished = false, polling = false;
      const timer = setInterval(async () => {
        if (polling || finished || epoch !== this.epoch) return;
        polling = true;
        try {
          const response = await this.fetchBackend('/tokenize/progress');
          const progress = await response.json();
          if (!finished && epoch === this.epoch && response.ok && progress?.sessionId === sessionId && progress.eventIndex === Number(index)) this.summary.textContent = progress.message;
        } catch { /* Inspection result owns failure reporting; progress is advisory. */ }
        finally { polling = false; }
      }, 300);
      try {
        const response = await this.fetchBackend('/tokenize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, event_index: Number(index) }) });
        const data = await response.json();
        if (!response.ok) throw new Error(globalThis.MyHarnessErrors ? globalThis.MyHarnessErrors.presentFailure(data.failure, data.error) : data.error);
        if (epoch !== this.epoch) return;
        // Failed inspections can be retried; the backend does not persist them.
        if (data.fidelity !== 'unavailable') this.cache.set(index, data);
        this.render(data); this.inspect.disabled = this.cache.has(index);
      } catch { if (epoch === this.epoch) { this.summary.textContent = 'Inspection failed. Check the connection and retry. No token sequence is shown.'; this.inspect.disabled = false; } }
      finally { finished = true; clearInterval(timer); this.select.disabled = false; this.busy(false); }
    }
    render(data) {
      this.clear();
      const names = { 'provider-content': 'Provider tokenization of text', 'configured-tokenizer': 'Configured tokenizer · separate tokenization', 'count-only': 'Count only · token pieces unavailable', unavailable: 'Token sequence unavailable' };
      const hasPieces = !!data.groups?.length;
      this.summary.append(element('strong', names[data.fidelity]));
      // Without pieces the view would otherwise look empty: say so first and give the backend's reason.
      if (!hasPieces) {
        const empty = element('div', undefined, 'token-empty'); empty.id = 'token-empty';
        empty.append(element('strong', 'No token pieces to show for this request.'), element('p', globalThis.MyHarnessErrors ? globalThis.MyHarnessErrors.presentFailure(undefined, data.explanation) : data.explanation));
        empty.append(element('p', 'TOKENIZATION.md describes which providers and setups can show token pieces, for example a matching llama.cpp tokenizer for a local Ollama model.'));
        this.summary.append(empty);
      }
      this.about.append(element('p', 'Model: ' + data.model + ' · Provider: ' + data.provider + ' · Source: ' + data.source));
      if (hasPieces) this.about.append(element('p', globalThis.MyHarnessErrors ? globalThis.MyHarnessErrors.presentFailure(undefined, data.explanation) : data.explanation));
      this.about.append(element('p', 'Coverage: ' + data.coverage));
      const limits = element('ul'); (data.limitations || []).forEach(text => limits.append(element('li', text))); this.about.append(limits);
      this.details.hidden = !hasPieces;
      if (data.count !== undefined) this.summary.append(element('p', (data.fidelity === 'count-only' ? 'Inspection count: ' : 'Displayed tokens: ') + data.count));
      if (data.measuredCount !== undefined) this.summary.append(element('p', data.provider === 'demo'
        ? 'Scripted demo input estimate: ' + data.measuredCount + '. There is no LLM tokenizer or inference measurement.'
        : 'Input count reported during generation: ' + data.measuredCount + '. A matching count alone does not prove the same token sequence.'));
      for (const group of data.groups || []) {
        const section = element('section'); section.append(element('h3', group.label));
        const preview = element('details'); preview.append(element('summary', 'Combined token bytes as text'), element('pre', new TextDecoder().decode(new Uint8Array(group.tokens.flatMap(token => token.bytes))))); section.append(preview);
        const chips = element('div', undefined, 'token-chips');
        group.tokens.forEach((token, index) => {
          const text = pieceText(token.bytes), visible = text.replaceAll(' ', '·').replaceAll('\n', '↵').replaceAll('\t', '⇥');
          const chip = element('button', visible || '(empty piece)', 'token-chip token-colour-' + index % 2);
          chip.type = 'button'; chip.setAttribute('aria-label', 'Token ' + (index + 1) + ', ID ' + token.id); chip.title = 'Token ' + (index + 1) + ' · ID ' + token.id;
          chip.addEventListener('click', () => {
            this.details.textContent = group.label + '\nPosition: ' + (index + 1) + '\nToken ID: ' + token.id + '\nPiece: ' + JSON.stringify(text) + '\nBytes (hex): ' + token.bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ') + '\nBytes (decimal): ' + token.bytes.join(', ') + '\nA token can contain only part of a UTF-8 character. Such pieces show raw hex escapes; combined bytes restore the text.';
          }); chips.append(chip);
        });
        section.append(chips); this.groups.append(section);
      }
      if (hasPieces) this.groups.prepend(element('p', 'Visible whitespace: · = space, ↵ = newline, ⇥ = tab. These symbols are display aids. Token IDs and raw bytes retain the original content.'));
      if (data.renderedPrompt !== undefined) {
        const prompt = element('details'); prompt.append(element('summary', 'Ollama-rendered prompt text (separate inspection)'), element('pre', data.renderedPrompt)); this.groups.append(prompt);
      }
    }
  }
  global.TokenViewer = TokenViewer;
})(globalThis);

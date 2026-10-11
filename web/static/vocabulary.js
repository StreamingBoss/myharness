/* View-only code: the vocabulary, its decoding, search and paging belong to the backend. */
(function (global) {
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  const visible = text => text.replaceAll(' ', '·').replaceAll('\n', '↵').replaceAll('\t', '⇥');
  const KIND = { normal: 'ordinary piece', unknown: 'unknown-token marker', control: 'control token', 'user-defined': 'added token', unused: 'unused slot', byte: 'single byte' };
  class VocabularyViewer {
    constructor(root, fetchBackend) {
      this.root = root; this.fetchBackend = fetchBackend; this.query = { start: 0 }; this.epoch = 0;
      const intro = element('details'); intro.id = 'vocabulary-intro';
      intro.append(element('summary', 'What is the vocabulary?'),
        element('p', 'The vocabulary is the model\'s fixed list of tokens. Every prompt is cut into pieces from this list, and the model reads and writes nothing else. Each piece has an ID, its position in the list, and the model works with the IDs, not with letters. IDs are not random: in byte-level models the lowest IDs are single characters, then come ever longer pieces that were common in the training text (the tokenizer learned them in that order), and the special tokens sit at the very end. A leading space belongs to the piece, so "hello" and " hello" are different tokens.'));
      const controls = element('div', undefined, 'vocabulary-controls');
      this.search = element('input'); this.search.type = 'search'; this.search.id = 'vocabulary-search'; this.search.placeholder = 'Find a piece, e.g. " hello"';
      this.search.setAttribute('aria-label', 'Find pieces containing this text'); this.search.title = 'Show every token whose text contains this, in ID order. Spaces count: " hello" with a leading space finds the token for the word at the start of a word, "hello" also finds longer pieces that contain it.';
      this.exact = element('input'); this.exact.type = 'checkbox'; this.exact.id = 'vocabulary-exact';
      const exactLabel = element('label'); exactLabel.title = 'Show only a token whose whole text is exactly what you typed. A word that has no match here is split into several tokens.'; exactLabel.append(this.exact, ' whole piece only');
      this.find = element('button', 'Find'); this.find.id = 'vocabulary-find'; this.find.type = 'button'; this.find.title = 'Search the vocabulary for the text in the box. Nothing is sent to the model; the harness only reads its token list.';
      this.id = element('input'); this.id.type = 'number'; this.id.min = '0'; this.id.id = 'vocabulary-id'; this.id.placeholder = 'Token ID'; this.id.setAttribute('aria-label', 'Show the tokens around this ID'); this.id.title = 'Jump to this ID and show the tokens next to it.';
      this.go = element('button', 'Go to ID'); this.go.id = 'vocabulary-go'; this.go.type = 'button'; this.go.title = 'Show the tokens around the ID you typed, with that one highlighted.';
      this.previous = element('button', 'Previous'); this.previous.id = 'vocabulary-previous'; this.previous.type = 'button'; this.previous.title = 'Show the previous tokens in ID order.';
      this.next = element('button', 'Next'); this.next.id = 'vocabulary-next'; this.next.type = 'button'; this.next.title = 'Show the next tokens in ID order.';
      controls.append(this.search, exactLabel, this.find, this.id, this.go, this.previous, this.next);
      this.status = element('div'); this.status.id = 'vocabulary-status'; this.status.setAttribute('role', 'status');
      this.table = element('table'); this.table.id = 'vocabulary-table';
      this.table.append(element('caption', 'Tokens in ID order. · = space, ↵ = newline, ⇥ = tab; display aids only.'));
      const head = element('tr'); for (const name of ['ID', 'Piece', 'Bytes (hex)', 'What it is']) head.append(element('th', name));
      this.table.append(element('thead')); this.table.tHead.append(head);
      this.body = element('tbody'); this.table.append(this.body);
      root.append(intro, controls, this.status, this.table);
      this.find.addEventListener('click', () => this.load({ search: this.search.value, exact: this.exact.checked }));
      this.search.addEventListener('keydown', event => { if (event.key === 'Enter') this.find.click(); });
      this.go.addEventListener('click', () => { if (this.id.value !== '') this.load({ around: Number(this.id.value) }); });
      this.id.addEventListener('keydown', event => { if (event.key === 'Enter') this.go.click(); });
      this.previous.addEventListener('click', () => this.load({ start: Math.max(0, this.start - this.limit) }));
      this.next.addEventListener('click', () => this.load({ start: this.start + this.limit }));
    }
    async refresh() { await this.load(this.query); }
    async load(query) {
      const epoch = ++this.epoch; this.query = query;
      this.status.textContent = 'Loading the vocabulary…';
      let data;
      try {
        const response = await this.fetchBackend('/vocabulary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || 'The vocabulary could not be read.');
      } catch (error) { if (epoch === this.epoch) this.status.textContent = 'Could not read the vocabulary. ' + (error && error.message ? error.message : error); return; }
      if (epoch === this.epoch) this.render(data);
    }
    render(data) {
      this.loaded = true; this.body.replaceChildren();
      if (!data.available) { this.status.textContent = data.reason; this.previous.disabled = this.next.disabled = true; return; }
      this.start = data.start; this.limit = data.limit;
      const first = data.entries.length ? data.entries[0].id : 0, last = data.entries.length ? data.entries[data.entries.length - 1].id : 0;
      const counts = Object.entries(data.counts).filter(([, count]) => count > 0).map(([kind, count]) => count.toLocaleString('en') + ' ' + (KIND[kind] || kind) + (count === 1 ? '' : 's')).join(', ');
      const reserved = Object.entries(data.reserved).map(([name, id]) => name.toUpperCase() + ' = ' + id).join(', ');
      const lines = [data.model + ' · ' + data.size.toLocaleString('en') + ' tokens (' + counts + ')' + (reserved ? ' · ' + reserved : ''), data.tokenizer_note];
      lines.push(data.mode === 'search' ? (data.matches === 0 ? 'No token matches. If you typed a whole word, the model writes it as several tokens.' : (data.matches > data.entries.length ? 'Showing the first ' + data.entries.length + ' of ' + data.matches.toLocaleString('en') + ' matches. Type more to narrow it down.' : data.matches + ' match' + (data.matches === 1 ? '' : 'es') + '.'))
        : 'Showing IDs ' + first.toLocaleString('en') + ' to ' + last.toLocaleString('en') + (data.mode === 'around' ? ' (the one you asked for is highlighted).' : '.'));
      this.status.replaceChildren(...lines.map(text => element('p', text)));
      this.previous.disabled = data.mode === 'search' || data.start === 0;
      this.next.disabled = data.mode === 'search' || data.start + data.entries.length >= data.size;
      for (const entry of data.entries) {
        const row = element('tr'); if (entry.id === data.focus) row.className = 'vocabulary-focus';
        const piece = element('td', entry.piece === '' ? '(empty)' : visible(entry.piece), 'vocabulary-piece');
        const what = element('td', (KIND[entry.kind] || entry.kind) + (entry.partial ? ' (part of a character)' : '') + (entry.special && entry.special.label !== KIND[entry.kind] ? ': ' + entry.special.label : ''));
        if (entry.special) what.title = entry.special.label + ' (' + entry.special.models + ')\n' + entry.special.meaning;
        row.append(element('td', String(entry.id)), piece, element('td', entry.hex), what); this.body.append(row);
      }
    }
  }
  global.VocabularyViewer = VocabularyViewer;
})(globalThis);

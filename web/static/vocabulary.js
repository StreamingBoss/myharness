/* View-only code: the vocabulary, its decoding, search and paging belong to the backend. */
(function (global) {
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  const { t, tn } = MyHarnessI18n;
  const visible = text => text.replaceAll(' ', '·').replaceAll('\n', '↵').replaceAll('\t', '⇥');
  // English kind names, to recognise a special-token label (from the backend) that only repeats the kind.
  const KIND_EN = { normal: 'ordinary piece', unknown: 'unknown-token marker', control: 'control token', 'user-defined': 'added token', unused: 'unused slot', byte: 'single byte' };
  const KIND = { normal: t('ordinary piece'), unknown: t('unknown-token marker'), control: t('control token'), 'user-defined': t('added token'), unused: t('unused slot'), byte: t('single byte') };
  // Counted kinds, in the plural form the count needs.
  const KIND_COUNT = {
    normal: n => tn('{count} ordinary piece', '{count} ordinary pieces', n), unknown: n => tn('{count} unknown-token marker', '{count} unknown-token markers', n),
    control: n => tn('{count} control token', '{count} control tokens', n), 'user-defined': n => tn('{count} added token', '{count} added tokens', n),
    unused: n => tn('{count} unused slot', '{count} unused slots', n), byte: n => tn('{count} single byte', '{count} single bytes', n),
  };
  class VocabularyViewer {
    constructor(root, fetchBackend) {
      this.root = root; this.fetchBackend = fetchBackend; this.query = { start: 0 }; this.epoch = 0;
      const intro = element('details'); intro.id = 'vocabulary-intro';
      intro.append(element('summary', t('What is the vocabulary?')),
        element('p', t('The vocabulary is the model\'s fixed list of tokens. Every prompt is cut into pieces from this list, and the model reads and writes nothing else. Each piece has an ID, its position in the list, and the model works with the IDs, not with letters. IDs are not random: in byte-level models the lowest IDs are single characters, then come ever longer pieces that were common in the training text (the tokenizer learned them in that order), and the special tokens sit at the very end. A leading space belongs to the piece, so "hello" and " hello" are different tokens.')));
      const controls = element('div', undefined, 'vocabulary-controls');
      this.search = element('input'); this.search.type = 'search'; this.search.id = 'vocabulary-search'; this.search.placeholder = t('Find a piece, e.g. " hello"');
      this.search.setAttribute('aria-label', t('Find pieces containing this text')); this.search.title = t('Show every token whose text contains this, in ID order. Spaces count: " hello" with a leading space finds the token for the word at the start of a word, "hello" also finds longer pieces that contain it.');
      this.exact = element('input'); this.exact.type = 'checkbox'; this.exact.id = 'vocabulary-exact';
      const exactLabel = element('label'); exactLabel.title = t('Show only a token whose whole text is exactly what you typed. A word that has no match here is split into several tokens.'); exactLabel.append(this.exact, ' ' + t('whole piece only'));
      this.find = element('button', t('Find')); this.find.id = 'vocabulary-find'; this.find.type = 'button'; this.find.title = t('Search the vocabulary for the text in the box. Nothing is sent to the model; the harness only reads its token list.');
      this.id = element('input'); this.id.type = 'number'; this.id.min = '0'; this.id.id = 'vocabulary-id'; this.id.placeholder = t('Token ID'); this.id.setAttribute('aria-label', t('Show the tokens around this ID')); this.id.title = t('Jump to this ID and show the tokens next to it.');
      this.go = element('button', t('Go to ID')); this.go.id = 'vocabulary-go'; this.go.type = 'button'; this.go.title = t('Show the tokens around the ID you typed, with that one highlighted.');
      this.previous = element('button', t('Previous')); this.previous.id = 'vocabulary-previous'; this.previous.type = 'button'; this.previous.title = t('Show the previous tokens in ID order.');
      this.next = element('button', t('Next')); this.next.id = 'vocabulary-next'; this.next.type = 'button'; this.next.title = t('Show the next tokens in ID order.');
      controls.append(this.search, exactLabel, this.find, this.id, this.go, this.previous, this.next);
      this.status = element('div'); this.status.id = 'vocabulary-status'; this.status.setAttribute('role', 'status');
      this.table = element('table'); this.table.id = 'vocabulary-table';
      this.table.append(element('caption', t('Tokens in ID order. · = space, ↵ = newline, ⇥ = tab; display aids only.')));
      const head = element('tr'); for (const name of [t('ID'), t('Piece'), t('Bytes (hex)'), t('What it is')]) head.append(element('th', name));
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
      this.status.textContent = t('Loading the vocabulary…');
      let data;
      try {
        const response = await this.fetchBackend('/vocabulary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || t('The vocabulary could not be read.'));
      } catch (error) { if (epoch === this.epoch) this.status.textContent = t('Could not read the vocabulary.') + ' ' + (error && error.message ? error.message : error); return; }
      if (epoch === this.epoch) this.render(data);
    }
    render(data) {
      this.loaded = true; this.body.replaceChildren();
      if (!data.available) { this.status.textContent = data.reason; this.previous.disabled = this.next.disabled = true; return; }
      this.start = data.start; this.limit = data.limit;
      const first = data.entries.length ? data.entries[0].id : 0, last = data.entries.length ? data.entries[data.entries.length - 1].id : 0;
      const counts = Object.entries(data.counts).filter(([, count]) => count > 0).map(([kind, count]) => KIND_COUNT[kind] ? KIND_COUNT[kind](count) : MyHarnessI18n.number(count) + ' ' + kind).join(', ');
      const reserved = Object.entries(data.reserved).map(([name, id]) => name.toUpperCase() + ' = ' + id).join(', ');
      const lines = [data.model + ' · ' + t('{count} tokens ({kinds})', { count: data.size, kinds: counts }) + (reserved ? ' · ' + reserved : ''), data.tokenizer_note];
      lines.push(data.mode === 'search' ? (data.matches === 0 ? t('No token matches. If you typed a whole word, the model writes it as several tokens.') : (data.matches > data.entries.length ? t('Showing the first {shown} of {count} matches. Type more to narrow it down.', { shown: data.entries.length, count: data.matches }) : tn('{count} match.', '{count} matches.', data.matches)))
        : (data.mode === 'around' ? t('Showing IDs {first} to {last} (the one you asked for is highlighted).', { first, last }) : t('Showing IDs {first} to {last}.', { first, last })));
      this.status.replaceChildren(...lines.map(text => element('p', text)));
      this.previous.disabled = data.mode === 'search' || data.start === 0;
      this.next.disabled = data.mode === 'search' || data.start + data.entries.length >= data.size;
      for (const entry of data.entries) {
        const row = element('tr'); if (entry.id === data.focus) row.className = 'vocabulary-focus';
        const piece = element('td', entry.piece === '' ? t('(empty)') : visible(entry.piece), 'vocabulary-piece');
        const what = element('td', (KIND[entry.kind] || entry.kind) + (entry.partial ? ' ' + t('(part of a character)') : '') + (entry.special && entry.special.label !== KIND_EN[entry.kind] ? ': ' + entry.special.label : ''));
        if (entry.special) what.title = entry.special.label + ' (' + entry.special.models + ')\n' + entry.special.meaning;
        row.append(element('td', String(entry.id)), piece, element('td', entry.hex), what); this.body.append(row);
      }
    }
  }
  global.VocabularyViewer = VocabularyViewer;
})(globalThis);

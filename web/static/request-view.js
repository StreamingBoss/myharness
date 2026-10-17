/* View only: shows the model request that the harness built. Nothing here changes what is sent. */
(function () {
  const h = (tag, props = {}, ...kids) => {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') element.className = value; else if (key === 'text') element.textContent = value; else element.setAttribute(key, value);
    }
    element.append(...kids);
    return element;
  };
  const tokensOf = value => Math.ceil((typeof value === 'string' ? value : JSON.stringify(value) ?? '').length / 4);
  const fmt = number => number.toLocaleString('en');
  const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;
  const paint = line => escapeHtml(line).replace(TOKEN, (match, string, colon, literal, number) => {
    if (string) return colon ? '<span class="jk">' + string + '</span>' + colon : '<span class="js">' + string + '</span>';
    if (literal) return '<span class="jl">' + literal + '</span>';
    return '<span class="jn">' + number + '</span>';
  });
  // Each line is {text, kind}. Lines added during the current turn get a kind: 'sent' (the harness sends it: your message, tool results) is purple, 'model' (the model answered it) is blue.
  const jsonPre = lines => {
    const pre = h('pre', { class: 'json' });
    pre.innerHTML = lines.map(line => line.kind ? '<span class="' + (line.kind === 'model' ? 'j-model' : 'j-sent') + '">' + paint(line.text) + '</span>' : paint(line.text)).join('\n');
    return pre;
  };
  const prettyLines = (value, kind = '') => (JSON.stringify(value, null, 2) ?? 'null').split('\n').map(text => ({ text, kind }));
  const kindOf = message => message.role === 'assistant' ? 'model' : 'sent';

  const textOf = content => typeof content === 'string' ? content : JSON.stringify(content);
  const preview = message => {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length) return 'tool call ' + calls.map(call => call.function.name + '(' + JSON.stringify(call.function.arguments ?? {}).slice(1, -1) + ')').join(', ');
    const text = textOf(message.content ?? '').replace(/\s+/g, ' ').trim();
    const label = message.role === 'tool' && message.tool_name ? message.tool_name + ': ' : '';
    return label + (text.length > 90 ? text.slice(0, 90) + '…' : text);
  };

  const SECTION_HELP = {
    'base prompt': 'the System prompt chosen in Settings, sent as is',
    'agent': 'the persona of the agent chosen in Settings',
    'project instructions': 'the AGENTS.md of the project folder, kept for the session',
    'MCP server notes': 'usage notes published by the connected MCP servers',
    'skill list': 'the name and description of every skill; a skill’s full text is sent only after the model loads it',
  };

  const SECTION_KEY = { 'base prompt': 'base', 'agent': 'agent', 'project instructions': 'project', 'MCP server notes': 'mcp', 'skill list': 'skills' };

  class RequestView {
    constructor(root) {
      this.root = root; this.requests = []; this.selected = -1; this.toolTokens = new Map();
      this.mode = 'section';
      try { if (localStorage.getItem('requestViewMode') === 'raw') this.mode = 'raw'; } catch {}
      this.render();
    }
    reset() { this.requests = []; this.selected = -1; this.render(); }
    setToolTokens(map) { this.toolTokens = map; if (this.requests.length) this.render(); }
    addRequest(event) { this.requests.push({ event, response: null }); this.selected = this.requests.length - 1; this.render(); }
    addResponse(event) {
      const last = this.requests[this.requests.length - 1];
      if (last && !last.response) { last.response = event; this.render(); }
    }
    static harnessBody(event) {
      if (event.model_request) return event.model_request;
      try { return JSON.parse(Array.isArray(event.parts) ? event.parts.join('') : String(event.parts ?? '')); } catch { return null; }
    }
    // The body shown as "As sent": the provider's own wire body when it reports one, otherwise the harness request without its
    // internal routing label. Tests hold this to be identical to what is posted to the model (typescript/tests/request-view.test.ts).
    static sentBody(event) {
      if (event.wire_request) return event.wire_request;
      const body = RequestView.harnessBody(event);
      if (!body) return null;
      const { provider, ...sent } = body;
      return sent;
    }
    // Splits the messages into the system message, the memory the harness re-sends, and what was added this turn.
    static sections(body) {
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const system = messages.filter(message => message.role === 'system');
      const rest = messages.filter(message => message.role !== 'system');
      let start = rest.length - 1;
      while (start >= 0 && rest[start].role !== 'user') start--;
      if (start < 0) start = rest.length;
      return { system, memory: rest.slice(0, start), thisTurn: rest.slice(start), tools: Array.isArray(body?.tools) ? body.tools : [] };
    }
    setMode(mode) {
      this.mode = mode; try { localStorage.setItem('requestViewMode', mode); } catch {}
      this.render();
    }
    render() {
      this.root.replaceChildren();
      const controls = h('div', { class: 'request-controls' });
      const seg = h('span', { class: 'seg', role: 'group', 'aria-label': 'Request view' });
      for (const [mode, label, help] of [['section', 'By section', 'Read the request one part at a time. Each part opens to its exact text.'], ['raw', 'As sent', 'Read the whole request body exactly as it is sent, in one block.']]) {
        const button = h('button', { type: 'button', 'aria-pressed': String(this.mode === mode), title: help, text: label });
        button.addEventListener('click', () => this.setMode(mode));
        seg.append(button);
      }
      controls.append(seg);
      if (this.requests.length) {
        const select = h('select', { 'aria-label': 'Request', title: 'Choose which model request of this session to read. The newest is shown by default.' });
        this.requests.forEach((item, index) => {
          const last = [...(RequestView.harnessBody(item.event)?.messages ?? [])].reverse().find(message => message.role === 'user');
          select.add(new Option('Request ' + (index + 1) + ' of ' + this.requests.length + (last ? ' · ' + preview(last).slice(0, 40) : ''), String(index)));
        });
        select.value = String(this.selected);
        select.addEventListener('change', () => { this.selected = Number(select.value); this.render(); });
        controls.append(select);
      }
      this.root.append(controls);
      if (!this.requests.length) {
        this.root.append(h('p', { class: 'note', text: 'No request yet. Send a message and the exact request appears here. The model keeps nothing between requests, so every request sends everything again; this view shows that.' }));
        return;
      }
      const item = this.requests[this.selected], body = RequestView.harnessBody(item.event), sections = RequestView.sections(body);
      this.root.append(h('p', { class: 'note', text: 'Exactly what the model receives. The model keeps nothing between requests: with memory on, every request sends the system message, the tool schemas and all remembered messages again. A grey header means that part is empty and nothing from it is sent. With Ollama, the model’s thinking is sent back with its tool call while a tool loop runs, as Ollama’s documentation shows, and dropped when the turn ends. What was added during this turn is coloured: purple is what the harness sends (your message and tool results), blue is what the model answered (its tool calls and answers).' }));
      if (!body) { this.root.append(h('p', { class: 'note', text: 'This request could not be read.' })); return; }
      this.root.append(this.mode === 'raw' ? this.asSent(item, body, sections) : this.bySection(item, sections));
    }
    row(role, message, fresh) {
      const open = false;
      const details = h('details', open ? { open: '' } : {});
      details.append(h('summary', {}, h('span', { class: 'role' + (fresh ? ' role-' + kindOf(message) : ''), text: message.role }), h('span', { text: preview(message) }), h('span', { class: 'tok', text: '≈' + fmt(tokensOf(message)) + ' tokens' })));
      details.append(h('div', { class: 'inner' }, jsonPre(prettyLines(message, fresh ? kindOf(message) : ''))));
      return details;
    }
    // key picks the block's colour; an empty block is shown grey, so what is sent stands out from what is not.
    block(tag, key, empty, title, when, tokens, children, open = false) {
      const details = h('details', { class: 'part blk-' + key + (empty ? ' is-empty' : '') }); if (open) details.open = true;
      details.append(h('summary', {}, h('span', { class: 'tag', text: tag }), h('span', { text: title }), h('span', { class: 'when', text: when }), h('span', { class: 'tok', text: '≈' + fmt(tokens) + ' tokens' })));
      details.append(h('div', { class: 'inner' }, ...children));
      return details;
    }
    // The model's answer to this request. It is not part of the request; it is what comes back.
    responseBlock(item) {
      if (!item.response) return this.block('response', 'response', true, 'waiting for the model’s answer', 'comes back after this request, not part of it', 0, []);
      let parsed = null;
      try { parsed = JSON.parse(Array.isArray(item.response.parts) ? item.response.parts.join('') : String(item.response.parts)); } catch {}
      const message = parsed?.message;
      if (!message) return this.block('response', 'response', false, 'the model’s answer', 'comes back after this request, not part of it', 0,
        [h('pre', { class: 'plain', text: String(Array.isArray(item.response.parts) ? item.response.parts.join('') : item.response.parts ?? '') })], true);
      const asksTool = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      const stats = [parsed.prompt_eval_count !== undefined ? 'input ' + fmt(parsed.prompt_eval_count) + ' tokens' : '', parsed.eval_count !== undefined ? 'output ' + fmt(parsed.eval_count) + ' tokens' : ''].filter(Boolean).join(' · ');
      const children = [this.row('', { ...message, role: message.role ?? 'assistant' }, true)];
      if (stats) children.push(h('p', { class: 'note', text: 'Counted by the model: ' + stats + '.' }));
      return this.block('response', 'response', false, asksTool ? 'the model asked for a tool' : 'the model’s answer', 'comes back after this request, not part of it', parsed.eval_count ?? tokensOf(message), children, true);
    }
    // Explains the system message and splits it into the pieces the harness joined, using the sizes it reported.
    systemChildren(item, systemText) {
      const info = Array.isArray(item.event.system_sections) ? item.event.system_sections : [];
      const children = [h('p', { class: 'note', text: 'The harness puts this message before the conversation in every request. It holds instructions, not your messages. It is built fresh each time from the pieces below, in this order, skipping empty ones. It is not part of memory, so clearing memory does not remove it.' })];
      if (!systemText) { children.push(h('p', { class: 'note', text: 'No system message: no base prompt, agent, project instructions, MCP notes or skills are active.' })); return children; }
      let offset = 0, total = 0;
      for (const section of info) {
        const text = systemText.slice(offset, offset + section.length); offset += section.length + 2; total += section.length;
        const details = h('details', { class: 'sys sys-' + (SECTION_KEY[section.name] ?? 'other') });
        details.append(h('summary', {}, h('span', { class: 'role', text: section.name }), h('span', { text: SECTION_HELP[section.name] ?? '' }), h('span', { class: 'tok', text: '≈' + fmt(tokensOf(text)) + ' tokens' })));
        details.append(h('div', { class: 'inner' }, h('pre', { class: 'plain', text })));
        children.push(details);
      }
      if (!info.length || total + 2 * (info.length - 1) !== systemText.length) children.push(h('pre', { class: 'plain', text: systemText }));
      return children;
    }
    bySection(item, sections) {
      const wrap = h('div', { class: 'request-parts' });
      const systemText = sections.system.map(message => textOf(message.content)).join('\n\n');
      const systemTokens = tokensOf(systemText);
      wrap.append(this.block('system message', 'system', !systemText, systemText ? 'the harness’s instructions, built fresh for every request' : 'none', 'sent with every request', systemTokens, this.systemChildren(item, systemText)));
      const toolTokens = sections.tools.reduce((sum, tool) => sum + (this.toolTokens.get(tool.function?.name) ?? tokensOf(tool)), 0);
      wrap.append(this.block('tool schemas', 'tools', !sections.tools.length, sections.tools.length + (sections.tools.length === 1 ? ' tool' : ' tools'), 'sent with every request', toolTokens, sections.tools.length
        ? sections.tools.map(tool => { const d = h('details'); d.append(h('summary', {}, h('span', { class: 'role', text: tool.function?.name ?? 'tool' }), h('span', { text: (tool.function?.description ?? '').slice(0, 90) }), h('span', { class: 'tok', text: '≈' + fmt(this.toolTokens.get(tool.function?.name) ?? tokensOf(tool)) + ' tokens' }))); d.append(h('div', { class: 'inner' }, jsonPre(prettyLines(tool)))); return d; })
        : [h('p', { class: 'note', text: 'No tools are active, so the request has no tools field.' })]));
      const memoryTokens = sections.memory.reduce((sum, message) => sum + tokensOf(message), 0);
      wrap.append(this.block('memory', 'memory', !sections.memory.length, sections.memory.length + (sections.memory.length === 1 ? ' message' : ' messages') + ' kept from earlier turns', 'sent with every request', memoryTokens, sections.memory.length
        ? sections.memory.map(message => this.row('', message, false)) : [h('p', { class: 'note', text: 'Empty. With memory off, or at the start of a session, only your new message is sent.' })]));
      const turnTokens = sections.thisTurn.reduce((sum, message) => sum + tokensOf(message), 0);
      wrap.append(this.block('this turn', 'turn', !sections.thisTurn.length, sections.thisTurn.length + (sections.thisTurn.length === 1 ? ' message' : ' messages') + ' added this turn: yours' + (sections.thisTurn.length > 1 ? ', tool calls and their results' : ''), 'sent again by later requests, then kept in memory', turnTokens,
        sections.thisTurn.map((message, index) => this.row('', message, true)), true));
      wrap.append(this.responseBlock(item));
      const total = systemTokens + toolTokens + memoryTokens + turnTokens;
      const counted = item.response && item.response.tokens_in !== undefined ? ' The model counted ' + fmt(item.response.tokens_in) + ' input tokens for this request.' : '';
      wrap.append(h('p', { class: 'note', text: 'Total sent ≈' + fmt(total) + ' tokens (about four characters per token): ' + fmt(systemTokens) + ' system + ' + fmt(toolTokens) + ' tools + ' + fmt(memoryTokens) + ' memory + ' + fmt(turnTokens) + ' this turn.' + counted + ' The model’s answer comes back as the response and is not part of this request.' }));
      return wrap;
    }
    asSent(item, body, sections) {
      const wrap = h('div', { class: 'request-parts' });
      const native = item.event.wire_request;
      const sameShape = !native;
      const fresh = new Set(sections.thisTurn);
      const lines = [];
      if (sameShape) {
        const sent = RequestView.sentBody(item.event);
        const keys = Object.keys(sent);
        lines.push({ text: '{' });
        keys.forEach((key, index) => {
          const comma = index < keys.length - 1 ? ',' : '';
          const value = sent[key];
          if (key === 'messages' && Array.isArray(value)) {
            lines.push({ text: '  "messages": [' });
            value.forEach((message, i) => {
              const text = JSON.stringify(message, null, 2).split('\n').map(line => '    ' + line);
              text[text.length - 1] += i < value.length - 1 ? ',' : '';
              text.forEach(line => lines.push({ text: line, kind: fresh.has(message) ? kindOf(message) : '' }));
            });
            lines.push({ text: '  ]' + comma });
          } else {
            const text = (JSON.stringify(value, null, 2) ?? 'null').split('\n');
            text[0] = '  ' + JSON.stringify(key) + ': ' + text[0];
            for (let i = 1; i < text.length; i++) text[i] = '  ' + text[i];
            text[text.length - 1] += comma;
            text.forEach(line => lines.push({ text: line }));
          }
        });
        lines.push({ text: '}' });
      } else prettyLines(native).forEach(line => lines.push(line));
      const top = h('div', { class: 'request-toolbar' }, h('span', { class: 'note', text: sameShape ? 'The same content as is sent to the model, reformatted for reading (the transmitted JSON is compact). Nothing is summarised, reordered or hidden. The id and tool_call_id fields match a tool result to its call. Added this turn: purple is sent by the harness, blue is the model’s answer.' : 'The request as sent to ' + (item.event.provider ?? 'the provider') + ', in that provider’s own format, reformatted for reading. The colours are available in the By section view.' }));
      const copy = h('button', { type: 'button', text: 'Copy request', title: 'Copy the request body shown below to the clipboard.' });
      copy.addEventListener('click', async () => { const text = lines.map(line => line.text).join('\n'); try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy not available'; } setTimeout(() => { copy.textContent = 'Copy request'; }, 1500); });
      top.append(copy);
      wrap.append(top, jsonPre(lines));
      if (item.response) {
        wrap.append(h('p', { class: 'note', text: 'Response to this request (the model’s answer):' }));
        let responseLines;
        try { responseLines = prettyLines(JSON.parse(Array.isArray(item.response.parts) ? item.response.parts.join('') : String(item.response.parts)), 'model'); }
        catch { responseLines = [{ text: String(Array.isArray(item.response.parts) ? item.response.parts.join('') : item.response.parts ?? ''), kind: 'model' }]; }
        wrap.append(jsonPre(responseLines));
      }
      return wrap;
    }
  }
  globalThis.RequestView = RequestView;
})();

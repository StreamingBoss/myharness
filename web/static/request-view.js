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
  const { t, tn } = MyHarnessI18n;
  const tokensOf = value => Math.ceil((typeof value === 'string' ? value : JSON.stringify(value) ?? '').length / 4);
  const tokens = count => t('≈{count} tokens', { count });
  const escapeHtml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;
  const paint = line => escapeHtml(line).replace(TOKEN, (match, string, colon, literal, number) => {
    if (string) return colon ? '<span class="jk">' + string + '</span>' + colon : '<span class="js">' + string + '</span>';
    if (literal) return '<span class="jl">' + literal + '</span>';
    return '<span class="jn">' + number + '</span>';
  });
  // Each line is {text, kind}. 'sent' (purple) marks what this turn added to the request: the harness sends all of it, the model's
  // earlier tool calls included. 'model' (blue) marks the response, what comes back from the model.
  const jsonPre = lines => {
    const pre = h('pre', { class: 'json' });
    pre.innerHTML = lines.map(line => line.kind ? '<span class="' + (line.kind === 'model' ? 'j-model' : 'j-sent') + '">' + paint(line.text) + '</span>' : paint(line.text)).join('\n');
    return pre;
  };
  const prettyLines = (value, kind = '') => (JSON.stringify(value, null, 2) ?? 'null').split('\n').map(text => ({ text, kind }));

  const textOf = content => typeof content === 'string' ? content : JSON.stringify(content);
  // A one-line preview; the ellipsis says the full text is inside the row.
  const shorten = text => text.length > 90 ? text.slice(0, 90) + '…' : text;
  const preview = message => {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length) return t('tool call') + ' ' + calls.map(call => call.function.name + '(' + JSON.stringify(call.function.arguments ?? {}).slice(1, -1) + ')').join(', ');
    const text = textOf(message.content ?? '').replace(/\s+/g, ' ').trim();
    const label = message.role === 'tool' && message.tool_name ? message.tool_name + ': ' : '';
    return label + shorten(text);
  };

  // Section names come from the backend; only their display is translated.
  const SECTION_HELP = {
    'base prompt': t('the System prompt chosen in Settings, sent as is'),
    'agent': t('the persona of the agent chosen in Settings'),
    'project instructions': t('the AGENTS.md of the project folder, kept for the session'),
    'MCP server notes': t('usage notes published by the connected MCP servers'),
    'skill list': t('the name and description of every skill; a skill’s full text is sent only after the model loads it'),
  };
  const SECTION_NAME = { 'base prompt': t('base prompt'), 'agent': t('agent'), 'project instructions': t('project instructions'), 'MCP server notes': t('MCP server notes'), 'skill list': t('skill list') };

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
    // Pass the body already read for this event: an Ollama request is parsed from text, and re-parsing it would give new
    // message objects that no longer match the sections, so this turn's messages would lose their colour.
    static sentBody(event, body = RequestView.harnessBody(event)) {
      if (event.wire_request) return event.wire_request;
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
      const scrolled = this.body ? this.body.scrollTop : 0;
      this.root.replaceChildren();
      // The header (view switch, request picker, notes, Copy request) stays in place; only the body below it scrolls.
      this.head = h('div', { class: 'request-head' }); this.body = h('div', { class: 'request-body' });
      this.root.append(this.head, this.body);
      const controls = h('div', { class: 'request-controls' });
      const seg = h('span', { class: 'seg', role: 'group', 'aria-label': t('Request view') });
      for (const [mode, label, help] of [['section', t('By section'), t('Read the request one part at a time. Each part opens to its exact text.')], ['raw', t('As sent'), t('Read the whole request body exactly as it is sent, in one block.')]]) {
        const button = h('button', { type: 'button', 'aria-pressed': String(this.mode === mode), title: help, text: label });
        button.addEventListener('click', () => this.setMode(mode));
        seg.append(button);
      }
      controls.append(seg);
      if (this.requests.length) {
        const select = h('select', { 'aria-label': t('Request'), title: t('Choose which model request of this session to read. The newest is shown by default.') });
        this.requests.forEach((item, index) => {
          const last = [...(RequestView.harnessBody(item.event)?.messages ?? [])].reverse().find(message => message.role === 'user');
          select.add(new Option(t('Request {number} of {total}', { number: index + 1, total: this.requests.length }) + (last ? ' · ' + preview(last).slice(0, 40) : ''), String(index)));
        });
        select.value = String(this.selected);
        select.addEventListener('change', () => { this.selected = Number(select.value); this.render(); });
        controls.append(select);
      }
      this.head.append(controls);
      if (!this.requests.length) {
        this.head.append(h('p', { class: 'note', text: t('No request yet. Send a message and the exact request appears here. The model keeps nothing between requests, so every request sends everything again; this view shows that.') }));
        return;
      }
      const item = this.requests[this.selected], body = RequestView.harnessBody(item.event), sections = RequestView.sections(body);
      this.head.append(h('p', { class: 'note', text: t('Exactly what the model receives. The model keeps nothing between requests: with memory on, every request sends the system message, the tool schemas and all remembered messages again. A grey header means that part is empty and nothing from it is sent. With Ollama, the model’s thinking is sent back with its tool call while a tool loop runs, as Ollama’s documentation shows, and dropped when the turn ends. What this turn added to the request is purple: the harness sends all of it (your message, the model’s tool calls sent back to it, and the tool results). The response, what comes back from the model, is blue.') }));
      if (!body) { this.head.append(h('p', { class: 'note', text: t('This request could not be read.') })); return; }
      this.body.append(this.mode === 'raw' ? this.asSent(item, body, sections) : this.bySection(item, sections));
      this.body.scrollTop = scrolled;
    }
    // kind: '' (no colour), 'sent' (added to the request this turn) or 'model' (the response).
    row(role, message, kind) {
      const open = false;
      const details = h('details', open ? { open: '' } : {});
      details.append(h('summary', {}, h('span', { class: 'role' + (kind ? ' role-' + kind : ''), text: message.role }), h('span', { text: preview(message) }), h('span', { class: 'tok', text: tokens(tokensOf(message)) })));
      details.append(h('div', { class: 'inner' }, jsonPre(prettyLines(message, kind))));
      return details;
    }
    // key picks the block's colour; an empty block is shown grey, so what is sent stands out from what is not.
    block(tag, key, empty, title, when, count, children, open = false) {
      const details = h('details', { class: 'part blk-' + key + (empty ? ' is-empty' : '') }); if (open) details.open = true;
      details.append(h('summary', {}, h('span', { class: 'tag', text: tag }), h('span', { text: title }), h('span', { class: 'when', text: when }), h('span', { class: 'tok', text: tokens(count) })));
      details.append(h('div', { class: 'inner' }, ...children));
      return details;
    }
    // The model's answer to this request. It is not part of the request; it is what comes back.
    responseBlock(item) {
      const after = t('comes back after this request, not part of it');
      if (!item.response) return this.block(t('response'), 'response', true, t('waiting for the model’s answer'), after, 0, []);
      let parsed = null;
      try { parsed = JSON.parse(Array.isArray(item.response.parts) ? item.response.parts.join('') : String(item.response.parts)); } catch {}
      const message = parsed?.message;
      if (!message) return this.block(t('response'), 'response', false, t('the model’s answer'), after, 0,
        [h('pre', { class: 'plain', text: String(Array.isArray(item.response.parts) ? item.response.parts.join('') : item.response.parts ?? '') })], true);
      const asksTool = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      const stats = [parsed.prompt_eval_count !== undefined ? t('input {count} tokens', { count: parsed.prompt_eval_count }) : '', parsed.eval_count !== undefined ? t('output {count} tokens', { count: parsed.eval_count }) : ''].filter(Boolean).join(' · ');
      const children = [this.row('', { ...message, role: message.role ?? 'assistant' }, 'model')];
      if (stats) children.push(h('p', { class: 'note', text: t('Counted by the model: {stats}.', { stats }) }));
      return this.block(t('response'), 'response', false, asksTool ? t('the model asked for a tool') : t('the model’s answer'), after, parsed.eval_count ?? tokensOf(message), children, true);
    }
    // Explains the system message and splits it into the pieces the harness joined, using the sizes it reported.
    systemChildren(item, systemText) {
      const info = Array.isArray(item.event.system_sections) ? item.event.system_sections : [];
      const children = [h('p', { class: 'note', text: t('The harness puts this message before the conversation in every request. It holds instructions, not your messages. It is built fresh each time from the pieces below, in this order, skipping empty ones. It is not part of memory, so clearing memory does not remove it.') })];
      if (!systemText) { children.push(h('p', { class: 'note', text: t('No system message: no base prompt, agent, project instructions, MCP notes or skills are active.') })); return children; }
      let offset = 0, total = 0;
      for (const section of info) {
        const text = systemText.slice(offset, offset + section.length); offset += section.length + 2; total += section.length;
        const details = h('details', { class: 'sys sys-' + (SECTION_KEY[section.name] ?? 'other') });
        details.append(h('summary', {}, h('span', { class: 'role', text: SECTION_NAME[section.name] ?? section.name }), h('span', { text: SECTION_HELP[section.name] ?? '' }), h('span', { class: 'tok', text: tokens(tokensOf(text)) })));
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
      const always = t('sent with every request');
      wrap.append(this.block(t('system message'), 'system', !systemText, systemText ? t('the harness’s instructions, built fresh for every request') : t('none'), always, systemTokens, this.systemChildren(item, systemText)));
      const toolTokens = sections.tools.reduce((sum, tool) => sum + (this.toolTokens.get(tool.function?.name) ?? tokensOf(tool)), 0);
      wrap.append(this.block(t('tool schemas'), 'tools', !sections.tools.length, tn('{count} tool', '{count} tools', sections.tools.length), always, toolTokens, sections.tools.length
        ? sections.tools.map(tool => { const d = h('details'); d.append(h('summary', {}, h('span', { class: 'role', text: tool.function?.name ?? 'tool' }), h('span', { text: shorten(tool.function?.description ?? '') }), h('span', { class: 'tok', text: tokens(this.toolTokens.get(tool.function?.name) ?? tokensOf(tool)) }))); d.append(h('div', { class: 'inner' }, jsonPre(prettyLines(tool)))); return d; })
        : [h('p', { class: 'note', text: t('No tools are active, so the request has no tools field.') })]));
      const memoryTokens = sections.memory.reduce((sum, message) => sum + tokensOf(message), 0);
      wrap.append(this.block(t('memory'), 'memory', !sections.memory.length, tn('{count} message kept from earlier turns', '{count} messages kept from earlier turns', sections.memory.length), always, memoryTokens, sections.memory.length
        ? sections.memory.map(message => this.row('', message, '')) : [h('p', { class: 'note', text: t('Empty. With memory off, or at the start of a session, only your new message is sent.') })]));
      const turnTokens = sections.thisTurn.reduce((sum, message) => sum + tokensOf(message), 0);
      wrap.append(this.block(t('this turn'), 'turn', !sections.thisTurn.length, sections.thisTurn.length > 1 ? t('{count} messages added this turn: yours, tool calls and their results', { count: sections.thisTurn.length }) : tn('{count} message added this turn: yours', '{count} messages added this turn: yours', sections.thisTurn.length), t('sent again by later requests, then kept in memory'), turnTokens,
        sections.thisTurn.map(message => this.row('', message, 'sent')), true));
      wrap.append(this.responseBlock(item));
      const total = systemTokens + toolTokens + memoryTokens + turnTokens;
      const counted = item.response && item.response.tokens_in !== undefined ? ' ' + t('The model counted {count} input tokens for this request.', { count: item.response.tokens_in }) : '';
      wrap.append(h('p', { class: 'note', text: t('Total sent ≈{total} tokens (about four characters per token): {system} system + {tools} tools + {memory} memory + {turn} this turn.', { total, system: systemTokens, tools: toolTokens, memory: memoryTokens, turn: turnTokens }) + counted + ' ' + t('The model’s answer comes back as the response and is not part of this request.') }));
      return wrap;
    }
    asSent(item, body, sections) {
      const wrap = h('div', { class: 'request-parts' });
      const native = item.event.wire_request;
      const sameShape = !native;
      const fresh = new Set(sections.thisTurn);
      const lines = [];
      if (sameShape) {
        const sent = RequestView.sentBody(item.event, body);
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
              text.forEach(line => lines.push({ text: line, kind: fresh.has(message) ? 'sent' : '' }));
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
      const top = h('div', { class: 'request-toolbar' }, h('span', { class: 'note', text: sameShape ? t('The same content as is sent to the model, reformatted for reading (the transmitted JSON is compact). Nothing is summarised, reordered or hidden. The id and tool_call_id fields match a tool result to its call. Added this turn is purple: the harness sends it. The response below, what comes back from the model, is blue.') : t('The request as sent to {provider}, in that provider’s own format, reformatted for reading. The colours are available in the By section view.', { provider: item.event.provider ?? t('the provider') }) }));
      const copy = h('button', { type: 'button', text: t('Copy request'), title: t('Copy the request body shown below to the clipboard.') });
      copy.addEventListener('click', async () => { const text = lines.map(line => line.text).join('\n'); try { await navigator.clipboard.writeText(text); copy.textContent = t('Copied'); } catch { copy.textContent = t('Copy not available'); } setTimeout(() => { copy.textContent = t('Copy request'); }, 1500); });
      top.append(copy);
      this.head.append(top);
      wrap.append(jsonPre(lines));
      if (item.response) {
        wrap.append(h('p', { class: 'note', text: t('Response to this request (the model’s answer):') }));
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

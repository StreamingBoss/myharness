/* View/controller only: starting, continuing and stopping work belong to the backend. */
class OrchestrationPanel {
  constructor(parent, request, turn) {
    this.request = request; this.turn = turn; this.cursors = new Map(); this.pending = false; this.sessionId = '';
    this.root = document.createElement('details'); this.root.id = 'orchestration';
    this.root.style.cssText = 'padding:10px;border-bottom:1px solid #555;font:13px system-ui;max-height:55vh;overflow:auto';
    // Static markup; all model, session and workspace values are inserted with textContent.
    this.root.innerHTML = `<summary>Autonomous goals and subagents</summary>
      <p>The backend continues a goal until the agent reports evidence, a blocker, or a limit is reached. Deadlines include model calls, tools, approvals and waits.</p>
      <label><input id="allow-subagents" type="checkbox"> Allow subagents globally</label> <span id="subagent-policy"></span>
      <p>Children use the master's model, including cloud models, and read-only tools by default. Cloud children consume API requests from the same goal allowance.</p>
      <details><summary>Explicit child grants</summary><label>Additional tool names, comma separated <input id="child-tool-grants"></label>
      <label>Authorized provider/model routes (JSON) <textarea id="child-route-grants" rows="2" placeholder='[{"provider":"openai","model":"your-model-id"}]'></textarea></label>
      <button id="save-child-grants" type="button">Save global grants</button></details>
      <form id="goal-form"><label>Objective <input id="goal-objective" required></label> <label>Completion criteria <input id="goal-criteria"></label>
      <label>Master timeout (seconds) <input id="master-timeout" type="number" min="1" value="1800" required></label>
      <label>Continuation rounds <input id="goal-rounds" type="number" min="1" value="10" required></label>
      <label>Shared model requests <input id="goal-requests" type="number" min="1" value="200" required></label>
      <button id="start-goal" type="submit">Start goal</button></form>
      <div><button id="pause-goal" type="button">Pause goal</button> <button id="resume-goal" type="button">Resume goal</button> <button id="cancel-run" type="button">Stop master and children</button></div>
      <pre id="goal-status" role="status"></pre>
      <form id="child-form"><label>Child task <input id="child-task" required></label>
      <label>Child timeout (seconds) <input id="child-timeout" type="number" min="1" value="300" required></label>
      <label>Provider (optional authorized route) <input id="child-provider"></label> <label>Model <input id="child-model"></label>
      <button id="spawn-child" type="submit">Start child</button></form>
      <div id="child-list"></div><p id="orchestration-error" role="alert"></p>
      <details><summary>Run events: messages, tools, approvals and settlements</summary><div id="run-approvals"></div><pre id="run-events" style="white-space:pre-wrap;max-height:200px;overflow:auto"></pre></details>`;
    parent.prepend(this.root);
    const on = (id, event, work) => this.el(id).addEventListener(event, e => { e.preventDefault(); this.perform(work); });
    on('allow-subagents', 'change', () => this.saveSettings()); on('save-child-grants', 'click', () => this.saveSettings());
    on('goal-form', 'submit', () => this.call('/goal', 'POST', { objective: this.el('goal-objective').value, criteria: this.el('goal-criteria').value,
      timeoutMs: Number(this.el('master-timeout').value) * 1000, maxRounds: Number(this.el('goal-rounds').value), maxRequests: Number(this.el('goal-requests').value), turn: { ...this.turn(), message: this.el('goal-objective').value } }));
    on('pause-goal', 'click', () => this.call('/goal', 'PATCH', { revision: this.goal.revision, action: 'pause' }));
    on('resume-goal', 'click', () => this.call(`/goal/${this.goal.id}/resume`, 'POST', { revision: this.goal.revision, timeoutMs: Number(this.el('master-timeout').value) * 1000 }));
    on('cancel-run', 'click', () => this.call('/runs/cancel', 'POST', {}));
    on('child-form', 'submit', () => this.call('/agents', 'POST', { task: this.el('child-task').value, timeoutMs: Number(this.el('child-timeout').value) * 1000,
      ...(this.el('child-provider').value ? { provider: this.el('child-provider').value } : {}), ...(this.el('child-model').value ? { model: this.el('child-model').value } : {}) }));
    this.timer = setInterval(() => this.refresh(), 700);
    window.addEventListener('pagehide', () => clearInterval(this.timer), { once: true });
  }
  el(id) { return this.root.querySelector('#' + id); }
  async call(path, method = 'GET', value) {
    const response = await this.request(path, { method, ...(value === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Backend request failed'); return result;
  }
  async perform(work) { try { this.el('orchestration-error').textContent = ''; await work(); await this.refresh(); } catch (error) { this.el('orchestration-error').textContent = error.message; await this.refresh(); } }
  async saveSettings() { const result = await this.call('/settings', 'PATCH', { allowSubagents: this.el('allow-subagents').checked,
    childTools: this.el('child-tool-grants').value.split(',').map(s => s.trim()).filter(Boolean), childRoutes: JSON.parse(this.el('child-route-grants').value || '[]') }); this.settings(result); }
  settings(value) {
    this.allowed = value.allowSubagents; this.el('allow-subagents').checked = value.allowSubagents; this.el('allow-subagents').disabled = value.locked;
    this.el('save-child-grants').disabled = value.locked; this.el('subagent-policy').textContent = value.locked ? 'Locked by host configuration' : 'Applies to every session; disabling stops active children';
    this.el('spawn-child').disabled = !this.allowed;
    if (document.activeElement !== this.el('child-tool-grants')) this.el('child-tool-grants').value = value.childTools.join(', ');
    if (document.activeElement !== this.el('child-route-grants')) this.el('child-route-grants').value = JSON.stringify(value.childRoutes);
  }
  initialize(data) {
    if (this.sessionId !== data.session.id) { this.sessionId = data.session.id; this.cursors.clear(); this.el('run-events').textContent = ''; this.el('run-approvals').replaceChildren(); }
    this.settings(data.harness_settings); this.refresh();
  }
  async refresh() {
    if (this.pending || !this.sessionId) return; this.pending = true;
    try {
      const [state, settings] = await Promise.all([this.call('/runs'), this.call('/settings')]); this.settings(settings); this.goal = state.goal;
      const live = state.run && ['running', 'stopping'].includes(state.run.status);
      this.el('start-goal').disabled = live || Boolean(state.goal && state.goal.phase !== 'complete');
      this.el('pause-goal').disabled = !live; this.el('resume-goal').disabled = live || !state.goal || state.goal.phase === 'complete';
      this.el('goal-status').textContent = state.goal ? `${state.goal.phase}: ${state.goal.objective}\n${state.goal.criteria}\nRounds: ${state.goal.rounds}/${state.goal.max_rounds}; shared requests: ${state.goal.model_requests}/${state.goal.max_requests}\n${state.run ? `Run: ${state.run.status}; deadline ${state.run.deadline_at}\n` : ''}${state.goal.evidence || state.goal.blocker || ''}` : 'No autonomous goal. Ordinary chat still runs one turn at a time.';
      this.children(state.children);
      const runs = state.run ? [state.run] : state.children.map(child => child.run).filter(Boolean);
      for (const run of runs) {
        const result = await this.call(`/runs/${run.id}/events?after=${this.cursors.get(run.id) ?? -1}`);
        for (const event of result.events) { this.cursors.set(run.id, event.sequence); this.event(event); }
      }
    } catch (error) { this.el('orchestration-error').textContent = error.message; }
    finally { this.pending = false; }
  }
  children(children) {
    const list = this.el('child-list'); const opened = new Set([...list.querySelectorAll('details[open]')].map(card => card.dataset.agentId)); list.replaceChildren();
    for (const child of children) {
      const card = document.createElement('details'); card.className = 'child-agent'; card.dataset.agentId = child.id; card.open = opened.has(child.id); const title = document.createElement('summary');
      title.textContent = `${child.task} — ${child.status}, attempt ${child.attempt} (${child.provider}/${child.model})`; card.append(title);
      const text = document.createElement('pre'); text.style.whiteSpace = 'pre-wrap'; text.textContent = `Deadline: ${child.run?.deadline_at || 'settled'}\n${child.result || 'No output yet'}\n\nAttempt history:\n${(child.attempts || []).map(run => `${run.status}: ${run.result}`).join('\n')}`; card.append(text);
      for (const [label, operation, disabled] of [['Query result', 'result', false], ['Restart', 'restart', !this.allowed || ['running', 'stopping'].includes(child.status)], ['Interrupt', 'interrupt', !['running', 'stopping'].includes(child.status)]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = disabled;
        button.onclick = () => this.perform(async () => { const result = await this.call(`/agents/${child.id}/${operation}`, operation === 'result' ? 'GET' : 'POST', operation === 'restart' ? { timeoutMs: Number(this.el('child-timeout').value) * 1000 } : operation === 'interrupt' ? {} : undefined); if (operation === 'result') text.textContent = JSON.stringify(result, null, 2); }); card.append(button);
      }
      list.append(card);
    }
  }
  event(frame) {
    const child = frame.type === 'agent_event' ? frame.child_id : null, event = child ? frame.event : frame;
    const prefix = child ? `Child ${child}` : `Agent ${frame.agent_id}`;
    if (event.type === 'approval') {
      const card = document.createElement('div'); card.dataset.approvalId = event.id; const title = document.createElement('pre'); title.textContent = `${prefix}: ${event.title}\n${event.detail}`; card.append(title);
      for (const [label, approved] of [['Approve', true], ['Deny', false]]) { const button = document.createElement('button'); button.textContent = label; button.onclick = () => this.perform(async () => { await this.call('/approve', 'POST', { id: event.id, approved }); card.remove(); }); card.append(button); }
      this.el('run-approvals').append(card);
    }
    if (['change', 'action', 'command', 'mcp_result'].includes(event.type)) this.el('run-approvals').querySelector(`[data-approval-id="${event.id}"]`)?.remove();
    if (!['chunk', 'thinking_chunk'].includes(event.type)) {
      this.el('run-events').textContent += `${prefix} [${event.source || 'backend'}] ${event.type}: ${JSON.stringify(event)}\n`;
    }
  }
}

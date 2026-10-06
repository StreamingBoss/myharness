/* View/controller only: the master chooses orchestration settings; the backend owns execution. */
class OrchestrationPanel {
  constructor(parent, request) {
    this.request = request; this.cursors = new Map(); this.pending = false; this.sessionId = '';
    this.root = document.createElement('section'); this.root.id = 'orchestration'; this.root.hidden = true;
    this.root.style.cssText = 'padding:10px;border-bottom:1px solid #555;font:13px system-ui;max-height:55vh;overflow:auto';
    this.root.innerHTML = `<h3>Goals and subagents</h3>
      <p>The master chooses tasks, models and limits within host permissions. These values are shown for inspection.</p>
      <button id="close-orchestration" type="button" title="Hide the inspector. Running work continues.">Close inspector</button>
      <button id="cancel-run" type="button" title="Cancel the master and its children, including pending approvals. Partial results remain.">Stop master and children</button>
      <pre id="goal-status" role="status"></pre>
      <details><summary>Host permissions and limits</summary><pre id="orchestration-settings"></pre></details>
      <div id="child-list"></div>
      <details id="run-details"><summary>Run events and approvals</summary><div id="run-approvals"></div><pre id="run-events" style="white-space:pre-wrap;max-height:200px;overflow:auto"></pre></details>`;
    const header = parent.querySelector('.pane-header'); header.after(this.root);
    this.toggle = document.createElement('button'); this.toggle.id = 'under-the-hood'; this.toggle.type = 'button';
    this.toggle.title = 'Inspect goals, running subagents, their results and chosen settings. Opening or closing does not change execution.';
    this.toggle.setAttribute('aria-controls', 'orchestration'); this.toggle.setAttribute('aria-expanded', 'false'); this.toggle.textContent = 'Under the hood';
    this.attention = document.createElement('button'); this.attention.id = 'orchestration-attention'; this.attention.hidden = true;
    this.attention.title = 'Open pending master or subagent approvals. Unanswered approvals never authorize effects.';
    this.stop = document.createElement('button'); this.stop.id = 'stop-orchestration'; this.stop.textContent = 'Stop'; this.stop.hidden = true;
    this.stop.title = 'Cancel the active master run and all children, including pending approvals. Results remain inspectable.';
    this.stop.onclick = () => this.perform(() => this.call('/runs/cancel', 'POST', {}));
    this.error = document.createElement('span'); this.error.id = 'orchestration-error'; this.error.setAttribute('role', 'alert');
    header.append(this.toggle, this.attention, this.stop, this.error);
    this.toggle.onclick = () => this.show(this.root.hidden);
    this.attention.onclick = () => { this.show(true); this.el('run-details').open = true; this.el('run-approvals').scrollIntoView({ block: 'nearest' }); };
    this.el('close-orchestration').onclick = () => this.show(false);
    this.el('cancel-run').onclick = () => this.perform(() => this.call('/runs/cancel', 'POST', {}));
    this.timer = setInterval(() => this.refresh(), 700);
    window.addEventListener('pagehide', () => clearInterval(this.timer), { once: true });
  }
  show(open) { this.root.hidden = !open; this.toggle.setAttribute('aria-expanded', String(open)); if (!open) this.toggle.focus(); }
  el(id) { return this.root.querySelector('#' + id); }
  async call(path, method = 'GET', value) {
    const response = await this.request(path, { method, ...(value === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Backend request failed'); return result;
  }
  async perform(work) { try { this.error.textContent = ''; await work(); await this.refresh(); } catch (error) { this.error.textContent = error.message; } }
  initialize(data) {
    if (this.sessionId !== data.session.id) {
      this.sessionId = data.session.id; this.cursors.clear(); this.el('run-events').textContent = ''; this.el('run-approvals').replaceChildren(); this.el('child-list').replaceChildren(); this.show(false);
    }
    this.el('orchestration-settings').textContent = JSON.stringify(data.orchestration || data.harness_settings, null, 2); this.refresh();
  }
  async refresh() {
    if (this.pending || !this.sessionId) return; this.pending = true;
    const sessionId = this.sessionId;
    try {
      const state = await this.call('/runs');
      if (sessionId !== this.sessionId) return;
      const live = state.run && ['running', 'stopping'].includes(state.run.status);
      const active = state.children.filter(child => ['running', 'stopping'].includes(child.status)).length;
      this.toggle.textContent = 'Under the hood' + (active ? ` · ${active} running` : '');
      this.stop.hidden = !live && !active;
      this.el('cancel-run').disabled = !live && !active;
      this.el('goal-status').textContent = state.goal ? `${state.goal.phase}: ${state.goal.objective}\n${state.goal.criteria}\nRounds: ${state.goal.rounds}/${state.goal.max_rounds}; shared requests: ${state.goal.model_requests}/${state.goal.max_requests}\nTimeout: ${state.goal.timeout_ms} ms\n${state.run ? `Run: ${state.run.status}; deadline ${state.run.deadline_at}\n` : ''}${state.goal.evidence || state.goal.blocker || ''}` : 'No autonomous goal. The master can configure one when the task needs continuation.';
      const failed = [state.run, ...state.children.map(child => child.run)].find(run => run?.status === 'error');
      if (failed) this.error.textContent = failed.reason || 'Agent execution failed. Open Under the hood for details.';
      this.children(state.children);
      const runs = [...(state.run ? [state.run] : []), ...state.children.map(child => child.run).filter(Boolean)];
      for (const run of runs) {
        const result = await this.call(`/runs/${run.id}/events?after=${this.cursors.get(run.id) ?? -1}`);
        if (sessionId !== this.sessionId) return;
        for (const event of result.events) {
          if (Number(event.sequence) > (this.cursors.get(run.id) ?? -1)) { this.cursors.set(run.id, event.sequence); this.event(event); }
        }
      }
      this.updateAttention();
    } catch (error) { this.error.textContent = error.message; }
    finally { this.pending = false; }
  }
  updateAttention() {
    const count = this.el('run-approvals').children.length;
    this.attention.hidden = !count; this.attention.textContent = `Approval needed (${count})`;
  }
  children(children) {
    const list = this.el('child-list');
    for (const child of children) {
      let card = [...list.children].find(item => item.dataset.agentId === child.id);
      if (!card) {
        card = document.createElement('details'); card.className = 'child-agent'; card.dataset.agentId = child.id;
        card.append(document.createElement('summary'), document.createElement('pre'));
        const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = 'Stop child';
        stop.title = 'Cancel this child attempt and pending approvals. Preserve partial results; other agents can continue.';
        stop.onclick = () => this.perform(() => this.call(`/agents/${child.id}/interrupt`, 'POST', {})); card.append(stop); list.append(card);
      }
      card.querySelector('summary').textContent = `${child.task} — ${child.status}, attempt ${child.attempt} (${child.provider}/${child.model})`;
      const run = child.run;
      const elapsed = run ? Math.max(0, Math.floor((Date.parse(run.ended_at || new Date().toISOString()) - Date.parse(run.started_at)) / 1000)) : 0;
      const text = card.querySelector('pre'); text.style.whiteSpace = 'pre-wrap';
      text.textContent = `Task: ${child.task}\nModel: ${child.provider}/${child.model}\nStatus: ${child.status}\nElapsed: ${elapsed} seconds\nDeadline: ${run?.deadline_at || 'settled'}\nTimeout: ${child.timeout_ms} ms\nTools: ${(child.tools || []).join(', ')}\n\n${child.result || 'No output yet'}\n\nAttempt history:\n${(child.attempts || []).map(attempt => `${attempt.status}: ${attempt.result}`).join('\n')}`;
      card.querySelector('button').disabled = !['running', 'stopping'].includes(child.status);
    }
    const ids = new Set(children.map(child => child.id)); for (const card of [...list.children]) if (!ids.has(card.dataset.agentId)) card.remove();
  }
  event(frame) {
    const child = frame.type === 'agent_event' ? frame.child_id : null, event = child ? frame.event : frame;
    if (child) { if (Number(event.sequence) <= (this.cursors.get(event.run_id) ?? -1)) return; this.cursors.set(event.run_id, event.sequence); }
    const prefix = child ? `Child ${child}` : `Agent ${frame.agent_id}`;
    if (event.type === 'approval' && ![...this.el('run-approvals').children].some(card => card.dataset.approvalId === event.id)) {
      const card = document.createElement('div'); card.dataset.approvalId = event.id; const title = document.createElement('pre'); title.textContent = `${prefix}: ${event.title}\n${event.detail}`; card.append(title);
      for (const [label, approved] of [['Approve', true], ['Deny', false]]) {
        const button = document.createElement('button'); button.textContent = label; button.title = approved ? 'Allow this proposed effect once.' : 'Reject this effect without executing it.';
        button.onclick = () => this.perform(async () => { await this.call('/approve', 'POST', { id: event.id, approved }); card.remove(); this.updateAttention(); }); card.append(button);
      }
      this.el('run-approvals').append(card);
    }
    if (['change', 'action', 'command', 'mcp', 'mcp_result'].includes(event.type)) {
      for (const card of [...this.el('run-approvals').children]) if (card.dataset.approvalId === event.id) card.remove();
    }
    if (event.type === 'run_ended') for (const card of [...this.el('run-approvals').children]) if (card.querySelector('pre').textContent.startsWith(prefix + ':')) card.remove();
    if (!['chunk', 'thinking_chunk'].includes(event.type)) this.el('run-events').textContent += `${prefix} [${event.source || 'backend'}] ${event.type}: ${JSON.stringify(event)}\n`;
    this.updateAttention();
  }
}

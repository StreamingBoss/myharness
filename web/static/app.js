(function () {
  const root = document.documentElement, button = document.getElementById("theme-toggle");
  const effective = () => root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const paint = () => { button.textContent = effective() === "dark" ? "Light theme" : "Dark theme"; };
  button.addEventListener("click", () => {
    root.dataset.theme = effective() === "dark" ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch {}
    paint();
  });
  paint();
})();
const messagesEl = document.getElementById("messages");
const terminalEl = document.getElementById("terminal");
const memoryEl = document.getElementById("memory");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const compactBtn = document.getElementById("compact");
const contextMeter = document.getElementById("context-meter");
const resetBtn = document.getElementById("reset");
const memoryCheckbox = document.getElementById("use-memory");
const toolsCheckbox = document.getElementById("use-tools");
const askApprovalCheckbox = document.getElementById("ask-approval");
const goalsCheckbox = document.getElementById("use-goals");
const goalsEnabled = new URLSearchParams(location.search).get("goals") === "1";
document.body.classList.toggle("goals-off", !goalsEnabled);
const clearBtn = document.getElementById("clear");
const agentSelect = document.getElementById("agent");
const promptSelect = document.getElementById("prompt");
const lockNote = document.getElementById("lock-note");
const projectInput = document.getElementById("project");
const setProjectBtn = document.getElementById("set-project");
const projectError = document.getElementById("project-error");
let initialTerminal = terminalEl.textContent;
const API_BASE = window.MYHARNESS_API_BASE || new URLSearchParams(location.search).get("api") || "";
const api = (path) => API_BASE + path;
const backendFetch = (...args) => (window.MYHARNESS_FETCH || fetch)(...args);
let session = {};
let sessionEvents = [];
let toolCheckboxes = [];
let contextLength = 0;
let initialized = false;
const tokenViewer = new TokenViewer(document.getElementById('tokenization'), (path, options) => backendFetch(api(path), options), busy => setControlsDisabled(busy));
const requestView = new RequestView(document.getElementById('request-view'));
const vocabularyViewer = new VocabularyViewer(document.getElementById('vocabulary'), (path, options) => backendFetch(api(path), options));
const orchestrationPanel = new OrchestrationPanel(document.getElementById('chat-pane'), (path, options) => backendFetch(api(path), options), () => ({ use_memory: memoryCheckbox.checked, ask_approval: askApprovalCheckbox.checked, goals: goalsCheckbox.checked, tools: toolCheckboxes.filter(box => box.checked).map(box => box.value), agent: agentSelect.value, prompt: promptSelect.value }));
const sessionSelect = document.getElementById("session-select");
const sessionStatus = document.getElementById("session-status");

function markSessionSaving() { sessionStatus.textContent = "saving…"; }
async function saveSessionSettings() {
  if (!session.id) return;
  markSessionSaving();
  const settings = {use_memory: memoryCheckbox.checked, tools: currentTools(),
    ask_approval: askApprovalCheckbox.checked, goals: goalsCheckbox.checked};
  try {
    const response = await backendFetch(api("/sessions/" + session.id), {method: "PATCH", headers: {"Content-Type":"application/json"}, body: JSON.stringify({settings})});
    if (!response.ok) throw responseError(await response.json());
    session = await response.json(); sessionStatus.textContent = "saved";
  } catch (error) { sessionStatus.textContent = "Save failed: " + displayError(error); }
}

function fillSessionSelect(items, selected) {
  sessionSelect.replaceChildren();
  for (const item of items) {
    const date = new Date(item.created_at).toLocaleString();
    sessionSelect.add(new Option(item.name + " — " + date + " — " + item.workspace, item.id));
  }
  sessionSelect.value = selected;
  const active = items.find(item => item.id === selected);
  document.getElementById("session-title").textContent = active ? active.name : "…";
}
function updateContextMeter(used, windowSize = contextLength) {
  const usage = windowSize ? 100 * used / windowSize : 0;
  const percent = Math.round(usage);
  contextMeter.className = used == null ? "" : (usage >= 90 ? "red" : usage >= 75 ? "amber" : "");
  contextMeter.firstChild.textContent = "context: " + (used == null ? "—" : used.toLocaleString("en")) +
    " / " + windowSize.toLocaleString("en") + (used == null ? "" : " (" + percent + "%)");
  document.getElementById("context-bar").value = used == null ? 0 : Math.min(100, percent);
}

function handleContextEvent(event) {
  if (event.action === "compact_request") {
    printBlock("SENT to model — compaction", JSON.stringify(event.wire_request || event.payload, null, 2), "sent");
  } else if (event.action === "compact_response") {
    printBlock("RECEIVED from model — compaction", JSON.stringify(event.response, null, 2), "received");
  } else {
    addDivider(formatFailure(event.failure, event.reason));
    printBlock("CONTEXT — " + event.action, formatFailure(event.failure, event.reason) + (event.summary ? "\n\n" + event.summary : ""));
    if (event.summary) renderChatBubble("assistant", "[Summary of earlier conversation]\n" + event.summary);
  }
  if (event.memory !== undefined) memoryEl.textContent = event.memory;
  if (event.skill_context) activeSkillContext = event.skill_context;
}

compactBtn.addEventListener("click", async () => {
  setControlsDisabled(true);
  try {
    const response = await backendFetch(api("/compact"), {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({use_memory: memoryCheckbox.checked, session_id: session.id}),
    });
    if (!response.ok) throw responseError(await response.json());
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const {value, done} = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, {stream: true});
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) handleContextEvent(JSON.parse(line));
      }
      if (done) break;
    }
  } catch (error) {
    handleContextEvent({action: "error", reason: "Compaction failed:\n" + displayError(error)});
  } finally {
    setControlsDisabled(false);
    activeSkillContext = null;
    refreshExplorer();
  }
});

function renderChatBubble(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

const SEP = "-".repeat(40);

// Alternating plain/highlighted pieces keep user input visible in native requests.
function nativeRequestParts(request) {
  const highlighted = [];
  let marker = "@@USER:";
  const original = JSON.stringify(request);
  while (original.includes(marker)) marker = "@" + marker;
  const encoded = JSON.stringify(request, (key, value) => {
    if (value && typeof value === "object" && (value.role === "user" || value.type === "user_input")) {
      const index = highlighted.push(JSON.stringify(value, null, 2)) - 1;
      return marker + index + "@@";
    }
    return value;
  }, 2);
  const parts = encoded.split(new RegExp('"' + marker + '(\\d+)@@"'));
  return parts.map((part, index) => {
    if (!(index % 2)) return part;
    const before = parts[index - 1];
    const indent = before.slice(before.lastIndexOf("\n") + 1).match(/^\s*/)[0];
    return highlighted[Number(part)].replaceAll("\n", "\n" + indent);
  });
}

// body is plain text or alternating plain/highlighted pieces.
function printBlock(title, body, className = "") {
  const span = document.createElement("span");
  span.className = className;
  span.append(SEP + "\n" + title + "\n" + SEP + "\n");
  const parts = Array.isArray(body) ? body : [body];
  parts.forEach((part, index) => {
    if (index % 2 && part) {
      const b = document.createElement("b");
      b.textContent = part;
      span.append(b);
    } else span.append(part);
  });
  span.append("\n\n");
  terminalEl.appendChild(span);
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

function printModelRequest(event, saved) {
  requestView.addRequest(event);
  if (event.wire_request) printBlock('SENT to ' + event.provider + (saved ? ' (saved)' : ''), nativeRequestParts(event.wire_request), 'sent');
  else printBlock('SENT to model' + (saved ? ' (saved)' : ''), event.parts, 'sent');
  if (event.prefix_text) printBlock('PREFIX REUSE', event.prefix_text);
}

function replaySessionEvent(event) {
  // Replay is display-only: it never calls the model, tools, approvals, or project endpoints.
  if (event.type === "chat_user") renderChatBubble("user", (event.source === "harness" ? "[Harness continuation]\n" : "") + (event.content || ""));
  else if (event.type === "request") printModelRequest(event, true);
  else if (event.type === "response") {
    requestView.addResponse(event);
    printBlock("RECEIVED from model (saved)", event.parts, "received");
    if (event.tokens) printBlock("TOKENS", event.tokens);
    if (event.timing_text) printBlock("TIMING", event.timing_text);
    if (event.tokens_in !== undefined) updateContextMeter(event.tokens_in, event.context_length);
  } else if (event.type === "turn_timing") printBlock("TURN TIMELINE", event.timeline_text);
  else if (event.type === "thinking") renderChatBubble("thinking", event.content || "");
  else if (event.type === "chunk") { if (event.content) renderChatBubble("assistant", event.content); }
  else if (event.type === "tool") {
    printBlock("TOOL — the harness ran " + event.name, "arguments: " + event.arguments + "\nresult:    " + (/^(error:|unsupported:|unavailable:)/.test(event.result) ? formatFailure(event.failure, event.result) : event.result));
    addDivider("used tool " + event.name);
    renderPlan(event);
  } else if (event.type === "command") {
    printBlock("COMMAND — " + (event.approved ? event.status : denialLabel(event)), "$ " + event.command + (event.approved ? "\n\n" + event.output : ""));
  } else if (event.type === "change") {
    printBlock("FILE CHANGE — " + event.path + (event.approved ? " (written)" : " (" + denialLabel(event) + ")"), (event.note ? "note: " + event.note + "\n\n" : "") + event.diff);
  } else if (event.type === "action") printActionBlock(event);
  else if (event.type === "mcp") renderMcpEvent(event, false);
  else if (event.type === "mcp_prompt") addDivider("used MCP prompt " + event.name + " from " + event.server);
  else if (event.type === "context") handleContextEvent(event);
  else if (event.type === "project_instructions") addDivider("— project instructions refreshed" + (event.changed ? " (changed)" : "") + " —");
  else if (event.type === "reset") addDivider("— memory reset —");
  else if (event.type === "guard") renderGuardEvent(event);
  else if (event.type === "stopped") { printBlock("STOPPED", formatFailure(event.failure, event.reason)); addDivider(formatFailure(event.failure, event.reason)); }
}

// A loop-hygiene guard fired in the backend: the reminder it added to the conversation is shown verbatim.
function printActionBlock(event) {
  printBlock("ACTION — " + event.name + (event.approved ? "" : " (" + denialLabel(event) + ")"), event.title + "\n\n" + event.detail + (event.approved ? "\n\nresult: " + event.result : ""));
}

// update_plan: the model's checklist, shown in the chat. Text only; nothing here is a harness decision.
function renderPlan(event) {
  if (event.name !== "update_plan" || !String(event.result).startsWith("Plan updated")) return;
  const box = element("div", null, "plan");
  box.append(element("div", event.result.split("\n")[0], "plan-title"));
  for (const item of JSON.parse(event.arguments).items) box.append(element("div", ({ pending: "[ ] ", in_progress: "[~] ", done: "[x] " })[item.status] + item.step, "plan-item plan-" + item.status));
  messagesEl.appendChild(box); messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderGuardEvent(event) {
  printBlock("GUARD — repeated tool call (" + event.tool + " x" + event.count + ", " + event.level + " reminder added to the conversation)", event.content);
  addDivider("harness reminded the model: repeated " + event.tool);
}

function replaySession() {
  messagesEl.replaceChildren();
  terminalEl.textContent = initialTerminal;
  requestView.reset();
  let assistant = null, assistantText = "", thinking = null, thinkingText = "";
  for (const event of sessionEvents) {
    if (event.type === "chunk") {
      if (!assistant) assistant = renderChatBubble("assistant", "");
      assistantText += event.content || "";
      renderMarkdown(assistant, assistantText);
      continue;
    }
    if (event.type === "thinking") {
      if (!thinking) thinking = renderChatBubble("thinking", "");
      thinkingText += event.content || ""; thinking.textContent = thinkingText;
      continue;
    }
    if (event.type === "response") [assistant, assistantText] = completeReply(event, assistant, assistantText);
    replaySessionEvent(event);
    if (["tool", "chat_user", "stopped", "context", "guard"].includes(event.type)) {
      assistant = null; assistantText = ""; thinking = null; thinkingText = "";
    }
  }
}

function completeReply(event, bubble, text) {
  if (typeof event.content === "string" && event.content !== "" && event.content !== text) {
    if (!bubble) bubble = renderChatBubble("assistant", "");
    text = event.content;
    renderMarkdown(bubble, text);
  }
  return [bubble, text];
}

// Backend diagnostics survive transport and session replay; text is rendered safely.
function formatFailure(failure, fallback) {
  if (globalThis.MyHarnessErrors) return globalThis.MyHarnessErrors.presentFailure(failure, fallback);
  if (!failure) return fallback;
  return "Source: " + failure.source + " — " + failure.component + "\n" +
    "Reason: " + failure.reason + "\n" + "Next: " + failure.recovery;
}
function responseError(data) {
  const error = new Error(data.error || "Request failed.");
  error.failure = data.failure;
  return error;
}
function displayError(error) {
  return formatFailure(error.failure, "The request could not be completed. Check the connection and try again.\n\nTechnical details: " + error.message);
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  fitInput();
  // with memory on, this message starts (or continues) a conversation: lock its setup
  if (memoryCheckbox.checked) conversationLocked = true;
  setControlsDisabled(true);

  renderChatBubble("user", text);

  try {
    const resp = await backendFetch(api("/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        message: text,
        use_memory: memoryCheckbox.checked,
        ask_approval: askApprovalCheckbox.checked,
        goals: goalsCheckbox.checked,
        agent: agentSelect.value,
        prompt: promptSelect.value,
        tools: toolsCheckbox.checked
          ? toolCheckboxes.filter((c) => c.checked).map((c) => c.value)
          : [],
      }),
    });

    if (!resp.ok) throw responseError(await resp.json());
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantDiv = null;  // created on the first text chunk, after any tool notes
    let replyText = "";
    let thinkingDiv = null;
    let thinkingText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        const event = JSON.parse(line);
        if (event.skill_context) {
          activeSkillContext = event.skill_context;
          if (exploreView.value === "skills" && skillsExplorerData) {
            renderSkills(skillsExplorerData, activeSkillContext);
          }
        }

        if (event.type === "context") {
          handleContextEvent(event);
        } else if (event.type === "request") {
          printModelRequest(event, false);
          memoryEl.textContent = event.memory;
        } else if (event.type === "skill") {
          addDivider("— skill loaded: " + event.name + " —");
        } else if (event.type === "thinking") {
          if (!thinkingDiv) thinkingDiv = renderChatBubble("thinking", "");
          thinkingText += event.content;
          thinkingDiv.textContent = thinkingText;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (event.type === "chunk") {
          if (!event.content) continue;
          if (!assistantDiv) assistantDiv = renderChatBubble("assistant", "");
          replyText += event.content;
          renderMarkdown(assistantDiv, replyText);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (event.type === "response") {
          [assistantDiv, replyText] = completeReply(event, assistantDiv, replyText);
          updateContextMeter(event.tokens_in, event.context_length);
          requestView.addResponse(event);
          printBlock("RECEIVED from model", event.parts, "received");
          printBlock("TOKENS", event.tokens);
          if (event.timing_text) printBlock("TIMING", event.timing_text);
          memoryEl.textContent = event.memory;
        } else if (event.type === "turn_timing") {
          printBlock("TURN TIMELINE", event.timeline_text);
        } else if (event.type === "tool") {
          printBlock("TOOL — the harness ran " + event.name,
                     "arguments: " + event.arguments + "\nresult:    " + (/^(error:|unsupported:|unavailable:)/.test(event.result) ? formatFailure(event.failure, event.result) : event.result));
          memoryEl.textContent = event.memory;
          addDivider("used tool " + event.name);
          renderPlan(event);
          // text after a tool run goes in new bubbles, below the tool note
          assistantDiv = null;
          replyText = "";
          thinkingDiv = null;
          thinkingText = "";
        } else if (event.type === "approval" && event.server !== undefined) {
          changeBox = renderChangeBox("MCP tool " + event.tool + " on server '" + event.server + "' wants to run with these arguments:",
                                      event.arguments, mcpHints(event.annotations));
          addApprovalButtons(changeBox, event.id);
        } else if (event.type === "mcp") {
          renderMcpEvent(event, true);
        } else if (event.type === "mcp_prompt") {
          addDivider("used MCP prompt " + event.name + " from " + event.server);
        } else if (event.type === "approval" && event.title !== undefined) {
          changeBox = renderChangeBox(event.title, event.detail);
          addApprovalButtons(changeBox, event.id);
        } else if (event.type === "action") {
          if (!changeBox) changeBox = renderChangeBox(event.title, event.detail);
          const failed = event.approved && event.result.startsWith("error:");
          setChangeStatus(changeBox, event.approved && !failed, event.result, failed ? event.result : denialLabel(event));
          changeBox = null;
          printActionBlock(event);
        } else if (event.type === "approval") {
          changeBox = event.command !== undefined
            ? renderChangeBox("run_command wants to run, in " + projectInput.value + ":",
                              "$ " + event.command)
            : renderChangeBox(event.name + " wants to change " + event.path, event.diff,
                              event.note);
          addApprovalButtons(changeBox, event.id);
        } else if (event.type === "command") {
          if (!changeBox) changeBox = renderChangeBox("run_command ran:", "$ " + event.command);
          if (event.approved) {
            const out = document.createElement("pre");
            out.className = "command-output";
            out.textContent = event.output || "(no output)";
            changeBox.querySelector(".change-actions").before(out);
          }
          setChangeStatus(changeBox, event.approved, event.status, denialLabel(event));
          changeBox = null;
          printBlock("COMMAND — " + (event.approved ? event.status : denialLabel(event)),
                     "$ " + event.command + (event.approved ? "\n\n" + event.output : ""));
        } else if (event.type === "change") {
          if (!changeBox) changeBox = renderChangeBox(event.path, event.diff, event.note);
          setChangeStatus(changeBox, event.approved, "written", denialLabel(event));
          changeBox = null;
          printBlock("FILE CHANGE — " + event.path + (event.approved ? " (written)" : " (" + denialLabel(event) + ")"),
                     (event.note ? "note: " + event.note + "\n\n" : "") + event.diff);
        } else if (event.type === "guard") {
          renderGuardEvent(event);
          memoryEl.textContent = event.memory;
        } else if (event.type === "stopped") {
          printBlock("STOPPED", formatFailure(event.failure, event.reason));
          addDivider(formatFailure(event.failure, event.reason));
          if (event.memory) memoryEl.textContent = event.memory;
        }
      }
    }

  } catch (error) {
    printBlock("STOPPED", "Chat request failed:\n" + displayError(error));
    addDivider("Chat request failed:\n" + displayError(error));
  } finally {
    setControlsDisabled(false);
    activeSkillContext = null;
    refreshExplorer();
    input.focus();
  }
}

let changeBox = null;  // the diff box of the file change being handled

const chatPane = document.getElementById("chat-pane");
const inspectorEl = document.getElementById("inspector");

// both apply a size in % (clamped) and return what they applied
function setChatWidth(percent) {
  percent = Math.min(80, Math.max(20, percent));
  chatPane.style.flexBasis = percent + "%";
  return percent;
}


// a draggable divider; its position is remembered in this browser
function setupDivider(handle, storageKey, apply, percentFromPointer) {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) apply(Number(saved));
  } catch {}
  let value = null;
  handle.addEventListener("pointerdown", (e) => {
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (e) => {
    if (handle.hasPointerCapture(e.pointerId)) value = apply(percentFromPointer(e));
  });
  handle.addEventListener("pointerup", () => {
    handle.classList.remove("dragging");
    if (value === null) return;
    try { localStorage.setItem(storageKey, value); } catch {}
  });
}

setupDivider(document.getElementById("splitter"), "chatWidth", setChatWidth, (e) => {
  const panes = document.getElementById("panes").getBoundingClientRect();
  return 100 * (e.clientX - panes.left) / panes.width;
});

const exploreView = document.getElementById("explore-view");
const exploreEl = document.getElementById("explore");
const exploreNote = document.getElementById("explore-note");
const mcpReloadBtn = document.getElementById("mcp-reload");
mcpReloadBtn.addEventListener("click", reloadMcp);
const mcpConfigEditor = document.getElementById("mcp-config-editor");
const mcpConfigText = document.getElementById("mcp-config-text");
const mcpServerDetails = document.getElementById("mcp-server-details");
const mcpServerStatus = document.getElementById("mcp-server-status");
document.getElementById("mcp-config-save").addEventListener("click", async () => {
  const message = document.getElementById("mcp-config-message");
  try {
    const config = JSON.parse(mcpConfigText.value);
    const response = await backendFetch(api("/mcp/config"), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }) });
    const data = await response.json();
    if (!response.ok) throw responseError(data);
    message.textContent = "Saved and reconnected.";
    const boot = await backendFetch(api("/bootstrap")); initialize(await boot.json());
  } catch (error) { message.textContent = "Save failed: " + displayError(error); }
});
const mcpFindBtn = document.getElementById("mcp-find");
const registryDialog = document.getElementById("mcp-registry");
mcpFindBtn.addEventListener("click", () => { registryDialog.showModal(); if (!registryCursor) searchRegistry(false); });
document.getElementById("mcp-registry-form").addEventListener("submit", (event) => { event.preventDefault(); searchRegistry(false); });
document.getElementById("mcp-registry-source").addEventListener("change", () => searchRegistry(false));
document.getElementById("mcp-registry-close").addEventListener("click", () => registryDialog.close());
document.getElementById("mcp-registry-more").addEventListener("click", () => searchRegistry(true));

const EXPLORE_NOTES = {
  memory: "The messages the harness keeps and re-sends with every request. The model keeps nothing itself. Tool calls and results are stored too; the system message is not. The model's thinking is kept only while a tool loop runs (Ollama) and is dropped when the turn ends.",
  system: "The library prompt chosen at the top. It's the first part of the system message, at the very start of every request.",
  agent: "The agent's instructions, added after the system prompt in the same system message. Its tools line presets the tool checkboxes.",
  project: "AGENTS.md from the project folder root, added after the agent and before the skills. Read again for every model call: edits and project-folder changes apply immediately, even while the agent and system prompt are locked. Only AGENTS.md is used.",
  mcp: "MCP servers from the backend's configuration file. The harness connects to each, detects its protocol era (modern 2026-07-28 or a legacy initialize handshake), and turns what it reports into tools, instructions, resources and prompts. Use a prompt by typing /mcp__server__prompt followed by its arguments. The wire log shows the JSON-RPC messages.",
  tools: "The checked tools, exactly as the harness sends them: a separate 'tools' field of the request, next to 'messages'. The model's template then turns them into text inside the system part; see 'final prompt'.",
  skills: "Green = text present in the harness context: names/descriptions in the system message, instruction lines in retained messages or the active turn. Updates as skills load via use_skill, /name or read_file; clears when that text leaves memory. Ollama may truncate overflowing requests without reporting which text remains. Skills are skills/<name>/SKILL.md files, in myharness or in the project folder.",
  template: "Comes with the model, from Ollama (/api/show). The template is the program that turns the system message, the tools and the conversation into the single text the model reads. The parameters are the model's default settings. The KV cache estimate shows how much memory the harness's working context reserves for this model.",
  final: "An illustrative Qwen prompt reconstruction for the next request, including project instructions, tools and conversation. This is generated locally, not captured from Ollama; a different model template or Ollama version may render different text. SENT shows the actual API payload. Highlighted: special tokens and structural tags.",
};

function currentTools() {
  return toolsCheckbox.checked ? toolCheckboxes.filter((c) => c.checked).map((c) => c.value) : [];
}

function showHighlighted(text) {
  // special tokens like <|im_start|> and structural tags in color; everything else as text
  exploreEl.replaceChildren();
  const pattern = /<\|[a-z_]+\|>|<\/?(?:tools|tool_call|tool_response|think)>|\/think/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    exploreEl.append(text.slice(last, match.index));
    const span = document.createElement("span");
    span.className = "token";
    span.textContent = match[0];
    exploreEl.append(span);
    last = match.index + match[0].length;
  }
  exploreEl.append(text.slice(last));
}

let activeSkillContext = null;
let skillsExplorerData = null;

function renderSkills(data, context) {
  exploreEl.replaceChildren();
  function append(text, loaded, title) {
    const span = document.createElement("span");
    span.textContent = text;
    if (loaded) span.className = "skill-loaded";
    if (title) span.title = title;
    exploreEl.append(span);
  }
  if (!data.skills.length) {
    exploreEl.textContent = data.skills_listed
      ? "(no skills: add skills/<name>/SKILL.md files)"
      : "(no skills sent: use_skill is unchecked)";
    exploreNote.textContent = EXPLORE_NOTES.skills;
    return;
  }
  const listCost = Math.round(data.skills_section.length / 4);
  const fullCost = Math.round(data.skills.reduce((n, s) => n + s.body.length, 0) / 4);
  exploreNote.textContent = EXPLORE_NOTES.skills + "  (list ~" + listCost +
    " tokens on every request" +
    "; all full skills ~" + fullCost.toLocaleString("en") + " tokens)";
  append("SENT ON EVERY REQUEST (in the system message)\n\n");
  const firstEntry = data.skills_section.indexOf("\n- ");
  append(data.skills_section.slice(0, firstEntry),
    data.skills.some(s => context[s.name]?.listed));
  for (const s of data.skills) {
    append("\n- " + s.name + ": " + s.description, context[s.name]?.listed,
      "Green when this name and description are in the system message.");
  }
  append("\n\n\nLOADED ONLY WHEN USED\n");
  for (const s of data.skills) {
    const state = context[s.name] || {};
    append("\n" + "-".repeat(40) + "\n" + s.name + " (" + s.source + ")\n" +
      "-".repeat(40) + "\n", state.body_loaded,
      "Green when all of these instructions are present in the harness context.");
    const loadedLines = new Set(state.loaded_lines || []);
    s.body.split("\n").forEach((line, i) => {
      append(line + "\n", state.body_loaded || loadedLines.has(i),
        "Green when this instruction line is present in the harness context.");
    });
  }
}

function mcpText(mcp) {
  if (!mcp.supported) return "MCP is unavailable: " + mcp.reason;
  const lines = ["Configuration: " + mcp.source];
  if (mcp.error) lines.push("Configuration error: " + formatFailure(undefined, mcp.error));
  if (!mcp.servers.length) lines.push("", "(no MCP servers configured)");
  for (const server of mcp.servers) lines.push("", ...mcpServerLines(server));
  return lines.join("\n");
}

function mcpServerLines(server) {
  const lines = ["== " + server.name + " — " + server.status + (server.transport ? " (" + server.transport + ")" : "")];
  if (server.error) lines.push("error: " + formatFailure(undefined, server.error));
  if (server.era) lines.push("protocol: " + server.protocol_version + " (" + server.era + (server.era === "modern" ? ": server/discover, metadata on every request" : ": initialize handshake") + ")");
  if (server.server_info) lines.push("server: " + JSON.stringify(server.server_info) + " (self-reported)");
  if (server.instructions) lines.push("instructions (added to the system message when its tools are checked):", "  " + server.instructions.replaceAll("\n", "\n  "));
  for (const tool of server.tools) lines.push("tool " + tool.qualified + ": " + tool.description + (tool.annotations ? "  hints " + JSON.stringify(tool.annotations) : ""));
  if (server.resources) lines.push("resources: " + server.resources + " (read with list_mcp_resources / read_mcp_resource)");
  for (const prompt of server.prompts) lines.push("prompt /" + prompt.qualified + " " + prompt.arguments.map(arg => arg.required ? "<" + arg.name + ">" : "[" + arg.name + "]").join(" ") + (prompt.description ? ": " + prompt.description : ""));
  for (const warning of server.warnings) lines.push("warning: " + warning);
  if (server.stderr.length) lines.push("stderr (last lines):", ...server.stderr.map(line => "  " + line));
  if (server.log.length) lines.push("wire log:", ...server.log.map(entry => "  " + entry.direction.padEnd(8) + " " + entry.text));
  return lines;
}

// The registry browser only displays backend results; registry text is never inserted as HTML.
let registryCursor = "";
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function renderRegistryOption(option) {
  const row = element("div", null, "registry-option");
  row.append(element("span", option.label));
  const output = element("pre"); output.hidden = true;
  if (option.preview) {
    const authLabel = element("label", "Authorization header (optional) ");
    const auth = element("input"); auth.type = "password"; auth.autocomplete = "off";
    auth.placeholder = "Bearer …";
    auth.title = authLabel.title = "Full Authorization header sent only for this tool preview, for example Bearer <token>. Cleared after sending; it is not saved as server configuration.";
    authLabel.append(auth);
    row.append(authLabel);
    row.append(element("div", "For servers requiring authentication, enter the full header value. Used for this preview only; cleared after sending. OAuth sign-in is unavailable.", "registry-note"));
    const preview = element("button", "Preview tools");
    preview.type = "button";
    preview.title = "Connect once to " + option.preview.url + ", list its tools, prompts and resources, then disconnect. No tool is called.";
    preview.addEventListener("click", async () => {
      preview.disabled = true; output.hidden = false; output.textContent = "connecting…";
      try {
        const body = JSON.stringify({ ...option.preview, ...(auth.value.trim() ? { headers: { Authorization: auth.value.trim() } } : {}) });
        auth.value = "";
        const response = await backendFetch(api("/mcp/preview"), { method: "POST", headers: { "Content-Type": "application/json" }, body });
        const data = await response.json();
        if (!response.ok) throw responseError(data);
        output.textContent = mcpServerLines(data).join("\n");
      } catch (error) { output.textContent = "Preview failed: " + displayError(error); }
      finally { auth.value = ""; preview.disabled = false; }
    });
    row.append(preview);
  }
  const config = element("button", option.config ? "Show configuration" : "How to add");
  config.type = "button";
  config.title = "Show the generated server configuration and setup notes. For supported entries, edit the JSON and credentials before adding the server to the harness.";
  const copy = element("button", "Copy"); copy.type = "button"; copy.hidden = true;
  copy.title = "Copy the generated configuration snippet to the clipboard. Edits in the configuration field below are saved only with Add to harness.";
  const snippet = option.config ? JSON.stringify(option.config, null, 2) : "";
  config.addEventListener("click", () => {
    output.hidden = false;
    output.textContent = (snippet ? snippet + "\n\n" : "") + option.notes.map(note => "• " + note).join("\n");
    copy.hidden = !snippet;
  });
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(snippet); copy.textContent = "Copied"; }
    catch { copy.textContent = "Select the text to copy"; }
  });
  const editor = element("textarea"); editor.hidden = true; editor.value = snippet;
  editor.title = "JSON entries to add to or replace in the harness MCP configuration. Replace placeholders with values or Node environment references such as ${TOKEN}. Same-named server entries are replaced; other servers are preserved.";
  editor.setAttribute("aria-label", "MCP configuration to add"); editor.rows = 10;
  editor.style.width = "100%";
  const tokenLabel = element("label", "Authorization header to save (optional) "); tokenLabel.hidden = true;
  const token = element("input"); token.type = "password"; token.autocomplete = "off"; token.placeholder = "Bearer …";
  token.title = tokenLabel.title = "Full Authorization header to apply to the entries being added, for example Bearer <token>. Node saves it in the MCP config file; browser headers remain in memory. The field clears after sending.";
  tokenLabel.append(token);
  const saveNote = element("div", "Edit placeholders above or enter the full Authorization header below if needed. Node saves credentials in the MCP config file; the browser keeps headers in memory only. Adding a package starts its command.", "registry-note"); saveNote.hidden = true;
  const add = element("button", "Add to harness"); add.type = "button"; add.hidden = true;
  add.title = "Save this entry in the harness MCP configuration and reload servers. Package entries start their configured command.";
  config.addEventListener("click", () => { add.hidden = editor.hidden = tokenLabel.hidden = saveNote.hidden = !option.config; });
  add.addEventListener("click", async () => {
    add.disabled = true;
    try {
      const configuration = JSON.parse(editor.value);
      if (token.value.trim()) for (const server of Object.values(configuration.mcpServers)) server.headers = { ...server.headers, Authorization: token.value.trim() };
      const body = JSON.stringify(configuration);
      token.value = "";
      const response = await backendFetch(api("/mcp/add"), { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const data = await response.json();
      if (!response.ok) throw responseError(data);
      output.textContent = "Saved to " + data.source + "\n\n" + mcpText(data);
      const boot = await backendFetch(api("/bootstrap"));
      initialize(await boot.json());
      add.textContent = "Added";
    } catch (error) { output.textContent = "Could not add MCP server: " + displayError(error); add.disabled = false; }
  });
  row.append(config, copy, output, editor, saveNote, tokenLabel, add);
  return row;
}
function renderRegistryServer(server) {
  const card = element("div", null, "registry-server");
  card.append(element("h3", server.title + (server.version ? " " + server.version : "") + (server.status !== "active" ? " (" + server.status + ")" : "")));
  card.append(element("div", server.name + (server.repository ? " · " + server.repository : server.website ? " · " + server.website : ""), "registry-name"));
  if (server.description) card.append(element("div", server.description));
  if (!server.options.length) card.append(element("div", "No remote URL or package is listed.", "registry-option"));
  for (const option of server.options) card.append(renderRegistryOption(option));
  return card;
}
async function searchRegistry(more) {
  const results = document.getElementById("mcp-registry-results"), moreBtn = document.getElementById("mcp-registry-more");
  if (!more) { results.replaceChildren(element("div", "searching…")); registryCursor = ""; }
  moreBtn.hidden = true;
  const query = new URLSearchParams({ search: document.getElementById("mcp-registry-search").value.trim(), source: document.getElementById("mcp-registry-source").value });
  if (more && registryCursor) query.set("cursor", registryCursor);
  try {
    const response = await backendFetch(api("/mcp/registry?" + query));
    const data = await response.json();
    if (!response.ok) throw responseError(data);
    if (!more) results.replaceChildren();
    for (const server of data.servers) results.append(renderRegistryServer(server));
    if (!results.children.length) results.append(element("div", "No servers found."));
    registryCursor = data.nextCursor; moreBtn.hidden = !registryCursor;
  } catch (error) { results.replaceChildren(element("div", "Registry search failed: " + displayError(error))); }
}

async function reloadMcp() {
  mcpReloadBtn.disabled = true;
  try {
    const response = await backendFetch(api("/mcp/reload"), { method: "POST" });
    if (!response.ok) throw responseError(await response.json());
    const boot = await backendFetch(api("/bootstrap"));
    initialize(await boot.json());
  } catch (error) {
    exploreNote.textContent = "Reload failed: " + displayError(error);
  } finally { mcpReloadBtn.disabled = false; }
}

async function refreshExplorer() {
  if (!initialized) return;
  const view = exploreView.value;
  const showMemory = view === "memory";
  const showMcp = view === "mcp";
  inspectorEl.classList.toggle("mcp-view", showMcp);
  mcpConfigEditor.hidden = view !== "mcp";
  mcpServerDetails.hidden = !showMcp;
  mcpReloadBtn.hidden = mcpFindBtn.hidden = view !== "mcp";
  document.getElementById('tokenization').hidden = view !== 'tokens';
  document.getElementById('vocabulary').hidden = view !== 'vocabulary';
  document.getElementById('internals-pane').hidden = view !== 'log';
  document.getElementById('request-view').hidden = view !== 'request';
  if (view === 'request') { memoryEl.hidden = true; exploreEl.hidden = true; exploreNote.textContent = ''; return; }
  if (view === 'log') { memoryEl.hidden = true; exploreEl.hidden = true; exploreNote.textContent = ''; return; }
  if (view === 'vocabulary') {
    memoryEl.hidden = true; exploreEl.hidden = true;
    exploreNote.textContent = 'Every token the selected model can read or write, in ID order. Search for a word to see whether it is one token or several.';
    await vocabularyViewer.refresh(); return;
  }
  if (view === 'tokens') {
    memoryEl.hidden = true; exploreEl.hidden = true;
    exploreNote.textContent = 'Inspect the saved request for a specific model call. Source, coverage and limitations appear below.';
    await tokenViewer.refresh(session.id); return;
  }
  memoryEl.hidden = !showMemory;
  exploreEl.hidden = showMemory || showMcp;
  let note = EXPLORE_NOTES[view];
  if (showMemory) {
    exploreNote.textContent = note;
    return;
  }
  exploreNote.textContent = note;
  if (showMcp) {
    mcpServerStatus.textContent = "Loading MCP server status…";
    document.getElementById("mcp-config-source").textContent = "Loading configuration…";
    await Promise.all([
      (async () => {
        try {
          const response = await backendFetch(api("/mcp"));
          const status = await response.json();
          if (!response.ok) throw responseError(status);
          mcpServerStatus.textContent = mcpText(status);
        } catch (error) { mcpServerStatus.textContent = "Could not read MCP server status: " + displayError(error); }
      })(),
      (async () => {
        try {
          const response = await backendFetch(api("/mcp/config"));
          const configuration = await response.json();
          if (!response.ok) throw responseError(configuration);
          document.getElementById("mcp-config-source").textContent = "Editable source: " + configuration.source;
          mcpConfigText.value = JSON.stringify(configuration.config, null, 2);
          document.getElementById("mcp-config-save").disabled = !configuration.editable;
          document.getElementById("mcp-config-message").textContent = configuration.editable ? "" : "This runtime does not support editing MCP configuration.";
        } catch (error) { document.getElementById("mcp-config-source").textContent = "Could not read configuration: " + displayError(error); }
      })(),
    ]);
    return;
  }
  let data;
  try {
    const resp = await backendFetch(api("/explore"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        use_memory: memoryCheckbox.checked,
        goals: goalsCheckbox.checked,
        agent: agentSelect.value,
        prompt: promptSelect.value,
        tools: currentTools(),
        describe_model: view === "template",
      }),
    });
    data = await resp.json();
    if (!resp.ok) throw responseError(data);
  } catch (error) {
    if (exploreView.value === view) {
      exploreEl.textContent = "Could not load this explorer view. " + displayError(error);
      exploreNote.textContent = note;
    }
    return;
  }
  if (exploreView.value !== view) return;  // the user switched views meanwhile
  const warnings = (data.warnings || []).map(reason => formatFailure(undefined, reason)).join(" ");
  note += " " + warnings;
  let text;
  if (view === "system") {
    text = data.prompt_name ? data.system_prompt : "(no system prompt selected)";
  } else if (view === "agent") {
    text = data.agent
      ? "agent: " + data.agent_name + " (" + data.agent.source + ")\ntools: " +
        (data.agent.tools.join(", ") || "(none)") + "\n\n" + data.agent.prompt
      : "(no agent selected)";
  } else if (view === "project") {
    text = data.project_instructions
      ? data.project_instructions[0] + "\n\n" + data.project_instructions[1]
      : "none: create AGENTS.md in the project folder";
  } else if (view === "tools") {
    text = data.tools === "[]" ? "(no tools checked: the request has no 'tools' field)" : data.tools;
  } else if (view === "skills") {
    skillsExplorerData = data;
    renderSkills(data, activeSkillContext || data.skill_context);
    exploreNote.textContent += " " + warnings;
    return;
  } else if (view === "template") {
    text = "TEMPLATE\n\n" + data.template + "\n\nPARAMETERS\n\n" + data.parameters +
      (data.kv_text ? "\n\nKV CACHE (estimate)\n\n" + data.kv_text : "");
  } else {
    text = data.final;
  }
  if (view !== "template" && view !== "skills") {
    note += "  (~" + Math.round(text.length / 4).toLocaleString("en") + " tokens)";
  }
  exploreNote.textContent = note;
  if (view === "final") showHighlighted(text);
  else exploreEl.textContent = text;
}

exploreView.addEventListener("change", refreshExplorer);
// Inspector tabs: a skin over the view select, so the chosen view lives in one place.
const inspectorTabs = [...document.querySelectorAll('#inspector [role="tab"]')];
function syncInspectorTabs() {
  for (const tab of inspectorTabs) {
    const on = tab.dataset.view === exploreView.value;
    tab.setAttribute("aria-selected", String(on)); tab.tabIndex = on ? 0 : -1;
  }
}
function chooseInspectorView(view) { exploreView.value = view; exploreView.dispatchEvent(new Event("change")); }
inspectorTabs.forEach((tab, i) => {
  tab.addEventListener("click", () => chooseInspectorView(tab.dataset.view));
  tab.addEventListener("keydown", (e) => {
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? inspectorTabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const target = inspectorTabs[(next + inspectorTabs.length) % inspectorTabs.length];
    chooseInspectorView(target.dataset.view); target.focus();
  });
});
exploreView.addEventListener("change", syncInspectorTabs);
syncInspectorTabs();
// deferred, so it runs after the other change handlers (choosing an agent ticks its tools)
for (const el of [promptSelect, agentSelect, toolsCheckbox, memoryCheckbox, ...toolCheckboxes]) {
  el.addEventListener("change", () => setTimeout(refreshExplorer));
}

function renderMarkdown(div, text) {
  div.classList.add("markdown");
  div.innerHTML = DOMPurify.sanitize(marked.parse(text));
}

// MCP annotations come from the server; they describe the tool but are not verified.
function mcpHints(annotations) {
  if (!annotations || typeof annotations !== "object") return "";
  const hints = Object.entries(annotations).map(([key, value]) => key + "=" + JSON.stringify(value)).join(", ");
  return hints ? "server hints, not verified by the harness: " + hints : "";
}

function renderMcpEvent(event, live) {
  const label = event.server + "/" + event.tool;
  if (live) {
    if (!changeBox) changeBox = renderChangeBox("MCP tool " + label + ":", event.arguments);
    if (event.approved) {
      const out = document.createElement("pre");
      out.className = "command-output";
      out.textContent = event.result || "(no content)";
      changeBox.querySelector(".change-actions").before(out);
    }
    setChangeStatus(changeBox, event.approved, event.is_error ? "ran: the server reported an error" : "ran", denialLabel(event));
    changeBox = null;
  }
  const wire = event.request ? "\n\nJSON-RPC request:\n" + JSON.stringify(event.request, null, 2) + "\n\nJSON-RPC response:\n" + JSON.stringify(event.response, null, 2) : "";
  printBlock("MCP — " + label + (event.approved ? " over " + event.transport + ", protocol " + event.protocol_version : " (" + denialLabel(event) + ")"),
             "arguments: " + event.arguments + (event.approved ? "\nresult:    " + (/^(error:|unsupported:|unavailable:)/.test(event.result) ? formatFailure(event.failure, event.result) : event.result) + wire : ""));
}

function renderChangeBox(title, diff, note) {
  const box = document.createElement("div");
  box.className = "change";
  const titleEl = document.createElement("div");
  titleEl.className = "change-title";
  titleEl.textContent = title;
  if (note) {
    const noteEl = document.createElement("div");
    noteEl.className = "change-note";
    noteEl.textContent = "Note: " + note + ".";
    titleEl.appendChild(noteEl);
  }
  const pre = document.createElement("pre");
  for (const line of diff.split("\n")) {
    const span = document.createElement("span");
    if (line.startsWith("@@")) span.className = "diff-hunk";
    else if (line.startsWith("+") && !line.startsWith("+++")) span.className = "diff-add";
    else if (line.startsWith("-") && !line.startsWith("---")) span.className = "diff-del";
    span.textContent = line + "\n";
    pre.appendChild(span);
  }
  const actions = document.createElement("div");
  actions.className = "change-actions";
  box.append(titleEl, pre, actions);
  messagesEl.appendChild(box);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return box;
}

function addApprovalButtons(box, id) {
  const actions = box.querySelector(".change-actions");
  const deny = document.createElement("button");
  deny.title = "Reject this proposed action. The harness sends the denial to the model without executing the effect.";
  deny.textContent = "Deny";
  const approve = document.createElement("button");
  approve.title = "Allow this proposed action once. Later effects still require their own approval.";
  approve.textContent = "Approve";
  approve.className = "approve";
  for (const [button, approved] of [[deny, false], [approve, true]]) {
    button.addEventListener("click", () => {
      deny.disabled = approve.disabled = true;
      backendFetch(api("/approve"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, approved }),
      });
    });
  }
  actions.append(deny, approve);
}

// Why an action did not run: the backend reports how the approval ended; the UI only words it.
function denialLabel(event) {
  return event.outcome === "unavailable" ? (event.approval_timeout_ms === undefined ? "no answer" : "Not run: no approval within " + (globalThis.MyHarnessErrors ? globalThis.MyHarnessErrors.timeoutDuration(event.approval_timeout_ms) : event.approval_timeout_ms / 1000 + " seconds")) : event.outcome === "cancelled" ? "cancelled" : "refused";
}

function setChangeStatus(box, approved, doneLabel, denial = "refused") {
  const actions = box.querySelector(".change-actions");
  const status = document.createElement("span");
  status.className = "change-status " + (approved ? "approved" : "refused");
  status.textContent = approved ? doneLabel : denial;
  actions.replaceChildren(status);
}

function setControlsDisabled(disabled) {
  for (const el of [input, sendBtn, resetBtn, compactBtn, clearBtn, memoryCheckbox, toolsCheckbox, goalsCheckbox,
                    askApprovalCheckbox, projectInput, setProjectBtn, browseBtn, mcpReloadBtn]) {
    el.disabled = disabled;
  }
  compactBtn.disabled = disabled || !memoryCheckbox.checked;
  for (const c of toolCheckboxes) c.disabled = disabled || !toolsCheckbox.checked;
  syncToolGroups();
  agentSelect.disabled = promptSelect.disabled = disabled || conversationLocked;
  lockNote.hidden = !conversationLocked;
  // while a turn runs, Stop takes the place of Send
  sendBtn.hidden = disabled;
  stopBtn.hidden = !disabled;
  stopBtn.disabled = false;
}

function unlockConversation() {
  conversationLocked = false;
  setControlsDisabled(false);
}

toolsCheckbox.addEventListener("change", () => {
  for (const c of toolCheckboxes) c.disabled = !toolsCheckbox.checked;
  syncToolGroups();
});

let agents = [];
let prompts = [];
let locked = null;
let conversationLocked = false;

promptSelect.add(new Option("none", ""));
for (const p of prompts) {
  const label = p.name + " (~" + p.tokens.toLocaleString("en") + " tokens)" +
                (p.fits ? "" : " — too big for the context window");
  const option = new Option(label, p.name);
  option.disabled = !p.fits;
  promptSelect.add(option);
}
if (session.snapshots?.prompt?.name && !prompts.some(p => p.name === session.snapshots.prompt.name)) {
  promptSelect.add(new Option(session.snapshots.prompt.name + " (saved with this session)", session.snapshots.prompt.name));
}
if (session.snapshots?.agent?.name && !agents.some(a => a.name === session.snapshots.agent.name)) {
  agents.push({name: session.snapshots.agent.name, source: "saved session", tools: session.snapshots.agent.value?.tools || []});
}

promptSelect.addEventListener("change", () => {
  addDivider("— system prompt: " + (promptSelect.value || "none") + " —");
});

function fillAgentSelect() {
  const previous = agentSelect.value;
  agentSelect.replaceChildren(new Option("none", ""));
  for (const a of agents) {
    agentSelect.add(new Option(a.name + " (" + a.source + ")", a.name));
  }
  if (previous && !agents.some((a) => a.name === previous)) {
    addDivider("— agent " + previous + " not in this project: agent set to none —");
  } else {
    agentSelect.value = previous;
  }
}

agentSelect.addEventListener("change", () => {
  const agent = agents.find((a) => a.name === agentSelect.value);
  if (agent) {
    toolsCheckbox.checked = agent.tools.length > 0;
    for (const c of toolCheckboxes) {
      c.checked = agent.tools.includes(c.value);
      c.disabled = !toolsCheckbox.checked;
    }
    syncToolGroups();
  }
  addDivider("— agent: " + agentSelect.selectedOptions[0].textContent + " —");
});

async function setProject(native = false) {
  const resp = await backendFetch(api("/project"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectInput.value, ...(native ? { bridge: true } : {}) }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    projectError.textContent = formatFailure(result.failure, result.error);
    return;
  }
  projectError.textContent = "";
  const stateResponse = await backendFetch(api("/bootstrap"));
  if (!stateResponse.ok) {
    projectError.textContent = "Project changed, but its state could not be refreshed. Refresh the page to reconnect.";
    return;
  }
  window.dispatchEvent(new CustomEvent("myharness:state", {detail: await stateResponse.json()}));
  addDivider("— project folder: " + result.path + " —");
}

const browseBtn = document.getElementById("browse");
const browserEl = document.getElementById("browser");
const browserPath = document.getElementById("browser-path");
const browserList = document.getElementById("browser-list");
let browsedPath = "";
let browsedBridge = false;

function browserEntry(label, onClick, className = "") {
  const div = document.createElement("div");
  div.textContent = label;
  div.className = className;
  if (onClick) div.addEventListener("click", onClick);
  browserList.appendChild(div);
}

async function browse(path, bridge = false) {
  const resp = await backendFetch(api("/browse?path=" + encodeURIComponent(path) + (bridge ? "&bridge=1" : "")));
  const result = await resp.json();
  if (!resp.ok) {
    projectError.textContent = formatFailure(result.failure, result.error);
    return;
  }
  projectError.textContent = "";
  browsedPath = result.path;
  browsedBridge = bridge;
  browserPath.textContent = result.path;
  browserList.replaceChildren();
  if (result.parent) browserEntry("..", () => browse(result.parent, bridge));
  for (const name of result.folders) {
    browserEntry(name + "/", () => browse(result.path.replace(/\/$/, "") + "/" + name, bridge));
  }
  if (!result.folders.length) browserEntry("(no sub-folders)", null, "empty");
  browserEl.hidden = false;
}

browseBtn.addEventListener("click", async () => {
  // start from the folder in the field; fall back to the current project folder
  await browse(projectInput.value);
  if (browserEl.hidden) browse("");
});
window.addEventListener("myharness:browse-bridge", () => { void browse("", true); });
document.getElementById("browser-cancel").addEventListener("click", () => {
  browserEl.hidden = true;
});
document.getElementById("browser-select").addEventListener("click", () => {
  browserEl.hidden = true;
  projectInput.value = browsedPath;
  setProject(browsedBridge);
});

setProjectBtn.addEventListener("click", () => { void setProject(); });
projectInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") setProject();
});

function addDivider(text) {
  const divider = document.createElement("div");
  divider.className = "reset-divider";
  const marker = "\n\nTechnical details: ";
  const split = text.indexOf(marker);
  divider.textContent = split < 0 ? text : text.slice(0, split);
  if (split >= 0) {
    const details = document.createElement("details"), summary = document.createElement("summary"), diagnostic = document.createElement("pre");
    summary.textContent = "Technical details";
    diagnostic.textContent = text.slice(split + marker.length);
    details.append(summary, diagnostic); divider.append(details);
  }
  messagesEl.appendChild(divider);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function resetMemory(dividerText) {
  const resp = await backendFetch(api("/reset"), { method: "POST" });
  memoryEl.textContent = (await resp.json()).memory;
  updateContextMeter(null);
  addDivider(dividerText);
  unlockConversation();
  refreshExplorer();
}

async function clearConversation() {
  const resp = await backendFetch(api("/reset"), { method: "POST" });
  memoryEl.textContent = (await resp.json()).memory;
  updateContextMeter(null);
  messagesEl.replaceChildren();
  terminalEl.textContent = initialTerminal;
  requestView.reset();
  unlockConversation();
  refreshExplorer();
  input.focus();
}

function renderTools(tools) {
  const list = document.getElementById("tool-list");
  list.replaceChildren();
  const families = [
    ["Files", ["pwd", "list_files", "read_file", "write_file", "edit_file", "delete_file", "move_file"]],
    ["Search", ["find_files", "search", "web_search"]],
    ["Git", ["git_status", "git_diff", "git_log", "git_branch", "git_checkout", "git_commit"]],
    ["Workflow", ["run_command", "update_plan", "use_skill", "get_current_time"]],
    ["Agents", ["spawn_agent", "list_agents", "get_agent_result", "restart_agent", "interrupt_agent", "send_message", "wait_agent"]],
    ["Goals", ["get_orchestration", "configure_goal", "get_goal", "update_goal"]],
  ];
  const groups = new Map();
  for (const tool of tools) {
    if (!goalsEnabled && [...families[4][1], ...families[5][1]].includes(tool.name)) continue;
    const family = tool.source === "mcp" ? (tool.server ? "MCP " + tool.server + ":" : "MCP resources:")
      : families.find(([, names]) => names.includes(tool.name))?.[0] || "Other";
    if (!groups.has(family)) {
      const column = document.createElement("fieldset");
      column.className = "tool-family";
      const heading = document.createElement("legend");
      const groupBox = document.createElement("input");
      groupBox.type = "checkbox";
      groupBox.className = "tool-group-checkbox";
      groupBox.title = "Turn every tool in '" + family + "' on or off at once. Each active tool's description is sent with every request, so fewer active tools means fewer input tokens.";
      groupBox.addEventListener("change", () => {
        for (const box of column.querySelectorAll(".tool-checkbox")) box.checked = groupBox.checked;
        syncToolGroups();
        saveSessionSettings();
        setTimeout(refreshExplorer);
      });
      const groupName = document.createElement("span");
      groupName.textContent = family;
      const groupLabel = document.createElement("label");
      groupLabel.append(groupBox, groupName);
      const cost = document.createElement("span");
      cost.className = "tool-group-cost";
      cost.title = "Estimated context tokens added on every request: selected tools / all tools in this group. Uses about four characters per token. Excludes call arguments and results; model-specific framing is extra. Turning Tools off adds none.";
      heading.append(groupLabel);
      if (tool.source === "mcp") {
        heading.className = "mcp-group";
        heading.title = tool.server
          ? "Tools reported by the MCP server '" + tool.server + "'. The harness forwards calls to the server and asks for approval. See Explore → MCP servers."
          : "Harness tools for reading MCP resources. Reads are not approved; the content enters the conversation.";
      }
      column.append(heading, cost); groups.set(family, column);
    }
    const label = document.createElement("label");
    label.className = "toggle tool";
    label.title = "What the model is told: \"" + tool.description + "\"\n\nWhen Tools is enabled and this tool is checked, its definition is added to the context on every request and costs ≈" + tool.tokens + " tokens.\nEstimated context cost, using about four characters per token. Excludes call arguments and results; model-specific framing is extra.";
    if (tool.source === "mcp") label.title += "\nMCP tools are off in new sessions: tick them to offer them to the model.";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.title = label.title;
    checkbox.className = "tool-checkbox";
    checkbox.value = tool.name;
    checkbox.dataset.tokens = tool.tokens;
    checkbox.checked = true;
    checkbox.addEventListener("change", saveSessionSettings);
    checkbox.addEventListener("change", syncToolGroups);
    label.append(checkbox, " ");
    const name = document.createElement("span");
    name.className = "help";
    name.textContent = tool.name;
    label.append(name);
    groups.get(family).append(label);
  }
  for (const column of groups.values()) {
    const labels = [...column.querySelectorAll("label.tool")];
    // every group folds into a scrollable drop-down
    const menu = document.createElement("details");
    menu.className = "tool-menu";
    const summary = document.createElement("summary");
    summary.title = "Show or hide this group's tools. The group checkbox above ticks or unticks all of them.";
    const items = document.createElement("div");
    items.className = "tool-menu-items";
    items.append(...labels);
    menu.append(summary, items);
    column.append(menu);
  }
  for (const [family] of families) if (groups.has(family)) list.append(groups.get(family));
  for (const [family, column] of groups) if (!families.some(([name]) => name === family)) list.append(column);
  toolCheckboxes = [...list.querySelectorAll(".tool-checkbox")];
  requestView.setToolTokens(new Map(toolCheckboxes.map(box => [box.value, Number(box.dataset.tokens)])));
  syncToolGroups();
}

// Group checkboxes and counts mirror the individual tool checkboxes (tri-state when partly ticked).
function syncToolGroups() {
  for (const column of document.querySelectorAll("#tool-list .tool-family")) {
    const boxes = [...column.querySelectorAll(".tool-checkbox")];
    const ticked = boxes.filter(box => box.checked).length;
    const groupBox = column.querySelector(".tool-group-checkbox");
    groupBox.checked = ticked === boxes.length;
    groupBox.indeterminate = ticked > 0 && ticked < boxes.length;
    groupBox.disabled = boxes.length > 0 && boxes[0].disabled;
    const totalTokens = boxes.reduce((sum, box) => sum + Number(box.dataset.tokens), 0);
    const selectedTokens = boxes.filter(box => toolsCheckbox.checked && box.checked).reduce((sum, box) => sum + Number(box.dataset.tokens), 0);
    column.querySelector(".tool-group-cost").textContent = "≈" + selectedTokens + " / ≈" + totalTokens + " tokens";
    const summary = column.querySelector("summary");
    if (summary) summary.textContent = ticked + " of " + boxes.length + " tools active";
  }
  updateActiveTools();
}
function updateActiveTools() {
  const boxes = [...document.querySelectorAll("#tool-list .tool-checkbox")];
  const active = boxes.filter(box => toolsCheckbox.checked && box.checked);
  const tokens = active.reduce((sum, box) => sum + Number(box.dataset.tokens), 0);
  document.getElementById("active-tools-count").textContent = active.length + " of " + boxes.length + " active";
  document.getElementById("active-tools-tokens").textContent = "≈" + tokens.toLocaleString("en") + " tokens sent with every request";
}

function initialize(data) {
  contextLength = data.context_length;
  session = data.session || {};
  orchestrationPanel.initialize(data);
  sessionEvents = session.events || [];
  agents = data.agents;
  prompts = data.prompts;
  locked = data.locked;
  projectInput.value = data.project;
  document.getElementById("model-name").textContent = data.model;
  initialTerminal = "----------------------------------------\nMODEL\n----------------------------------------\nModel: " + data.model + "  (working context: " + data.context_length + " tokens)\n\n";
  terminalEl.textContent = initialTerminal;
  requestView.reset();
  memoryEl.textContent = data.memory;
  renderTools(data.tools);
  fillSessionSelect(data.sessions, session.id);
  promptSelect.replaceChildren(new Option("none", ""));
  for (const p of prompts) {
    const option = new Option(p.name + " (~" + p.tokens.toLocaleString("en") + " tokens)" + (p.fits ? "" : " — too big for the context window"), p.name);
    option.disabled = !p.fits;
    promptSelect.add(option);
  }
  if (session.snapshots?.prompt?.name && !prompts.some(p => p.name === session.snapshots.prompt.name)) promptSelect.add(new Option(session.snapshots.prompt.name + " (saved with this session)", session.snapshots.prompt.name));
  if (session.snapshots?.agent?.name && !agents.some(a => a.name === session.snapshots.agent.name)) agents.push({name: session.snapshots.agent.name, source: "saved session", tools: session.snapshots.agent.value?.tools || []});
  fillAgentSelect();
  conversationLocked = Boolean(locked);
  if (locked) {
    promptSelect.value = locked.prompt;
    agentSelect.value = locked.agent;
    conversationLocked = true;
  }
  if (session.setup) {
    promptSelect.value = session.setup.prompt || "";
    agentSelect.value = session.setup.agent || "";
  }
  for (const checkbox of toolCheckboxes) checkbox.checked = (session.settings?.tools || toolCheckboxes.map(c => c.value)).includes(checkbox.value);
  toolsCheckbox.checked = toolCheckboxes.some(c => c.checked);
  syncToolGroups();
  askApprovalCheckbox.checked = session.settings?.ask_approval ?? true;
  memoryCheckbox.checked = session.settings?.use_memory ?? true;
  goalsCheckbox.checked = goalsEnabled && session.settings?.goals !== false;
  initialized = true;
  updateContextMeter(data.last_prompt_tokens || null);
  replaySession();
  setControlsDisabled(false);
  refreshExplorer();
}

Promise.resolve(window.MYHARNESS_READY).then(() => {
  window.addEventListener("myharness:state", event => initialize(event.detail));
  return backendFetch(api("/bootstrap"));
}).then(response => response.ok ? response.json() : Promise.reject(new Error("Could not load backend state."))).then(initialize).catch(error => {
  terminalEl.textContent = initialTerminal + "\nBackend unavailable: " + displayError(error);
});

document.getElementById("show-thinking").addEventListener("change", (e) => {
  const hide = document.getElementById("hide-thinking");
  hide.checked = !e.target.checked; hide.dispatchEvent(new Event("change"));
});
document.getElementById("hide-thinking").addEventListener("change", (e) => {
  messagesEl.classList.toggle("hide-thinking", e.target.checked);
  try { localStorage.setItem("hideThinking", e.target.checked ? "1" : ""); } catch {}
});

for (const el of [memoryCheckbox, toolsCheckbox, goalsCheckbox, askApprovalCheckbox, ...toolCheckboxes]) {
  el.addEventListener("change", saveSessionSettings);
}
exploreView.addEventListener("change", () => {
  try { localStorage.setItem("exploreView", exploreView.value); } catch {}
});

async function loadSelectedSession() {
  if (!sessionSelect.value || sessionSelect.value === session.id) return;
  try {
    const response = await backendFetch(api("/sessions/" + sessionSelect.value + "/activate"), {method: "POST"});
    const result = await response.json();
    if (!response.ok) throw responseError(result);
    location.reload();
  } catch (error) {
    sessionStatus.textContent = displayError(error) || "Could not load this session.";
    sessionSelect.value = session.id;
  }
}
document.getElementById("load-session").addEventListener("click", loadSelectedSession);
document.getElementById("new-session").addEventListener("click", async () => {
  if (window.MYHARNESS_NEW_SESSION) { await window.MYHARNESS_NEW_SESSION(); return; }
  const response = await backendFetch(api("/sessions"), {method:"POST", headers:{"Content-Type":"application/json"}, body:"{}"});
  if (!response.ok) { const data = await response.json(); sessionStatus.textContent = formatFailure(data.failure, data.error); return; }
  location.reload();
});
document.getElementById("rename-session").addEventListener("click", async () => {
  const name = prompt("Session name:", session.name); if (!name || !name.trim()) return;
  const response = await backendFetch(api("/sessions/" + session.id), {method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name})});
  if (!response.ok) { sessionStatus.textContent = "Save failed: " + displayError(error); return; }
  session = await response.json();
  const listing = await (await backendFetch(api("/sessions"))).json(); fillSessionSelect(listing.sessions, session.id);
});
document.getElementById("export-session").addEventListener("click", async () => { if (window.MYHARNESS_EXPORT_SESSION) await window.MYHARNESS_EXPORT_SESSION(session.id); else location.href = api("/sessions/" + session.id + "/export"); });
document.getElementById("import-session-picker").addEventListener("click", () => document.getElementById("import-session").click());
document.getElementById("import-session").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const response = await backendFetch(api("/sessions/import"), {method:"POST", headers:{"Content-Type":"application/json"}, body:await file.text()});
    const result = await response.json(); if (!response.ok) throw responseError(result);
    fillSessionSelect(result.sessions, session.id); sessionStatus.textContent = "imported";
  } catch (error) { sessionStatus.textContent = displayError(error); }
  e.target.value = "";
});

// Hydrate the session only after all renderer and control helpers exist.
if (session.settings) {
  memoryCheckbox.checked = session.settings.use_memory !== false;
  goalsCheckbox.checked = goalsEnabled && session.settings.goals !== false;
  askApprovalCheckbox.checked = session.settings.ask_approval !== false;
  for (const checkbox of toolCheckboxes) checkbox.checked = (session.settings.tools || []).includes(checkbox.value);
  toolsCheckbox.checked = toolCheckboxes.some(c => c.checked);
  syncToolGroups();
  try {
    const hideThinking = localStorage.getItem("hideThinking") === "1";
    document.getElementById("hide-thinking").checked = hideThinking;
    document.getElementById("show-thinking").checked = !hideThinking;
    messagesEl.classList.toggle("hide-thinking", hideThinking);
    exploreView.value = localStorage.getItem("exploreView") || "request"; syncInspectorTabs();
  } catch {}
  replaySession();
}

sendBtn.addEventListener("click", sendMessage);
stopBtn.addEventListener("click", () => {
  stopBtn.disabled = true;
  backendFetch(api("/stop"), { method: "POST" });
});
const confirmClear = document.getElementById("confirm-clear");
clearBtn.addEventListener("click", () => { confirmClear.hidden = false; document.getElementById("clear-cancel").focus(); });
document.getElementById("clear-cancel").addEventListener("click", () => { confirmClear.hidden = true; clearBtn.focus(); });
document.getElementById("clear-yes").addEventListener("click", () => { confirmClear.hidden = true; clearConversation(); });
resetBtn.addEventListener("click", () => resetMemory("— memory reset —"));
memoryCheckbox.addEventListener("change", () => {
  compactBtn.disabled = !memoryCheckbox.checked;
  if (memoryCheckbox.checked) addDivider("— harness memory on —");
  else resetMemory("— harness memory off: memory cleared —");
});
function fitInput() {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + 2 + "px";
}

input.addEventListener("input", fitInput);
input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (e.ctrlKey) {
    input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
    fitInput();
  } else {
    sendMessage();
  }
});

// Header menus: the sessions list and the settings drawer open next to their buttons and close with Escape.
const sessionsBtn = document.getElementById("sessions-btn");
const sessionsPanel = document.getElementById("sessions-panel");
const settingsBtn = document.getElementById("open-settings");
const settingsDrawer = document.getElementById("settings-drawer");
function placeSessionsPanel() {
  const r = sessionsBtn.getBoundingClientRect(), vw = document.documentElement.clientWidth;
  sessionsPanel.style.top = Math.round(r.bottom + 6) + "px";
  if (vw < 760) { sessionsPanel.style.left = "16px"; sessionsPanel.style.right = "16px"; sessionsPanel.style.width = "auto"; }
  else { sessionsPanel.style.left = "auto"; sessionsPanel.style.width = ""; sessionsPanel.style.right = Math.max(16, Math.round(vw - r.right)) + "px"; }
}
function setSessionsOpen(open) {
  if (open) placeSessionsPanel();
  sessionsPanel.hidden = !open; sessionsBtn.setAttribute("aria-expanded", String(open));
  if (open) document.getElementById("close-sessions").focus(); else sessionsBtn.focus();
}
function setSettingsOpen(open) {
  settingsDrawer.hidden = !open; settingsBtn.setAttribute("aria-expanded", String(open));
  if (open) document.getElementById("close-settings").focus(); else settingsBtn.focus();
}
sessionsBtn.addEventListener("click", () => setSessionsOpen(sessionsPanel.hidden));
document.getElementById("close-sessions").addEventListener("click", () => setSessionsOpen(false));
settingsBtn.addEventListener("click", () => setSettingsOpen(settingsDrawer.hidden));
document.getElementById("close-settings").addEventListener("click", () => setSettingsOpen(false));
window.addEventListener("resize", () => { if (!sessionsPanel.hidden) placeSessionsPanel(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!sessionsPanel.hidden) setSessionsOpen(false);
  else if (!settingsDrawer.hidden) setSettingsOpen(false);
});

# myharness: handover

Read this first if you are taking over this project. It says what exists, how it works, what was
learned the hard way, and what to do next.

## 1. What this project is

An **educational local LLM coding-agent harness**. The owner (Manu) wants to *see* everything a
harness does: what is sent to the model, what comes back, token costs, memory, tools, prompts.
So every feature should be **visible in the GUI and explained in tooltips**. Explanations matter
more than polish.

- Runs against **Ollama**, installed natively on **Windows**; the code runs in **WSL2** and reaches it
  at `http://localhost:11434`. Models are stored on `D:\Users\emman\.ollama\models` (C: is nearly full).
- Hardware: RTX 3060 12 GB. One 7-8B model fits at a time.
- Current model: **`qwen3:8b`** (40,960-token context; it "thinks" before answering).
  Also pulled: `qwen2.5:7b` (used by the CLI `harness.py`), `qwen2.5-coder:7b` (do not use: it writes
  tool calls as plain text, 0/5 real tool calls through Ollama).

## 2. Layout

```
harness.py            original CLI (kept as the minimal reference; do not change)
web.sh                starts Ollama (+ loads model) then the web app; prints http://localhost:5000
ollama.sh             start | stop | status for Windows Ollama from WSL2
web/app.py            Flask backend (~870 lines): everything server-side
web/templates/index.html   the whole UI: HTML + CSS + JS in one file (~1,000 lines)
web/static/           marked.min.js, purify.min.js (Markdown + sanitizer, vendored)
agents/*.md           personas (coder, pirate)
skills/<name>/SKILL.md   skills (run-python-tests, write-readme)
prompts/*.md          6 real product system prompts from github.com/asgeirtj/system_prompts_leaks
workspace/            default project folder (sample notes.txt)
settings.json         remembered project folder (git-ignored)
OLLAMA.md, PYTHON_HARNESS.md   notes
```

Run: `./web.sh`, open http://localhost:5000. Python env is `.venv` (Flask, requests).

## 3. Architecture

Flask serves one page. `POST /chat` streams newline-delimited JSON events; the page renders them.
The server holds all state in module globals (single user): `messages` (the "memory"),
`conversation_setup`, `workspace`, `pending_approvals`, `stop_requested`.

**The agent loop** (`chat_endpoint` -> `generate()` in `web/app.py`): up to `MAX_STEPS` (20) calls to
Ollama `/api/chat` (streaming). If the reply has `tool_calls`, the harness runs them, appends
`{"role":"tool",...}` messages, and calls the model again. Stops when a reply has no tool calls.

**Event types** streamed to the page: `request`, `thinking`, `chunk`, `response`, `tool`,
`approval`, `change`, `command`, `skill`, `stopped`.

**What a request contains** (in order): system message = library prompt + agent text + skill list
(only if `use_skill` is checked); then `messages`; plus the `tools` field for checked tools.
The system message is rebuilt every request and never stored in memory. Thinking is shown but not
stored.

**GUI** (3 regions + bars):
- Settings bar: System prompt, Agent, Project folder (+ Browse).
- Left: chat (Markdown, thinking bubbles, diff/approval boxes), input (Enter sends, Ctrl+Enter new
  line), checkboxes: Harness memory, Hide thinking, Tools (+ one per tool), Ask before changes and
  commands; buttons Reset memory, Clear conversation, Send/Stop.
- Right: "Internals": SENT (orange, new user message bold red) / RECEIVED (green, model message bold
  blue) / TOKENS / TOOL / FILE CHANGE / COMMAND blocks.
- Bottom: **Explore** selector: harness memory, system prompt, agent, tools, skills, model template,
  final prompt.
- Two draggable dividers (vertical and horizontal), positions kept in localStorage.

## 4. Features and their rules

| Feature | Behavior worth knowing |
|---|---|
| Memory checkbox | Off = only the new message is sent and **nothing is stored**; turning it off clears memory. |
| System prompt + agent | Chosen **once per conversation**, locked after the first message (with memory on); unlocked by Reset memory / Clear conversation. Reason: changing them mid-conversation confuses the model and invalidates Ollama's prompt cache. |
| Agents | `agents/*.md` in myharness **and** `agents/` in the project folder (project overrides). Optional header `tools: a, b` then `---`. Choosing an agent ticks its tools. Read on every call (no restart needed). |
| Tools | `get_current_time, pwd, list_files, read_file, write_file, edit_file, run_command, use_skill`. File tools are confined to the project folder (`workspace_path()`). |
| write/edit | They only *prepare* `(file, new_content, note)`; `apply_change()` shows a diff, asks approval, writes. `edit_file` needs `old_text` to match exactly once. |
| run_command | `bash -c` in the project folder, 60 s timeout, output cut to last 10,000 chars, new session so Stop/timeout kills children. **Not confined to the project folder**; approval is the real protection. |
| Approval | Checkbox "Ask before changes and commands", on by default. Deny/Stop is returned to the model as the tool result. |
| Stop | Sets `stop_requested`; closes the Ollama stream; remaining tools get a "stopped" result so the next request is consistent. |
| Skills | `skills/<name>/SKILL.md` (front matter `name`, `description`). Only name+description go in every request; the model loads the rest via `use_skill`, or the user types `/name`, which expands the skill into the user message. |
| Explorer "final prompt" | A Python re-implementation of qwen3's Ollama template (`render_qwen_prompt`). Matches Ollama's token counts exactly for system+conversation; each tool description within 1 token. |

## 5. Hard-won lessons (do not rediscover these)

1. **Models double-escape tool-call JSON**: `content` arrives with literal `\n` instead of line
   breaks (qwen3 does this sometimes). `unescape()` in `write_file`/`edit_file` repairs it and the UI
   shows a note. Always show the diff before writing.
2. **Indentation mistakes** are a *model* issue, not a harness bug (it anchors on an indented line
   and keeps that indent). Mitigation: `run_command` so the model runs the code; coder agent rule to
   run after changing.
3. **Switching agent mid-conversation** leaves tool calls in history that the new agent can't make;
   the model then hallucinates or writes `<tool_call>` as text. Hence the lock.
4. **Ollama keeps a prompt cache** for the identical *beginning* of the prompt; changing the system
   message or the tool set invalidates all of it.
5. **qwen3 tools in the prompt are not JSON**: Ollama 0.35 prints them in Go's default struct format
   (`{name desc {object <nil> <nil> [required] map[prop:{[type] <nil> desc}]}}`). Found by matching
   token counts; there is no Ollama API to return the rendered prompt.
6. Flask does **not** reload `app.py` (`use_reloader=False`): after Python changes the owner must
   restart `./web.sh`. Templates reload; the browser tab needs Ctrl+Shift+R.
7. Context overflow is **silent**: Ollama drops the *start* of the prompt (the system message).
   Nothing in the harness handles this yet (see section 7).
8. A 7-8B model sometimes returns an **empty reply** or skips a skill; the UI shows nothing (see
   section 7).
9. `qwen3:8b` first request after load can take ~45 s.

## 6. How to test (important)

The owner usually has the real harness running on **port 5000 with a conversation in memory**.
**Never stop it, restart it, `pkill` it, or send messages to it.** Test on **port 5001**:

```bash
cd web
cat > /tmp/run5001.py <<'EOF'
import sys; sys.path.insert(0, "/home/streamingboss/code/myharness/web")
import app
from pathlib import Path
app.SETTINGS_FILE = Path("/tmp/settings_test.json")   # don't touch the real settings.json
app.MODEL = "qwen3:8b"
app.context_length = app.get_context_length(app.MODEL)
app.app.run(port=5001)
EOF
../.venv/bin/python /tmp/run5001.py &     # then kill that exact PID when done
```
Drive it with `curl`/`requests` against `/chat` (NDJSON), `/approve`, `/stop`, `/reset`, `/explore`,
`/project`. For UI checks use headless Chrome (`google-chrome --headless=new --screenshot`, or the
remote-debugging port with a small Node websocket script for real clicks/drags) and
`node --check` on the extracted `<script>`. Use a scratch project folder, never the owner's repo
(`/home/streamingboss/code/harnesstestrepo` is theirs). Run tests on the model with several
repetitions: a single run proves little.

## 7. State and what to do next

**Git:** work is committed up to the `run_command` commit. **Staged but not committed**: skills
(`skills/`), `agents/coder.md`, and the latest `web/app.py` / `index.html` changes (explorer,
skills, `MAX_STEPS` 5 -> 20). The owner commits themselves; do not commit unless asked.

**Approved plan, not started** (see `/home/streamingboss/.claude/plans/so-maybe-we-start-mellow-beacon.md`
if present; otherwise this is the full content). Build in this order, test each:

A. **Search tools + better `read_file`.** `read_file(path, start_line, end_line)` returning numbered
   lines and a "continue from line N" hint when cut. `find_files(pattern)` (fnmatch, max 200).
   `search(pattern, path, glob)` plain-text, `file:line: text`, max 100, skip `.git .venv
   node_modules __pycache__` and binary files. All read-only (no approval), confined to the project
   folder. Add to `coder.md`.

B. **AGENTS.md**: read `AGENTS.md` (else `CLAUDE.md`) from the project root on every call; add
   `# Project instructions (AGENTS.md)` to the system message after the agent text, before the skill
   list; new explorer view "harness project file". Keep `/explore` and `/chat` building the system
   message through the same `system_messages()` so the explorer stays exact.

C. **Context management**: live meter in the chat header from Ollama's real `prompt_eval_count`
   (amber 75%, red 90%); **trim** old tool outputs to stubs past 75% (never the last 4 messages);
   **Compact** button + automatic at 90% (the model summarizes older turns; replace them with one
   summary message; show the request in the right pane); if still too big, stop the turn with a
   clear message instead of sending. Test with a tiny window (~3,000) via `app.context_length`.

**Smaller follow-ups the owner may want:**
- Show "the model returned an empty reply" plus a **Retry** button (an empty reply looked like a
  hang in the owner's last session; I could not reproduce the skill not being picked, 6/6 runs
  picked `write-readme`; likely `use_skill` was unchecked or a one-off empty reply).
- Offer **skill loading by plain file read** as an alternative to the `use_skill` tool (Pi's prompt in
  `prompts/pi-coding-agent.md` does it that way); a "Skill loading" setting to compare both.
- `bettercoder` agent in the owner's `harnesstestrepo/agents/` lacks `write_file, edit_file,
  run_command` in its `tools:` line.
- Placeholders `{model_name}` / `{{ personality }}` in library prompts are sent literally.

**Longer roadmap:** task-list tool; git auto-commit/undo per turn; permission rules ("always allow
`python3 *`"); saved sessions; sub-agents; model dropdown / other providers / side-by-side
comparison; MCP and a web-fetch tool; split `app.py` and `index.html`; add automated tests.

## 8. Working style the owner expects

- **Build exactly what is asked**; no invented extras. When a request has two readings, ask with a
  short preview rather than guess (the owner reacted strongly when a display was "improved").
- Educational first: tooltips on every setting, real data shown, no hiding.
- Short answers; state results plainly; say what was and wasn't tested (headless Chrome is not the
  owner's browser).
- Remind them after Python changes: restart `./web.sh`, hard-reload the tab.
- No attribution lines in commit messages.

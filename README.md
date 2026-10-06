# myharness

Describe your task in chat. The master can use `get_orchestration` to inspect host
permissions and ceilings, then `configure_goal` to choose an objective, completion
criteria, deadline, round limit and shared request budget. It can choose child tasks,
permitted tools, connected model routes and timeouts through its delegation tools.
The current chat turn becomes the first goal round; backend continuation never
replays the initial task. Request usage starts with the first model request and
settings changes cannot reset it or extend a running deadline.

**Under the hood** opens a read-only inspector, hidden by default. It shows the
chosen goal settings, each child's task/model/status, elapsed time, deadline,
partial output, results and attempt history. A running-child count stays visible.
Users can stop one child or the entire run; the master manages restarts and follow-ups.
Approvals have a visible indicator even with the inspector closed. Closing the
inspector does not stop work. Completion is the model's claim: inspect its evidence.

Subagents are **disabled by default**. Hosts configure delegation through
`MYHARNESS_ALLOW_SUBAGENTS=true` or `false`, or the callable settings interface.
Child tool grants and model routes remain host permissions, outside session authority;
the master cannot expand them. Read-only child tools are the default. Granted effects
inherit the master's approval policy; unanswered approvals deny effects. Children
inherit the master model, including cloud providers. Alternative routes require
host authorization and available credentials; keys remain ephemeral. Children have
isolated conversation memory and cannot delegate further children.

Default ceilings: 5 minutes per child attempt, 30 minutes per master goal, three
concurrent children, ten goal rounds and 200 shared model requests. Deadlines include
tools, approvals and child waits. The ordinary per-turn tool-loop limit remains twenty.
Set `MYHARNESS_ORCHESTRATION_LIMITS` to a JSON object with any of `masterTimeoutMs`,
`childTimeoutMs`, `maxRounds`, `maxRequests`, `maxConcurrentChildren` to override host
ceilings. Callable Node and browser backends accept the same `orchestrationLimits`
option. These are host settings, not editable fields in the inspector.

Restoring a session preserves history without restarting pending work. A new user
turn can authorize further work; the master cannot resume cancelled work by itself.
Imports do not grant child permissions.

Headless usage: `npm run headless:ts -- "Inspect the project and verify its README"`.
The CLI waits for master-configured continuation and denies approvals unless
`--approve` is supplied. Existing explicit `--goal` and callable goal/child interfaces
remain supported. Observers never advance execution; Node and browser reuse the
shared backend.

## What you can explore

| Harness behavior | What you can see and change |
| --- | --- |
| Memory | The retained messages, re-sent on each request; compare memory on and off. |
| Instructions | A base prompt, agent persona and project `AGENTS.md`, composed into the system message. |
| Tools | The definitions sent to the model, its requested calls, and the results the harness sends back. |
| Skills | Short descriptions offered to the model, then full instructions loaded on demand. |
| MCP | External servers add tools, instructions, resources and prompts; each call is approved and its JSON-RPC exchange shown. |
| Approvals | File diffs and shell commands before you approve or deny them. |
| Context | Measured input tokens, estimated pressure, trimmed tool output and visible summary requests. |
| Sessions | Saved transcript, retained memory and instruction snapshots; reset memory while keeping the transcript visible. |

The bottom **Explore → tokenization of a saved request** view can inspect individual model calls. It shows token pieces and IDs where a configured/provider tokenizer exposes them, and explicitly explains count-only or unavailable results. See [TOKENIZATION.md](TOKENIZATION.md) for Ollama tokenizer setup, remote Gemini configuration, and exactness limits.

The **Chat** pane shows answers and actions. **Internals** shows the API exchange
and tool effects. **Explore** shows the pieces used to build a request, the model's
Ollama template, and an illustrative Qwen prompt reconstruction. Hover over the
controls for explanations.

## Run entirely in the browser

Build and serve the browser edition with Node.js 20.19 or later:

```bash
npm ci
npm run start:browser
```

Open **http://localhost:5001**. This server serves static files only: the full
harness backend runs in a Worker on your browser's machine. Choose a real model
provider and click **New Session**. Local Ollama is selected
by default. Cloud providers show an API-key field; Ollama shows its server URL. The model
picker lists installed Ollama models or loads account models after you enter a
cloud API key. Changing the provider, URL or API key refreshes the choices.
The backend supplies the context and response budgets, so no model-limit settings
are needed in the browser toolbar. Existing scripted-demo sessions remain saved,
but startup opens a new Ollama session instead of resuming a demo.

To distribute it, run `npm run package:browser` (requires the `zip` command).
The resulting **`dist/myharness-browser.zip`** contains a standalone static site
and backend SDK. Unzip it and serve that folder through HTTP(S), for example
`python3 -m http.server 8000`. No Node or Python backend is required by recipients;
any static hosting works. Opening `index.html` through `file://` is unsupported.
All rendering assets are bundled; inference uses your selected model provider.

### Work with local code

**Open local folder…** grants the backend direct access to a folder on the
machine running the browser. Reads inspect its current files; approved writes
and edits write back to disk. The backend rejects edits if the file changed
externally while waiting for approval. Supporting browsers require a secure
context (HTTPS or localhost) and a user gesture. Chrome and Edge support the
[File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).
Permissions can expire: open the folder again when prompted.

**Import folder copy** creates a virtual text project
in browser storage. Changes to these copies do not modify the original folder;
use **Export session** to save a conversation with its project workspace path.
Folder copies skip binary/non-UTF8 files. Direct access reads UTF8 text up to
10 MiB per file and skips dependency directories.
A browser page cannot start programs, so the browser edition does not offer
`run_command`, and it does not offer `web_search` (DuckDuckGo refuses requests from web
pages). Tools a runtime cannot run are left out of the tool list rather than shown
disabled. When you open a local folder that contains a `.git` directory, the git tools
below work in the browser too, through [isomorphic-git](https://isomorphic-git.org). Use
the Node edition when you need shell commands.

### Files, plans and git

Besides reading, searching and writing files, the model has these tools. Everything that
changes something asks for approval first and shows what will happen:

- **`delete_file`** and **`move_file`** act on one file (never a folder). A deletion shows
  the removed lines; a move shows `from -> to`.
- **`update_plan`** lets the model write its steps down and tick them off. It changes
  nothing; the plan appears as a checklist in the chat.
- **`git_status`**, **`git_diff`** and **`git_log`** only read, so they do not ask.
- **`git_branch`** lists branches, or creates one when given a name. **`git_checkout`**
  switches to an existing branch and fails rather than overwrite uncommitted work.
  **`git_commit`** stages the given paths (default: every change) and commits what is
  staged; its approval shows the message, the files and the diff first.

There is no push, pull or clone. In the Node edition git is the real `git` program, run
without a shell in the project folder: repositories above the folder are ignored, hooks do
not run, and nothing can prompt for a password. In the browser edition isomorphic-git reads
the same repository without a git program. It reads only the repository's own
`.git/config`, so set `user.name` and `user.email` there before the model commits; it
is stricter than git about switching branches with uncommitted changes, and it compares
file contents on every status, so it is slower on large repositories.

### Connect a real model

Choose **Local Ollama**, enter its URL and model name, then start a new session.
Ollama performs inference outside the browser; the harness, tools and approvals
still run inside it, including direct access to your selected local-code folder.
Install and start Ollama and pull a model as described below. Configure
`OLLAMA_ORIGINS` on your Ollama server to allow the exact page origin, for example
`http://localhost:5001`; see the [Ollama FAQ](https://docs.ollama.com/faq).
For a site served through HTTPS, browser network policies may also restrict
connections to local HTTP services. Connection failures appear in the toolbar.
Accept any browser local-network permission prompt for your Ollama server.

Sessions, virtual projects and granted directory handles are saved in IndexedDB,
scoped to this site's origin and browser profile. Changing the host or port uses
different storage. Clearing site data removes these saves. **Export session**
saves the full conversation transcript, current model memory, frozen instructions
and project workspace path (`workspace`). Use **Import Session** in the Session section
to restore an exported session. Memory reset and compaction do not erase the saved
transcript.

## Run the Node backend locally

Use Node.js 20.19 or later, Bash and a local [Ollama](https://ollama.com/) server.
The shell tool needs a Linux/WSL environment with process-group support.
Install Ollama using its [official instructions](https://docs.ollama.com/quickstart).
Then, from this repository:

```bash
npm ci
ollama pull qwen3:8b
```

Make sure Ollama is listening at `http://localhost:11434`. If it is not already
running, start `ollama serve` in another terminal. Launch the harness:

```bash
npm run start:ts
```

Open **http://localhost:5001**. Choose a scratch project folder for your first
experiment. Model loading and generation speed depend on your hardware; the
first request can take longer.

`web.sh` and `ollama.sh` are convenience scripts for the owner's Windows/WSL
installation. `web.sh` now starts TypeScript on port 5000, or `MYHARNESS_PORT`.
The Ollama script contains a machine-specific Windows path; the commands above
are the portable setup. Windows/WSL localhost connectivity depends on your WSL
network configuration.

## A five-minute experiment with Ollama

1. Leave Harness memory on. Say “My favourite number is 42”, then ask what it is.
   Compare the two SENT blocks: the harness sends the earlier exchange again.
2. Turn memory off and ask the same question. Inspect the shorter request.
   Turning memory off in the UI resets retained memory.
3. Enable `pwd`, `list_files` and `read_file`. Ask the model to inspect a file
   in your scratch folder. Follow the tool call, result and next model request.
4. Enable `write_file` and keep approvals on. Ask for a small file, inspect the
   proposed diff and deny it. See the denial sent back as a tool result.
5. Enable `use_skill`, or type `/write-readme` followed by a request. Explore
   the difference between a skill's description and its loaded instructions.

Tools are requests from the model; the harness executes them. A model may fail
to request the intended tool. The internals make that difference visible.

## Use the backend without the UI

The browser distribution includes `headless.html`, which starts a backend Worker
and exposes `window.harness` without loading the UI. Its public SDK exports
`WorkerClient`, `BrowserHarness`, `BrowserStorage`, `DemoModel` and `OllamaAdapter`.
See [ARCHITECTURE.md](ARCHITECTURE.md) for a callable browser example.

The direct runner starts the full backend and prints NDJSON events. It requires
a configured model provider, but no HTTP server or browser. It denies changes and commands by default:

```bash
npm run headless:ts -- "List the project files" --tools pwd,list_files
```

Use `--approve` to approve every requested change and command for that invocation.
`Ctrl+C` requests cancellation. `--reset` clears retained memory; `--compact`
summarizes it. The runner restores the latest saved session. Use separate
`MYHARNESS_SESSIONS` directories when running more than one backend process.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the core interface and HTTP endpoints.

Configuration uses `MYHARNESS_MODEL`, `OLLAMA_URL`, `MYHARNESS_WORKSPACE`,
`MYHARNESS_SESSIONS`, `MYHARNESS_SETTINGS`, `MYHARNESS_MCP`, `MYHARNESS_ROOT` and
`MYHARNESS_PORT`. Defaults are `qwen3:8b`, `http://localhost:11434`, the saved
project or `workspace/`, `sessions/`, `settings.json`, `mcp.json`, the current
directory and port 5001.

## Web search

The `web_search` tool searches the web with DuckDuckGo and returns the top five
results (title, URL, snippet) to the model. It is free and needs no account or key.
DuckDuckGo has no official search API, so the harness reads its plain HTML results page
(ads skipped): a layout change or a bot check makes the tool answer with an error rather
than guess. Only the query leaves your computer. Like `read_file`, a search does not ask
for approval, and the query and results are visible in the chat. It is Node-only; the
browser edition reports it unsupported.

## Connect MCP servers

[MCP](https://modelcontextprotocol.io) servers give the harness more tools without
changing its code. List them in `mcp.json` in the harness folder, or in the file
named by `MYHARNESS_MCP`. The format is the common `mcpServers` object:

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/demo"] },
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
    "old": { "type": "sse", "url": "http://localhost:8080/sse" },
    "later": { "command": "my-server", "disabled": true }
  }
}
```

`command` starts a local stdio server (`args`, `env` and `cwd` are optional); `url`
connects over Streamable HTTP, and `"type": "sse"` uses the deprecated 2024-11-05
HTTP+SSE transport. `${NAME}` and `${NAME:-default}` read environment variables.
The file is read at startup and by **Explore → MCP servers → Reload**, never from
the project folder, so opening a project cannot start processes.

The harness speaks every published MCP revision: the stateless 2026-07-28 protocol
(`server/discover`, metadata on every request) and the older `initialize` handshake
(2025-11-25 back to 2024-11-05), detecting which one each server uses. What a server
reports becomes visible harness behavior:

- **Tools** appear below the chat as `mcp__<server>__<tool>`, grouped by server and
  unticked in new sessions. Ticked tools are sent to the model like harness tools.
  Every call asks for approval while approvals are on, because the harness cannot
  see what an external tool does; the server's hints (such as `readOnlyHint`) are
  shown but not trusted.
- **Instructions** from a server join the system message while its tools are ticked.
- **Resources** are read through `list_mcp_resources` and `read_mcp_resource`.
- **Prompts** run as slash commands: `/mcp__<server>__<prompt> arguments…`.

**Explore → MCP servers** shows each server's status, protocol revision, tools,
prompts, warnings, recent stderr and the JSON-RPC wire log. Internals shows each
call's request and response. Static `headers` cover token authentication; OAuth
sign-in, sampling, elicitation, roots and change subscriptions are not supported.

**Explore → MCP servers → Find MCP servers…** searches an MCP registry, chosen in the
dialog: [GitHub's registry](https://api.mcp.github.com) (the one VS Code uses; curated,
most-starred first, the default) or the official
[MCP Registry](https://registry.modelcontextprotocol.io). A registry lists servers,
not tools: a server's tools are only known once the harness connects to it.
**Preview tools** connects once to a remote server, lists its tools, prompts and
resources and disconnects, without calling anything. Packages (npm, PyPI, Docker,
NuGet) are never run for a preview. If the server requires authentication, enter
the full value (for example, `Bearer <token>`) in **Authorization header (optional)**.
The field is cleared after sending and the value is used only for that preview;
OAuth sign-in is not supported. Configure headers separately to use the server
in conversations. **Show configuration** gives the `mcpServers`
entry to paste into your configuration file, with `${NAME}` placeholders and notes
for the keys or arguments it needs. Registry entries are published by their
authors and not reviewed: check what a command runs before adding it.

After **Show configuration**, edit the configuration fields as needed, then choose
**Add to harness** to add the entry to the harness config, replacing any same-named server entry, then reload servers.
The **Authorization header to save** field accepts the full header value if a token
is needed. Node stores it in the configured MCP file; browser headers stay in memory.
Adding a package starts its command.

**Explore → MCP servers → MCP configuration JSON** shows the active configuration
source and its editable JSON. This view works independently of the model provider.
In the browser edition, the source is browser storage, rather than a filesystem
`mcp.json`. With the local `npm run start:browser` server, edits, additions and
imports also print the browser storage location and current JSON (including
in-memory authentication headers) in that server's terminal.

In the browser edition, **Import MCP config** loads the same file. The Worker can
reach HTTP servers that allow the page origin and the MCP headers (CORS); stdio
servers are reported unsupported. Header values stay in Worker memory and are not
saved, so import the file again after reloading.

## Gemini, OpenAI and Claude

The browser toolbar connects directly from its Worker to the selected provider.
Enter your provider API key, select a model and connect. Connecting refreshes the
page state without reloading. The key input clears immediately, and keys stay in
Worker memory: sessions, IndexedDB, exports and inspection events contain no
credentials. **Forget API key** removes the active provider credential. After a
reload, saved cloud transcripts remain inspectable; enter the key again to chat
or compact. Reconnecting the same model and limits keeps the current session.
Changing the provider, model or limits starts a new session while idle.

Gemini defaults to `gemini-3.8-flash`; `gemini-3.5-flash-lite` is another selection.
OpenAI and Claude require an explicit API model ID available on your account.
Paid API usage is billed to your provider account. Quota and model access depend
on that account; the harness never retries generation or substitutes a model.

For Node/headless execution, set `MYHARNESS_PROVIDER` to `gemini`, `openai` or
`anthropic`, with the matching `GEMINI_API_KEY`, `OPENAI_API_KEY` or
`ANTHROPIC_API_KEY`. Node HTTP configuration uses these server credentials and
rejects API keys in its configuration body. For example, with your key already
in the environment:

```bash
MYHARNESS_PROVIDER=gemini MYHARNESS_SESSIONS=/tmp/myharness-demo-sessions \
  npm run headless:ts -- "Read README.md" --tools read_file
```

Set `MYHARNESS_MODEL` for another model. Cloud defaults are a working context of
8,192 tokens and at most 2,048 output tokens, editable in advanced settings or via
`MYHARNESS_CONTEXT_LENGTH` and `MYHARNESS_MAX_OUTPUT_TOKENS`. The working context
is the harness budget, separate from the provider's physical limit; output space
is reserved when checking pressure. Ollama retains metadata discovery and its
configurable `OLLAMA_URL`. The existing Vertex adapter remains available through
`MYHARNESS_PROVIDER=vertex` and its Google Cloud environment credentials.

Compaction is an additional request to the selected model, without tools, with
up to 2,048 output tokens. Empty, interrupted, limited or ineffective summaries
leave memory unchanged. Stop aborts requests and denies pending approvals.
SENT shows the provider body without authentication headers; RECEIVED shows
assembled native data, normalized calls and measured usage. Unavailable usage
counts display as unknown. Provider thinking and summaries are shown only when
exposed by the API. Internal cloud prompt templates are unavailable.

These adapters use the native [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview),
[OpenAI Responses API](https://developers.openai.com/api/docs/guides/reasoning) and
[Claude Messages API](https://platform.claude.com/docs/en/build-with-claude/streaming).
Text, harness function tools and MCP tools are supported. Media, hosted tools and
advanced reasoning controls remain subsequent features. Authenticated cloud
browser and headless checks have not been performed; deterministic tests use
scripted provider responses.

## Scope and limits

This is a local, single-user learning tool. The HTTP service has no authentication;
keep it on localhost. File tools check that resolved paths stay in the chosen
project folder. Shell commands run with your account's permissions and are not
sandboxed; approvals are on by default. Missing approval responses deny the action.
MCP stdio servers also run with your permissions, and MCP tools can do whatever
their server does; configure only servers you trust.

SENT contains the actual model API payload. RECEIVED combines streamed content
and thinking with the final statistics. The prompt reconstruction is illustrative,
not a capture of Ollama's internal rendered text. Token estimates use character
counts; the context meter uses Ollama's measured input count in real-model mode
and a labelled demo estimate in scripted mode. Summaries are lossy.
Displayed thinking is model-provided text, not a guarantee of its internal reasoning.

Prompt-library files are community-collected examples from
[system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks), with
unverified product attribution. Selecting one sends its text literally, including
any placeholders. These examples do not reproduce those products' tools or behavior.
Sessions and exports may contain messages, file contents, command output and local
paths; inspect them before sharing. Exports do not bundle project files.

## Development and further reading

- [ARCHITECTURE.md](ARCHITECTURE.md): backend boundaries, interface and current limitations.
- [TESTING.md](TESTING.md): deterministic verification and coverage gates.
- [PYTHON_HARNESS.md](PYTHON_HARNESS.md): memory and context in the minimal CLI reference.
- [HANDOVER.md](HANDOVER.md) and [AGENTS.md](AGENTS.md): contributor and operating rules.

Install development checks, including the Python parity reference and Chromium:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
npx playwright install chromium
npm run coverage:ts
.venv/bin/python -m coverage run -m unittest discover -s tests
.venv/bin/python -m coverage report -m
```

The TypeScript backend and Python test reference have enforced 100% line and
branch coverage. Python is only needed for development parity checks or the
unchanged minimal `harness.py` example. The retired full backend lives under
`tests/python_reference/`; it is no longer a supported application runtime.
The browser edition runs both UI and backend on the learner's machine. The Node
edition remains available for shell tools, the HTTP API and the terminal runner.

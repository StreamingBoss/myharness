# Contributor handover

Read [AGENTS.md](AGENTS.md) before editing. This project teaches what a harness
adds to an LLM: make behavior visible and explain it. Public setup is in
[README.md](README.md); boundaries are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Maintained implementation

- `typescript/src/execution.ts` and `Harness` orchestration: backend-driven goal rounds,
  independent child attempts, elapsed-time deadlines, shared request budgets and effects.
  Global `allowSubagents` defaults off; `MYHARNESS_ALLOW_SUBAGENTS` locks the Node host
  override. Child grants/routes persist outside session authority. Restarts keep child
  memory and resolve current credentials; timeouts retain partial output/history.
- `web/static/orchestration.js`: hidden read-only goals/subagent inspector, live counts,
  results, Stop and approvals. The master selects settings with `get_orchestration`
  and `configure_goal`; host ceilings live in `orchestration-limits.ts`. Ordinary
  user turns can be adopted without replay, with request usage retained from the
  first request. UI visibility never controls execution or grants permissions.

- `typescript/src/core.ts`: strict, transport-free agent loop and runtime contract.
- `typescript/src/harness.ts`: shared session backend with tools, approvals,
  cancellation, catalogs, snapshots, state inspection and context management.
- `typescript/src/node/`: model, filesystem, persistence, startup, HTTP and CLI adapters.
- `typescript/src/browser/`: Worker transport, public client, IndexedDB, virtual
  workspace/local-directory adapters and scripted/optional Ollama models.
- `typescript/ui/browser.ts`: browser controls; no harness decisions.
- `scripts/build-browser.mjs`, `serve-browser.mjs`, `package-browser.mjs`:
  standalone static browser distribution and ZIP packaging.
- `typescript/src/format.ts`: runtime-independent request/memory/prompt formatting.
- `typescript/src/mcp/`: hand-written MCP client (all revisions), HTTP channels
  and the manager that turns servers into tools, instructions, resources and prompts.
  `typescript/src/node/mcp-stdio.ts` is the Node-only stdio channel.
- `typescript/src/tokenization.ts`, `llama-tokenizer.ts`, `gemini.ts`: PR #1's
  evidence types, optional model-bound tokenizers and Node Gemini provider.
- `web/static/tokenization.js`: view-only saved-request token inspector, with
  Worker and HTTP transports. Scripted demo counts must remain labelled estimates.
- `web/templates/index.html` and `web/static/`: static UI and vendored renderers.
- `agents/`, `skills/`, `prompts/`: inspectable instruction examples.
- `tests/python_reference/`: retired Python implementation used only as a parity oracle.
- `harness.py`: unchanged minimal reference; do not change without explicit instruction.

Phase 3 is complete. Phase 4 provides `npm run start:browser` and
`npm run package:browser`. `web.sh` retains the owner's Node/Ollama launcher.
Node and browser backends can run without the UI; their shared core imports no
runtime, DOM, transport or Worker APIs.

Sessions are JSON-compatible with existing Python exports and saved files.
Startup restores the latest session. Snapshots freeze the prompt, agent and skills;
project instructions refresh on resume, compaction and project change. Reset keeps
the transcript. Session saves are atomic and serialized within one backend process.
Use distinct session directories across concurrently running processes.

Browser **New Session** applies the selected model configuration and always creates
exactly one empty session, including when settings are unchanged. Its Worker action
is `configureModelAndNewSession`; backend `configureModel(config, true)` owns this flow.

Browser saves are per origin/profile in IndexedDB. Virtual projects are text
copies; direct local-folder mode stores native directory handles and writes
approved effects to disk, with permission and external-change checks. Missing
permissions fail explicitly; opening the folder again grants them. Browser
`run_command` is unsupported and never offered to the model. Demo replies and
token counts are scripted/estimated; optional Ollama needs the page origin allowed
in `OLLAMA_ORIGINS`. Build assets remain under gitignored `dist/browser`; package
output is `dist/myharness-browser.zip`. Do not add DOM/Worker dependencies to the core.

File tools resolve paths within the workspace and reject escaping or dangling
symlinks. Bash commands run with account permissions, a timeout and process-group
cancellation; they are not confined to the workspace. Missing approval answers
deny actions: approvals settle as `allowed-once`, `rejected`, `cancelled` or
`unavailable`, and only the first runs anything. `guard.ts` holds the advisory
repeat-call guard used by the core; the UI only words `guard` events and denials. Keep requests, proposed effects, decisions and results visible.

Context handling trims old tool output at 75% pressure and attempts summarization
at 90%, retaining the last four messages and whole tool batches. Failed, empty,
incomplete or larger summaries leave memory unchanged. Estimates and Qwen prompt
reconstruction remain illustrative. Node Stop aborts model requests and command
process groups and denies pending approvals. Resume repairs incomplete tool
batches without rerunning them.

## Safe verification

Never stop, restart or send requests to the owner's **port 5000** service.
Never call `ollama.sh stop`, kill shared processes or change the owner's model
for a check. Use scratch workspaces/settings/sessions and port **5001** or an
ephemeral port. Stop only exact processes you started.

Run [TESTING.md](TESTING.md). New backend code needs 100% line/branch coverage.
Backend coverage alone does not verify UI behavior. Deterministic tests use no live
model; Playwright smoke tests use scripted models. Do not commit unless asked.
Inspect the working tree and preserve other sessions' changes.

The owner must restart their service when ready to use the new backend. Do not
restart it for them. Hard-refresh the browser after UI updates.

`npm run start:ts` defaults to localhost:5001; `npm run headless:ts -- "message"`
starts the full backend directly. `MYHARNESS_*` settings are documented in README.
`web.sh` selects port 5000 unless overridden and uses the owner's machine-specific
Windows/WSL Ollama launcher. Public users should follow the portable Node setup.

## MCP

MCP configuration comes from `MYHARNESS_MCP` (default `<root>/mcp.json`) or, in the
browser, an imported file; never from the project folder. MCP tool calls always go
through approval while approvals are on; annotations are displayed, not trusted.
Resource reads are not approved, like `read_file`. The registry browser (GitHub's registry by default, or the
official one via `source`) searches, previews remote servers and shows snippets. The explicit Add action merges
configuration through the backend and reloads servers (package entries start commands). Browser stdio servers are
reported unsupported. Imported browser header values are not persisted. Tests use
the scripted fixture in `typescript/tests/mcp-fixture.ts` (all eras, in-memory,
HTTP and a real stdio process); no live MCP server is required.

## Web search

The root `mcp.json` also connects Exa's free, keyless hosted MCP endpoint, limited
to `web_search_exa`. This is an ordinary MCP tool (`mcp__exa__web_search_exa`), so
the shared backend owns discovery, approvals and cancellation; no UI search logic
or new core capability is needed. Tools are unticked until selected. Anonymous
usage shares limits by public IP. Node hosts can add an `x-api-key` header using
`${EXA_API_KEY}` to use their own account quota. Browser users import the config.
An overridden `MYHARNESS_MCP` file must include the entry separately.

`web_search` (`websearch.ts`) reads DuckDuckGo's keyless HTML endpoint: free, but a web page
rather than an API, so the parser may need updating if the markup changes. Ecosia and paid or
key-based search services were deliberately not used (owner: free, no Ecosia). It reaches the
core only as `RuntimePort.webSearch`; the browser runtime omits it and reports it unsupported.
It is not approval-gated, like `read_file`: only the query is sent, and results are labelled
untrusted. Tests use a fixture shaped like the real page; the live endpoint was checked once.

## Files, plans and git

`delete_file`, `move_file`, `update_plan` and the `git_*` tools are built in (`tools.ts`).
Deletions, moves, branch creation, checkout and commit return an `action` effect: the preview
is built when the model asks, `executeAction` asks approval and runs it (see ARCHITECTURE).
`update_plan` is validated in `plan.ts` and returns the checklist; the UI draws it from the
ordinary `tool` event, so no extra event exists. `Harness.availableTools()` decides what is
offered (runtime support, plus a git adapter for git tools); bootstrap, requests, `explore` and
agent tool lists all use it, and the UI never shows an unavailable tool. A local-folder move
copies bytes, so binary files survive; deletes and moves refuse a text file that changed after it
was read.

Git: `GitPort` (`git.ts`) hides the runtime. `node/git.ts` runs `git` without a shell, with
`GIT_CEILING_DIRECTORIES` (no repository above the project folder), `core.hooksPath=/dev/null`
and `core.fsmonitor=false` (nothing in `.git` runs code), no prompts and a timeout. The
browser uses isomorphic-git 1.43 (new runtime dependency, plus `buffer`, injected by esbuild
in `scripts/build-browser.mjs`). Known differences: it reads only the repository's own
`.git/config` (no global identity), refuses a branch switch whenever local changes exist,
cannot see the executable bit, has no symbolic links, and hashes file contents on every
status because `git-fs.ts` returns a fresh inode (otherwise a same-size edit within a second
of a status looks unchanged). Neither adapter pushes, pulls or clones.

## Cloud model adapters

The shared model boundary is `model.ts`; `cloud.ts` and `sse.ts` implement native
Gemini Interactions, OpenAI Responses and Anthropic Messages with injected fetch.
`providers.ts` owns selection and ephemeral credentials. Configuration lives in
the backend; browser controls only forward RPC actions and render bootstrap.
Provider-tagged continuation items and tool-call IDs survive session export and
compaction retention. Current tool results are serialized from canonical memory.

Keys never enter saved requests, sessions, settings or exports. Browser reload
requires reconnection; Node supplies environment keys. Do not log provider error
bodies or headers. Native cloud count/token inspection is unavailable rather than
fabricated; generation usage is separate. The PR1 legacy Gemini/Vertex adapters
and Ollama injection remain supported. Authenticated cloud checks are optional
and currently unverified: no credentials were supplied for this change.

## Guide, vault and bridge

The new separate entrypoint is `web/guide.html`; `ui/guide.ts` forwards setup actions
to `ManagedSession` through `managed-worker.js`. Shared mode uses MemoryStorage,
personal vaults use Web Crypto/IndexedDB, and ChannelWorker/SessionRelay link the
existing harness page. End session and locking handle simultaneous tab cleanup and
in-flight configuration. Missed page heartbeats do not end a session. Shared-computer
bridge pairings have a 15-second lease; private-computer pairings remain valid
until explicit release or bridge process exit. Only shared mode locks after ten
minutes without user interaction. A private-mode bridge heartbeat failure does
not clear unrelated model credentials; bridge requests report their own failures.
Reloading the linked harness tab replaces its private port without clearing the
managed session or bridge credentials. Page unload detaches the client; closing
the tab is detected by the guide. Backend requests register resumed activity.
Project-folder changes fetch fresh backend state so tool availability and browser
workspace status update immediately without a page reload or bridge re-pairing.
Guide setup changes notify only its linked harness tab. That view fetches backend
state so bridge tools appear after pairing and disappear after credential locking.
Guide's Unpair bridge calls backend `detachBridge`: it restores the pre-bridge
runtime/workspace, keeps model credentials and conversation, and cancels pending
pairing. The linked view refreshes its tools after unpairing too.
Requests against an ended managed session return 410 with Guide recovery
instructions; they do not replace this lifecycle failure with the generic
credential/vault error. Safe errors carry structured `failure` details: source,
component, reason and recovery. Worker and HTTP adapters preserve those details;
the harness renders them for live errors and replay. Provider response bodies and
credentials must never be copied into diagnostics.
Paired folder selection uses the bridge's native directory browser rather than
browser directory handles, which expose no absolute native path. `selectProject`
registers each selected native root in the authenticated bridge connection. Tools
carry that root explicitly, so switching repositories cannot redirect an older
workspace's operations. `--workspace` is the initial directory; grants and approval
policy remain unchanged when selecting another repository. `browseProject` and
`selectBridgeProject` are callable backend actions with Worker adapters.

`npm run bridge:ts` starts an independent capability-only Node process on loopback.
Writes, Bash and Git mutations require explicit startup flags. Pairing codes are
single use; bridge tokens are not persisted. Ordinary browser mode still cannot
start processes without a bridge. Keep owner services/settings untouched.

The existing preview/proposal remain intact. Delivery details and the remaining
Copilot prerequisites are in `docs/browser-guide-implementation.md` and
`docs/copilot-feasibility.md`. All new TS modules and guide controllers participate
in the per-file 100% coverage gate.

Bridge token inspection uses operator-owned `MYHARNESS_TOKENIZERS` bindings and
`OLLAMA_URL`. The browser backend routes saved Ollama requests through the paired
bridge when bindings are advertised. The bridge renders the prompt and calls
llama.cpp; it accepts no browser-selected upstream URLs. Setup is in TOKENIZATION.md.

`--allow-tokenizer` grants dedicated on-demand llama.cpp startup independently of
Bash. `node/managed-tokenizer.ts` discovers local Ollama GGUF paths, supports
operator `MYHARNESS_TOKENIZER_MODELS` mappings and `MYHARNESS_LLAMA_TOKENIZER`, reuses
one owned process, and kills it on replacement, release, expiry or shutdown.
Manual `MYHARNESS_TOKENIZERS` bindings take precedence. No installers run in the bridge.

Windows Ollama `FROM` drive paths are translated to standard WSL `/mnt/<drive>`
paths before GGUF validation. Existing POSIX paths stay unchanged; UNC/relative
paths require explicit model mappings. Scratch mounted-drive tests cover discovery
and actual child launch without touching the owner's Ollama or model files.

Token viewer progress now comes from `tokenizationProgress` (Worker) or
`GET /tokenize/progress` (HTTP). Ollama and ManagedTokenizer report stages; bridge
state is connection-scoped and cleared after inspection. BrowserHarness forwards
that status without a backend timer. The viewer polls with stale-result guards.
Renderer/tokenizer failures preserve safe stage-specific explanations; diagnostic
bridge failures also survive the shared inspection boundary. Inspection requests
have a 260-second bridge transport deadline matching their component budgets.


## Vocabulary-only token inspection

Automatic bridge inspection now owns `myharness-tokenizer`, built from
`native/tokenizer/` against the pinned llama.cpp revision. It sets `vocab_only`,
creates no inference context, and returns IDs/raw bytes through private NDJSON.
`node/tokenizer-process.ts` bounds frames, removes inherited `LLAMA_ARG_*` settings,
handles readiness and failures, and invalidates/kills interrupted processes.
`ManagedTokenizer` retains discovery, WSL mappings, file-change reuse keys and
lifecycle cleanup. `PromptTokenizer` keeps native processes out of the core;
OllamaAdapter accepts the model-bound capability alongside existing HTTP bindings.
Manual bindings take precedence. Missing helpers never fall back to full loading.

`MYHARNESS_LLAMA_SERVER` is replaced by `MYHARNESS_LLAMA_TOKENIZER` for automatic
startup. Build instructions and protocol are in TOKENIZATION.md. Prompt rendering
still uses Ollama and can reload an evicted model; no unsupported capture during
normal generation or automatic extra render request is introduced. Remote adapters
and saved inspection replay retain their existing behavior.

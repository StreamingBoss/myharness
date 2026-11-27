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

`chat-completions.ts` is one adapter for OpenRouter, Mistral, Groq, Cerebras and `custom`
(Chat Completions; the provider name is the lower-case service name; Node keys
`OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `CUSTOM_API_KEY`).
A preset per provider holds the base URL, the token-limit field name (`max_tokens` or
`max_completion_tokens`), extra headers (only OpenRouter sends one: the others would fail a
browser preflight), the model-list path and filter, and how `describe` checks the key
(OpenRouter's `/key`, or the model listing). Model IDs may contain a slash, so
`configuredModel` accepts one only for these providers. The continuation is the single
assistant message as returned, including `reasoning_details`; streamed fragments are merged by
index and type. Mistral may return content as a list of text and thinking parts, and Groq
reports streamed usage under `x_groq`.

`custom` has no base URL in its preset: the user names a server. `customEndpoint` validates
it (https for any host; http only for localhost, loopback, private ranges and `*.local`; no
credentials, query or fragment). The address travels as `url` in the model settings
(`configureModel`, `listModels`) or `MYHARNESS_CUSTOM_URL` on Node, and `ProviderRouter` keeps
it in memory with `setBase`, like keys. The key is optional for `custom`, so `ready()` means
"has an address" there and the `authorization` header is omitted without a key. Only services
that answer a browser preflight belong among the named presets: NVIDIA NIM, Cloudflare Workers
AI and Zhipu send no CORS headers and were left out; SiliconFlow was tried and removed because
its international site has no free model (billing showed $0.0002 for the one call that ran).
The adapter calls a detached `fetch`, as `cloud.ts` does: a browser's native fetch throws when
invoked as a method. Request bodies are covered by the Request-tab tests. HTTP 402 has its own
explanation in `error-messages.ts`; before it, a 402 was shown as "could not be reached".

Keys never enter saved requests, sessions, settings or exports. Browser reload
requires reconnection; Node supplies environment keys. Do not log provider error
bodies or headers. Native cloud count/token inspection is unavailable rather than
fabricated; generation usage is separate. The PR1 legacy Gemini/Vertex adapters
and Ollama injection remain supported. Authenticated cloud checks are optional
and currently unverified: no credentials were supplied for this change.

## Provider test status (TODO: finish soon)

The audience is engineers and students worldwide, including Russia and China, so every
provider the page offers must be tried live before it is offered. Status on 2026-11-16, from
a network in France, no VPN. "Preflight" is a browser CORS preflight from the site's origin;
a provider without CORS headers cannot be called from a web page and is not offered.

| Provider | Free access (per its own page, unverified) | Preflight | Scripted tests | Live, Node | Live, browser | From China | From Russia |
|---|---|---|---|---|---|---|---|
| Ollama (local) | Free, runs on your machine | n/a | yes | yes | yes | not run | not run |
| Custom server | Whatever the server offers | n/a | yes | not run | yes (Ollama `/v1` on the LAN; OpenRouter by address) | not run | not run |
| OpenRouter | `:free` models, daily caps | pass | yes | yes | yes | not run | not run |
| Gemini | Free tier for Flash models | pass (site origin only) | yes | **not run** | **not run** | not run | not run |
| Mistral | Free experimentation plan | pass | yes | **not run** | **not run** | not run | not run |
| Groq | Free plan, per-model caps | pass (its CDN once returned 403 to the test network) | yes | **not run** | **not run** | not run | not run |
| Cerebras | One-time credit, maybe a card | pass | yes | **not run** | **not run** | not run | not run |
| OpenAI, Anthropic | Paid | pass (Anthropic needs its browser-access header) | yes | not run | not run | not run | not run |

Tried and left out: SiliconFlow (international site: its one small model cost $0.0002 for
3,200 tokens and the starter credit was gone, then HTTP 402 for every model); NVIDIA NIM,
Cloudflare Workers AI, Zhipu, Yandex AI Studio and GigaChat (no CORS headers, or unreachable,
so a web page cannot call them). Candidates not yet tried because they need accounts that may
require a local phone number or ID: Alibaba Qwen (`dashscope` and `dashscope-intl`, CORS
open), Baidu ERNIE (Qianfan, CORS open), cloud.ru Evolution (CORS open; free tier unknown) and
Tencent Hunyuan. A truly free option for China and for Russia is still missing; Ollama and the
Custom server are the only options that do not depend on a vendor's region or policy.

To do, in order:
1. Get free keys for Gemini, Mistral, Groq and Cerebras and run a browser tool loop for each
   (connect card, list models, connect, ask for a `pwd` call). Record which free model worked.
2. Repeat the probes and live runs with a VPN exit in China and in Russia, and fill the last
   two columns. Claude is unavailable from those exits, so run a plain script there and read
   its report afterwards.
3. Try Alibaba Qwen, Baidu ERNIE and cloud.ru; add one Chinese and one Russian provider only
   if a free tier really answers from a browser.
4. Replace the "free access" cells with what was observed, and keep the README table in step.

## Recorded sessions and step-by-step replay

A saved session already stores every harness event, so a recording is an ordinary session export (a real model's
answers kept as they came) and replay is display only.

- `typescript/src/replay.ts` (core-free): `replaySteps` makes one step per event, except that the streamed chunks and
  thinking of a reply join the event that ends them. `replayPlan` marks the steps where a replay can be continued
  (`memory` = messages kept): the end of a turn, where memory ends with the model's final answer. Events record memory
  only as text, so memory is rebuilt by counting the messages each event added (`chat_user`, `response`, `tool`,
  `guard`; `reset` empties) and the count is trusted only when it equals the saved memory. After a trim or compaction,
  or when the count differs, no step can be continued. Only the segment after the last reset can be rebuilt.
  `sessionAtStep` returns the session as it stood at that step.
- Backend: `Harness.replayPlan(source)` and `Harness.continueSession(source, step?)`, where `source` is `{ id }` (a saved
  session) or `{ record }` (a recorded one supplied whole). Continuing from a saved session's last state activates it;
  a record or a step is imported as a new session named `… (continued)` / `… (continued from step N)`. Routes
  `POST /sessions/replay` and `POST /sessions/continue` (Node HTTP, Worker `replayPlan` / `continueSession`, fetch shim).
  The `reset` event now carries `memory`, so replay shows memory emptied.
- Recordings ship from `recorded-sessions/<language>/*.json` (file-name order). `scripts/recorded-sessions.mjs` copies
  them to `dist/browser/recorded/` with an `index.json`, and fails the build if a recording is not a session export or
  mentions a local path: record in the browser edition (workspace `/workspace`). The page lists those in its language,
  or English, as the "Recorded sessions" group of the session picker. Nothing loads automatically.
- UI (`web/static/app.js`): the "Load sessions as" switch (Play step by step | Continue, kept in `localStorage`
  `loadMode`) decides what Load does. Play shows a player (slider, Previous, Next step, Continue from here, Close
  replay) in place of the message box; it sends nothing to a model and saves nothing. Close replay and every
  Continue reload the page.
- A session saved with the retired scripted demo model (`scripted-demo`) is still replaced on startup by
  `BrowserHarness.open`; recordings must come from a real model.
- Which sessions to record, and in which order, is not decided. English and French are recorded by the owner; the other
  ten languages follow. Each recording must be the model's exact answers, even where it writes a language badly.

## Connect card and tokenizer helper

The browser edition has one entry page. Guide & Setup, the linked second tab,
`ManagedSession`, the vault, shared/personal modes and the scripted demo option
were removed. `BrowserHarness.bootstrap` reports `model_connected`;
`ui/connect-card.ts` renders the first-run card from it and forwards `listModels`
and `configureModel`. `ui/browser.ts` inserts the card above `#messages`. The page
must not contact a model service before the user chooses one: listing Ollama
models can raise the browser's local-network prompt. API keys stay in Worker
memory only. `DemoModel` and the `demo` provider remain as a deterministic test
fixture and for sessions saved with them; do not offer them in the page.

The loopback bridge and the Node tokenizer helper are gone (`node/bridge*.ts`,
`node/token-helper*.ts`, `node/managed-tokenizer.ts`, `node/tokenizer-process.ts`,
pairing codes, grants, native folders, commands and web search from the website).
What remains is one native program, `native/tokenizer/main.cpp`, built as
`token-helper` (`npm run build:token-helper`). It has two requests, `/v1/info` and
`/v1/tokenize`, and trusts the browser's `Origin` and `Host` headers instead of a
pairing code; keep it tokenizer-only, because that is what makes the missing code
acceptable. Default origin `https://harnessarium.com`, default address
`http://127.0.0.1:5002`. `browser/token-helper.ts` is its client and
`helper-protocol.ts` the shared constants and `HelperError`.

Keep harness logic out of the native program. The page renders the prompt with
Ollama; `BrowserHarness.inspectModelTokens` hands the shared `OllamaAdapter` a
`PromptTokenizer` that calls the helper. The helper only finds the GGUF (its own
Ollama's `/api/show`, or `MYHARNESS_TOKENIZER_MODELS`) and tokenizes. It also
implements `--install`, `--uninstall` and `--print-install` (per-user login entry;
only `OLLAMA_URL`, `MYHARNESS_TOKENIZER_MODELS` and `MYHARNESS_WSL_MOUNT_ROOT` are
recorded). `native/tokenizer/tests/verify.py` requires 100% line coverage of
`main.cpp` on Linux and checks the upstream token goldens over HTTP;
`.github/workflows/token-helper.yml` builds, checks and, for a `token-helper-v*`
tag, releases the downloads. The macOS and Windows builds are unverified: their
`#ifdef` branches (program path, registry, launchctl) have never run.
`typescript/tests/helper-fixture.ts` is a scripted stand-in speaking the same
protocol for the TypeScript tests; `scripts/smoke-token-helper.mjs` runs the real
program with the real client.

`BrowserHarness.connectTokenizer`, `forgetTokenizer` and `tokenizerStatus` are the
backend actions (same Worker action names). The remembered choice is
`settings/tokenizer-helper` (`{ endpoint }`, no secret). Startup contacts nothing;
`inspectModelTokens` reconnects a remembered helper lazily, and
`ui/token-helper-panel.ts` reconnects once per page load when the token view opens.
The panel lives inside `#tokenization`, is shown for Ollama only, and makes no
decisions. `scripts/build-browser.mjs` empties `dist/browser` first so retired pages
are never shipped from an older build.

Explorer views request live model metadata only for the model-template view
(`describe_model` in HTTP/Worker, the optional second `explore` argument headlessly).
Workspace refresh and model-description failures return safe warnings alongside
available session snapshots; transport failures are displayed instead of leaving
the explorer blank.
Project-folder changes fetch fresh backend state so tool availability and browser
workspace status update immediately without a page reload.
Safe errors carry structured `failure` details: source,
component, reason and recovery. Worker and HTTP adapters preserve those details;
the harness renders them for live errors and replay. Provider response bodies and
credentials must never be copied into diagnostics.
The earlier Guide proposal and delivery notes in `docs/browser-guide-*.md` are kept
as history and marked superseded. Copilot prerequisites are in
`docs/copilot-feasibility.md`. All new TS modules and the connect-card controller
participate in the per-file 100% coverage gate.

Windows Ollama `FROM` drive paths are translated to standard WSL `/mnt/<drive>`
paths before GGUF validation. Existing POSIX paths stay unchanged; UNC/relative
paths require explicit model mappings. Scratch mounted-drive tests cover discovery
and actual child launch without touching the owner's Ollama or model files.

Token viewer progress now comes from `tokenizationProgress` (Worker) or
`GET /tokenize/progress` (HTTP). Ollama reports stages. The viewer polls with stale-result guards.
Renderer/tokenizer failures preserve safe stage-specific explanations; diagnostic
helper failures also survive the shared inspection boundary. Inspection requests
have a 260-second helper transport deadline matching their component budgets.


## Vocabulary-only token inspection

The tokenizer helper is built from `native/tokenizer/` against the pinned
llama.cpp revision. It sets `vocab_only`, creates no inference context, and
returns token IDs and raw bytes. `PromptTokenizer` keeps native code out of the
core; OllamaAdapter accepts that model-bound capability alongside the Node
edition's `MYHARNESS_TOKENIZERS` HTTP bindings. Prompt rendering still uses
Ollama and can reload an evicted model; no unsupported capture during normal
generation or automatic extra render request is introduced. Remote adapters and
saved inspection replay retain their existing behavior.


User-facing errors use `error-messages.ts` and `failure.ts` to explain what happened
and how to continue. The raw diagnostic remains intact in events and exports, and
is shown under Technical details in chat and in the connect card. The shared formatter is built
as `error-messages.js` for both the Node-served UI and browser distribution.
Approval events/results carry their actual configured wait limits; network,
command, Git, task and token-inspection failures report their operation limits.

`HELPER_REQUEST_TIMEOUT_MS` (60 seconds) in `helper-protocol.ts` is the helper
client's request deadline.
A configured local Ollama does not imply a live network check.

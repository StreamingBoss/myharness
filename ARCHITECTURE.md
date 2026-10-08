# UI and backend separation

Goal orchestration belongs to `Harness`; `Execution` owns each independent attempt's
monotonic deadline, cancellation, event sequence and settlement. `startGoal` and
`spawnAgent` launch backend tasks immediately. Consuming or disconnecting observers
does not advance or stop those tasks. The UI sends explicit actions and polls state.
Headless consumers can replay/subscribe to events directly; HTTP and Worker clients
can fetch state and sequenced run events through `transport.ts`.

Children reuse runtime/model capabilities with separate session memory. Cloud child
routes resolve through the provider registry; restarting resolves current credentials.
Global settings are application-owned and excluded from session/project authority.
Deadline cancellation denies approvals and aborts model/command adapters. Effectful
child work is serialized across the family; file writes recheck the approved proposal
against current contents. Queued effects can cancel before acquiring the effect slot.

Goal records and child catalogs extend the version-1 session envelope optionally.
Active work is recovered as stopped, never automatically rerun. Restart preserves
child history but uses current host grants; imported sessions discard child authority.
Synthetic continuation and settlement messages are visibly tagged as harness-originated.

Master configuration uses shared backend tools: `get_orchestration` exposes host
limits/permissions and `configure_goal` adopts or adjusts a current user task.
The first turn is counted and handed to the backend driver after its iterator
finishes; usage starts at the first request, without replay. Children cannot configure
master goals or increase authority. Host ceilings are separate from exported session
settings. The read-only Under the hood inspector renders state and forwards Stop
and approval responses; it never advances execution.

## Contract

This project teaches what a harness adds to a model. The UI makes those behaviors
visible; the independent backend implements them. Browser and headless callers
use the same full harness.

```text
UI -> HTTP adapter -----------> NodeHarness ---\
UI -> WorkerClient/WorkerHost -> BrowserHarness -> Harness -> HarnessCore
direct headless caller ------> either runtime --/         -> injected adapters
```

The backend owns conversation state, model/tool sequencing, instructions, skills,
context management and approval enforcement. Clients send actions and render
structured state/events. Core code imports no Node, HTTP, UI, DOM or Worker APIs.
Runtime and transport integration belong in adapters. Browser Workers supply
different adapters while reusing the same full harness and core.

## TypeScript backend

`typescript/src/core.ts` exports `HarnessCore`, `Turn`, `TurnHost`, message,
tool, request and event types. Its asynchronous iterator advances a turn using
injected capabilities. Tests run it directly without a server or UI.

`typescript/src/harness.ts` owns the complete session backend and its tool,
approval, instruction and context behavior. `NodeHarness` and `BrowserHarness`
supply runtime capabilities; neither UI nor transport advances the model loop.
`typescript/src/node/harness.ts` exports the session-owned `NodeHarness`.
Callers can submit turns, inspect state, answer approvals, stop, reset, compact,
explore instructions, change projects and manage saved sessions. It owns state
and supplies runtime capabilities to the core. The HTTP adapter maps the existing
snake_case UI contract to these methods; it contains no agent-loop decisions.

```typescript
import { NodeHarness } from "./typescript/src/node/harness.js";

const backend = new NodeHarness({ workspace: "/path/to/project",
  model: "qwen3:8b", contextLength: 40960 });
for await (const event of backend.submit({ message: "Inspect this project",
  useMemory: true, tools: ["pwd", "list_files"], askApproval: true,
  agent: "", prompt: "" })) {
  console.log(event);
  if (event.type === "approval") backend.approve(String(event.id), false);
}
```

The normal startup adapter obtains model metadata and configures catalogs,
settings and durable sessions. Direct callers may inject model/session adapters.
`npm run headless:ts -- "message"` uses this startup and the full backend without
HTTP, templates or browser code. It denies actions unless `--approve` is supplied.
An unanswered approval times out to denial.

Every approval ends in one closed outcome: `allowed-once`, `rejected` (the user said
no), `cancelled` (Stop or an abandoned request) or `unavailable` (nobody answered in
time). Only `allowed-once` runs anything. `change`, `command` and `mcp` events carry
`approved` plus the `outcome`, and the model is told which denial happened. The HTTP
and Worker `approve` actions still carry a boolean. Approvals switched off ask nothing.

`guard` events record loop hygiene done by the core: when the model repeats the exact
same tool call (same tool, same arguments in any key order) the core appends a
`[harness reminder]` user message after the tool batch and emits `guard` with the
tool, the count and the level. Reminders come at 3 repeats (gentle) and 5 and 8
(detailed, quoting the arguments); refused calls count; each turn starts at zero.
The guard advises and never blocks. See `typescript/src/guard.ts`.

Stop aborts network requests, cancels pending approvals and kills Bash process
groups. Turns reserve a session execution lock; conflicting turns, session changes,
reset and project changes are rejected. Disconnected HTTP streams cancel the turn.
Completed events are saved atomically; resume repairs interrupted tool batches
with stopped results instead of executing them again. Save serialization is within
one process, so concurrent processes need distinct session directories.

Sessions retain the transcript, model memory, enabled tools, approval preference,
selected setup and frozen prompt/agent/skill snapshots. Project instructions refresh
on resume, project change and successful compaction. Existing Python JSON envelopes
remain compatible. The full Python runtime has been retired to
`tests/python_reference/` for parity checks; `harness.py` remains the minimal example.

## HTTP and UI

The frontend gets startup state from `GET /bootstrap`. It can target another host
through `?api=<base-url>` or `window.MYHARNESS_API_BASE`. Configure
`MYHARNESS_UI_ORIGIN` with a comma-separated origin allowlist for separate serving.
The existing static UI renders events; it does not advance the agent loop.

| Action | Endpoint |
| --- | --- |
| Startup metadata and active state | `GET /bootstrap` |
| Submit turn; stream NDJSON | `POST /chat` |
| Answer approval | `POST /approve` with `id` and boolean `approved` |
| Cancel | `POST /stop` |
| Reset memory | `POST /reset` |
| Compact; stream events | `POST /compact` |
| Inspect instructions/tools/template | `POST /explore` |
| MCP server status; add entries; reload configuration | `GET /mcp`, `POST /mcp/add`, `POST /mcp/reload` |
| Search an MCP registry; preview a remote server | `GET /mcp/registry?search=&cursor=&source=github\|official`, `POST /mcp/preview` |
| Choose/browse project | `POST /project`, `GET /browse` |
| List/create sessions | `GET` / `POST /sessions` |
| Inspect/rename | `GET` / `PATCH /sessions/<id>` |
| Activate/export/import | `/sessions/<id>/activate`, `/sessions/<id>/export`, `/sessions/import` |

`/chat` accepts `message`, `use_memory`, `tools`, `ask_approval`, `agent`,
`prompt` and optional `session_id` for stale-client detection. Events include
`request`, `thinking`, `chunk`, `response`, `tool`, `approval`, `change`,
`command`, `skill`, `context`, `guard` and `stopped`. Final `response.content` includes
terminal-chunk text. Errors and empty replies produce visible stopped events.
Reset/session actions return JSON; their durable events remain in the transcript.

## Browser runtime and callable interface

`typescript/src/browser/harness.ts` exports `BrowserHarness`. It provides the
same submit/approval/Stop/reset/compact/session/explore contract as Node, with
IndexedDB sessions, virtual text projects, optional user-granted directory
handles, and either a scripted demo or the shared fetch-based Ollama adapter.
`typescript/src/browser/worker-host.ts` maps RPC actions to this backend;
`worker-entry.ts` only starts it and dispatches messages. The browser UI uses a
transport shim, `browserFetch`, to adapt the existing UI's requests to Worker RPC.

After `npm run build:browser`, the standalone SDK is `browser-backend.js`:

```javascript
import { WorkerClient } from './browser-backend.js';
const backend = new WorkerClient(new Worker('./backend-worker.js', { type: 'module' }));
console.log(await backend.call('bootstrap'));
for await (const event of backend.stream('chat', {
  message: 'Write note.txt: hello', use_memory: true,
  tools: ['write_file'], ask_approval: true, agent: '', prompt: ''
})) {
  console.log(event);
  if (event.type === 'approval') await backend.call('approve', { id: event.id, approved: false });
}
await backend.call('reset');
backend.close();
```

This needs no UI. `headless.html` offers the same client as `window.harness`.
Direct callers may instead open `BrowserStorage` and call `BrowserHarness.open`
with a library and seed workspace. Backend tests use that interface without a
DOM or Worker; native Chromium tests also execute the packaged Worker without UI.

RPC actions include `bootstrap`, `chat`, `compact`, `approve`, `stop`, `reset`,
`explore`, `project`, `browse`, `sessions`, `newSession`, `getSession`,
`patchSession`, `activateSession`, `importSession`, `importProject`,
`exportProject`, `attachLocalFolder`, `configureModel`, `tokenize`, `mcp`,
`reloadMcp`, `addMcp`, `configureMcp`, `mcpRegistry` and `previewMcp`.
Streams return the same structured core events. Ending a stream cancels its turn.
An unanswered approval always denies on timeout or cancellation.

Direct local folders use native File System Access handles after a user grants
read/write permission in the picker. The backend refreshes file listings and
project instruction catalogs, reads current files and checks for external edits
before approved writes. Native handles are stored in IndexedDB; permission must
be granted again if the browser revokes it. Text reads are strict UTF8, normalize
CRLF, and have a 10 MiB per-file limit. Searches skip unreadable/binary files.
Virtual projects persist edits atomically in IndexedDB; importing a folder copy
does not grant access to its original files. Sessions and project exports remain
separate. Site origin/profile changes use different browser storage.

The browser leaves out the tools it cannot run (`run_command`, `web_search`, and the git tools
unless a local folder with a `.git` directory is open). `bootstrap` lists only the available
tools and reports the rest in `unavailable_tools` with a reason; the model is never offered
them, and a direct request for one answers `unsupported: ... : <reason>`.
The scripted demo is a deterministic model adapter, not an LLM, and labels its
approximate token counts and prepared replies. Ollama remains an external model
server; the harness does not move inference into the browser. Its connection
requires the page's origin allowed by the Ollama server and browser network policy.

The tokenization viewer from PR #1 also works through Worker RPC. Inspection is
an explicit backend action over a saved request; it never advances the agent loop
or runs tools. Scripted demos report token sequences unavailable and label counts
as estimates. Ollama reports renderer/tokenizer evidence only when available.
Node also supports the PR's Gemini adapters. See [TOKENIZATION.md](TOKENIZATION.md).

## Verification

Strict compilation, 100% backend line/branch coverage, shared Python/TypeScript
HTTP parity, direct headless checks, Chromium smoke checks and an isolated live
Ollama check pass. See [TESTING.md](TESTING.md) and [MIGRATION_PLAN.md](MIGRATION_PLAN.md).

Runtime-specific differences are deliberate: Node timestamps use UTC ISO strings;
filesystem/process exception wording comes from Node; cancellation aborts pending
model requests immediately. Tool output limits count Unicode code points.
Read-file replacement decoding, strict search/edit decoding and universal line
boundaries preserve the Python contract. Dangling symlinks are rejected/skipped
rather than followed during file operations.

The browser distribution contains only static assets and bundles no Node adapters.
The static server has no harness API. Both runtime backends remain callable without
the UI, with approval policy enforced by the shared backend.

## MCP

`typescript/src/mcp/` is the hand-written MCP client. It imports no Node, DOM or
Worker APIs. `protocol.ts` holds versions, metadata, header encoding and result
conversion; `client.ts` detects each server's era and sends requests; `http.ts`
implements Streamable HTTP and the deprecated HTTP+SSE transport with injected
`fetch`; `manager.ts` turns configured servers into tools, instructions, resources
and prompts. `node/mcp-stdio.ts` is the only stdio adapter. Runtimes declare MCP
through `RuntimePort.mcp`; a runtime without it reports MCP unsupported.

Supported revisions are 2026-07-28 (stateless: `server/discover` and per-request
`_meta`, no sessions) and the handshake revisions 2025-11-25, 2025-06-18,
2025-03-26 and 2024-11-05. On stdio the client probes with `server/discover` and
falls back to `initialize` on any non-modern error or after 5 seconds. Over HTTP a
4xx without a modern JSON-RPC error selects `initialize`, then HTTP+SSE. Modern
`UnsupportedProtocolVersion` errors select a version from the server's list. The
client advertises no client capabilities: legacy `ping` is answered, other server
requests and `input_required` results are reported as unsupported.

Deleting or moving a file and the git changes (branch creation, checkout, commit) share one
approval path. `runTool` validates the request, builds a preview and returns an `action`
effect carrying a closure; the core forwards it to `executeAction`, which sends an
`approval` event with `name`, `title` and `detail`, runs the closure only after
`allowed-once`, and emits an `action` event with the outcome and result. A failed action is
reported to the model as `error: ...`. The git tools use `RuntimePort.git(workspace, signal)`,
which returns a `GitPort`: `node/git.ts` runs the real git program, `browser/git.ts` uses
isomorphic-git over an `fs` adapter (`browser/git-fs.ts`) on the granted folder. Both are
tested against one behavioural suite and against real git.

`Harness` owns the `McpManager`. `initialize()` connects configured servers in
parallel with a 15-second limit; failures become per-server status. Tool names are
`mcp__<server>__<tool>`. `runTool` returns an `mcp` effect and the core forwards it
to `executeMcp`, which asks approval exactly like commands, cancels on Stop and
emits an `mcp` event with the JSON-RPC exchange. Server instructions are added to
the system message while the server's tools are enabled. `/mcp__<server>__<prompt>`
expands through `prompts/get` and emits `mcp_prompt`. Disconnected tools stay in
session settings and are omitted from requests. Bootstrap and explore include
`mcp` status. Node reads `MYHARNESS_MCP` (default `mcp.json` in the harness root),
never the project folder, and closes stdio servers when the HTTP server or headless
run ends. The browser connects over HTTP only and persists imported configuration
without header values.

`mcp/registry.ts` searches GitHub's MCP registry (`/v0.1/servers`, the default) or the
official one (`/v0/servers`, latest versions), with cursor paging, through the runtime's injected `fetch` and converts each
entry into options: remote URLs and npm/PyPI/OCI/NuGet stdio packages, each with an
`mcpServers` snippet, `${NAME}` placeholders and notes. The explicit `addMcp` action merges entries, replacing same-named server entries, saves
through the runtime adapter, and reloads. Node saves atomically; browser headers stay
in memory. `previewMcp` connects once to a remote URL with optional caller-supplied headers,
lists tools, resources and prompts, and disconnects; packages are never run.

## Shared model boundary

`ModelAdapter` in `typescript/src/model.ts` prepares credential-free native
request bodies, describes models, streams typed text/thinking/completion events
and completes summary requests. `LegacyModelAdapter` preserves existing
`NodeHarness({ ollama: ... })` injection; `modelAdapter` is preferred, and supplying
both is rejected. `ProviderRouter` selects adapters and owns ephemeral keys.

`CloudAdapter` uses injected fetch with official endpoints: Gemini Interactions,
OpenAI Responses and Anthropic Messages. Stateless full-history requests keep
conversation ownership in the harness. OpenAI requests encrypted reasoning for
replay and uses `store: false` and non-strict function schemas. Gemini also uses
`store: false`. Claude replay preserves ordered native content blocks/signatures.
The shared SSE reader handles fragmented UTF8, CRLF and multiline data.

Assistant messages retain provider-tagged ordered continuation items. Tool calls
and results carry matching IDs. Tool results are rebuilt from current canonical
memory so trimming cannot reveal an old result through native replay. Only a
completed response with valid call objects can advance to tool execution. Missing
terminal events, malformed calls and output limits fail before effects. Session
records add optional provider/output-limit and continuation fields; old records
restore as Ollama, except the scripted-demo model. Interrupted recovery matches
call IDs and inserts stopped results without rerunning tools.

Browser configuration transfers keys through Worker RPC and clears the input.
The Worker keeps credentials in memory, separate from persisted sessions/settings.
Cloud sessions remain inspectable after reload with inference blocked until
reconnection. Node startup supplies environment keys to the same adapters; its
HTTP model endpoint rejects client credentials. Model switches validate metadata
without generating text and commit selection only after success. The backend
requires idle configuration and starts a new session for changed selections.

## Managed guide and native capability bridge

The static `guide.html` owns a dedicated managed Worker. A private MessageChannel
connects its explicitly opened harness tab to the existing WorkerClient contract.
`ManagedSession` owns storage/vault policy, lifecycle and bridge heartbeats; the guide
only forwards actions and renders results. Protected connection operations cannot
restore credentials after asynchronous locking. Shared mode injects MemoryStorage
before initialization; personal vault records live separately from ordinary sessions.

`BrowserHarness` accepts runtime capabilities and can attach a BridgeWorkspace,
remote Git/command adapters and native web search. NativeBridge hosts capabilities
on authenticated, origin-bound loopback HTTP; it owns no conversation or agent loop.
The core remains independent of pages, Worker APIs and transport. Standard SDK
callers retain ownership of injected storage; managed End session disposes it.
See [implementation details](docs/browser-guide-implementation.md).

Native folder selection stays in runtime adapters. `BrowserHarness.selectBridgeProject`
and `browseProject` use the authenticated bridge's directory capabilities; Worker
and page controls forward these actions. Each explicitly selected repository has
its own bridge workspace adapter, and native tool requests carry that workspace
root. Commands, files and Git therefore use the chosen repository without changing
grants, approval enforcement or another session's working directory.

Saved-request token inspection remains a shared Harness operation. BrowserHarness
uses the inspection adapter hook to forward Ollama requests to a paired bridge
with exact model bindings and matching Ollama endpoint. NativeBridge validates
requests and uses fixed operator-configured endpoints for rendering and llama.cpp
tokenization. It exposes no arbitrary HTTP proxy or provider credential transport.
Structured TokenInspection evidence and cancellation use existing backend events
and the existing viewer; no tokenization decisions are implemented in the UI.

Structured backend failures carry source, component, reason and recovery through
Worker/HTTP adapters into live UI and session replay. Model and bridge boundaries
tag failures where they occur. Private mode preserves connections across browser
suspension; shared mode keeps inactivity locking and expiring bridge authority.

The optional `--allow-tokenizer` startup grant delegates only llama.cpp lifecycle
to a Node ManagedTokenizer adapter. It discovers a local Ollama model file or
uses an operator-owned exact-model path mapping, validates its GGUF header, and
spawns a fixed executable without a shell. One owned process is reused, with
startup deadlines/cancellation and cleanup on release, expiry and shutdown.
Explicit external tokenizer bindings take precedence. The UI cannot choose
executables, paths or launch arguments; no general command grant is required.

Token inspection exposes ephemeral structured progress through
`Harness.tokenizationProgress()`, Worker action `tokenizationProgress`, and
`GET /tokenize/progress`. Model/tokenizer adapters own stage callbacks. For paired
inspection, the browser backend reads the authenticated bridge's per-connection
`inspectionProgress`; no source paths or prompt text enter progress. The existing
viewer polls and renders this state with request/session guards. Polling is not
needed for backend execution, and completion/failure/cancellation clears progress.

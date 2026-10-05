# UI and backend separation

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

Stop aborts network requests, denies pending approvals and kills Bash process
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
| Choose/browse project | `POST /project`, `GET /browse` |
| List/create sessions | `GET` / `POST /sessions` |
| Inspect/rename | `GET` / `PATCH /sessions/<id>` |
| Activate/export/import | `/sessions/<id>/activate`, `/sessions/<id>/export`, `/sessions/import` |

`/chat` accepts `message`, `use_memory`, `tools`, `ask_approval`, `agent`,
`prompt` and optional `session_id` for stale-client detection. Events include
`request`, `thinking`, `chunk`, `response`, `tool`, `approval`, `change`,
`command`, `skill`, `context` and `stopped`. Final `response.content` includes
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
`exportProject`, `attachLocalFolder`, `configureModel`, and `tokenize`.
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

The browser advertises all ten tools but marks `run_command` unsupported and
omits it from model requests. Headless direct requests also report it unavailable.
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

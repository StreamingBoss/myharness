# UI and backend separation

## Contract

This project teaches what a harness adds to a model. The UI makes those behaviors
visible; the independent backend implements them. Browser and headless callers
use the same full harness.

```text
UI -> HTTP adapter ---------> NodeHarness -> HarnessCore
direct headless caller -----> NodeHarness -> model/workspace/runtime adapters
```

The backend owns conversation state, model/tool sequencing, instructions, skills,
context management and approval enforcement. Clients send actions and render
structured state/events. Core code imports no Node, HTTP, UI, DOM or Worker APIs.
Runtime and transport integration belong in adapters. A browser Worker will
supply different adapters while reusing the same core.

## TypeScript backend

`typescript/src/core.ts` exports `HarnessCore`, `Turn`, `TurnHost`, message,
tool, request and event types. Its asynchronous iterator advances a turn using
injected capabilities. Tests run it directly without a server or UI.

`typescript/src/node/harness.ts` exports the complete session-owned `NodeHarness`.
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

## Verification and next runtime

Strict compilation, 100% backend line/branch coverage, shared Python/TypeScript
HTTP parity, direct headless checks, Chromium smoke checks and an isolated live
Ollama check pass. See [TESTING.md](TESTING.md) and [MIGRATION_PLAN.md](MIGRATION_PLAN.md).

Runtime-specific differences are deliberate: Node timestamps use UTC ISO strings;
filesystem/process exception wording comes from Node; cancellation aborts pending
model requests immediately. Tool output limits count Unicode code points.
Read-file replacement decoding, strict search/edit decoding and universal line
boundaries preserve the Python contract. Dangling symlinks are rejected/skipped
rather than followed during file operations.

Phase 4 will host the core in a browser Worker with browser storage/workspace and
model adapters. Ollama and Bash do not move into the browser automatically.
Unsupported OS capabilities must be reported explicitly. Browser execution and
educational distribution are separate from this completed language migration.

# UI and backend separation

## Goal

Let learners explore what a harness adds to an LLM. The UI makes those behaviors
visible; an independent backend implements them. Headless execution must use the
same full harness core as the UI, not a separate simplified implementation.

## Architectural contract

The dependency direction is:

```text
UI or headless caller -> public backend interface -> harness core
                                                   -> model adapter
                                                   -> workspace/tool adapters
```

The core owns conversation state, the model/tool loop, instructions and skills,
context management, and approval policy. Clients send actions and receive
structured data/events. The core does not import client code or access UI state.
Rendering, layout, tooltips, and input controls belong to the UI.

The public interface must support submitting turns, observing streamed progress
and inspectable state, responding to approvals, stopping turns, resetting memory,
and requesting compaction. Approvals are backend interactions any client can
handle; they must not depend on GUI buttons. A headless caller supplies approval
responses or an explicit policy. Missing responses never silently authorize actions.

Model access, workspace access, command execution, and runtime-specific services
sit behind adapters. A browser Worker or HTTP server may host the backend, but
neither transport belongs in the core. Provide a documented headless entry point
using the same core and interface as the UI.

If implemented in TypeScript, keep the core importable outside the browser, with
no required DOM or Worker globals. Browser and headless hosts supply appropriate
adapters. Report browser filesystem or shell limitations explicitly. Moving the
harness into a browser does not itself move Ollama or Bash into that browser.

## Verification

Test the core without mounting the UI or starting its host. Use deterministic
model and workspace adapters to cover a turn, tool execution, approval and denial,
cancellation, memory reset, and context management. Verify that requests,
responses, tools, approvals, and context changes are observable through the public
interface. Check runtime and transport wiring separately.

## Current status

The implementation currently uses Python. The agent loop is in
[`web/core.py`](web/core.py), which has no Flask, server, DOM, or browser
dependency. Its `HarnessCore` consumes a `TurnHost` adapter for model streaming,
workspace tools, persistence, approvals, cancellation, and context management,
then yields structured event objects. A `Turn` carries the session-owned memory,
locked setup, enabled tools, and selected tool definitions for one turn.

[`web/app.py`](web/app.py) is the current Python HTTP host: it prepares a turn
from the active saved session, provides the local Ollama/workspace/approval
adapter, and serializes core events as HTTP NDJSON. It retains the existing
session-file compatibility endpoints while those records remain the product's
single active-session store. [`web/headless.py`](web/headless.py) is a UI-free
client for that same public backend; it never loads templates or browser code.
`harness.py` remains a minimal standalone CLI reference, rather than a second
implementation of the full harness.

The TypeScript core and Node model, workspace and HTTP adapters are being
developed under `typescript/`. Python remains the default.
[MIGRATION_PLAN.md](MIGRATION_PLAN.md) is the active contributor plan; it is
not a claim of completed runtime parity.

The frontend loads startup data from `GET /bootstrap` rather than receiving
Jinja-rendered state, and can point at another host with `?api=<base-url>` or
`window.MYHARNESS_API_BASE`. A configured `MYHARNESS_UI_ORIGIN` permits that
origin through the backend's local-development CORS policy. This keeps the UI,
the headless client, and a future TypeScript host on one observable backend
contract.

## Current Python interface

A UI-free caller can import `HarnessCore`, prepare a `Turn` and supply a
`TurnHost`. Iterate `HarnessCore(host).run_turn(turn)` to advance the loop.
The host supplies model streaming, workspace operations, approval waiting,
cancellation state, persistence and context operations. Any client can answer
approvals through the adapter; an unanswered request must deny the action.
`tests/test_core.py` demonstrates a direct call with a deterministic host.

The HTTP host exposes the same loop to browser and headless clients:

| Action | Endpoint |
| --- | --- |
| Inspect startup metadata and active state | `GET /bootstrap` |
| Submit a turn; stream NDJSON events | `POST /chat` |
| Respond to a pending approval | `POST /approve` with `id` and boolean `approved` |
| Request cancellation | `POST /stop` |
| Reset retained memory | `POST /reset` |
| Request compaction; stream its events | `POST /compact` |
| Inspect composed instructions, tools and template | `POST /explore` |
| Select workspace | `POST /project` |
| List/create saved sessions | `GET` / `POST /sessions` |
| Inspect/rename a session | `GET` / `PATCH /sessions/<id>` |
| Activate/export/import a session | `/sessions/<id>/activate`, `/sessions/<id>/export`, `/sessions/import` |

`/chat` accepts `message`, `use_memory`, `tools` (enabled names), `ask_approval`,
`agent` and `prompt`. Supply `session_id` to reject turns from stale clients.
NDJSON events include `request`, `thinking`, `chunk`, `response`, `tool`,
`approval`, `change`, `command`, `skill`, `context` and `stopped`. The final
`response.content` includes text from every model chunk, including the terminal
chunk; clients should use it to complete the displayed answer. Errors and
incomplete streams produce a visible `stopped` event. Reset and session actions
return JSON; their durable events appear in the session transcript.

Approval waits time out to denial. Reset and workspace changes are rejected while
a turn holds the execution lock. Stop is cooperative: model streaming can remain
blocked waiting for the next network chunk until the read timeout; a compaction
request completes before its stopped result is discarded. Cancellation is not
an instantaneous interruption of every adapter operation.

## Remaining separation work

The transport-free core owns the agent-loop sequence. The Python host still
contains substantive session, catalog, context and action implementations,
including module-global single-session state and a route-local approval adapter.
The headless CLI is an HTTP client and requires that host to be running, although
it never loads the UI. The entire Python backend has not yet been extracted into
one standalone service object independent of Flask. The required contract above
remains the target for the TypeScript migration; extracting only the model/tool
loop does not establish that the whole backend meets it.

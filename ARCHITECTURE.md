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

See [MIGRATION_PLAN.md](MIGRATION_PLAN.md) for the proposed three-phase migration.

The frontend loads startup data from `GET /bootstrap` rather than receiving
Jinja-rendered state, and can point at another host with `?api=<base-url>` or
`window.MYHARNESS_API_BASE`. A configured `MYHARNESS_UI_ORIGIN` permits that
origin through the backend's local-development CORS policy. This keeps the UI,
the headless client, and a future TypeScript host on one observable backend
contract.

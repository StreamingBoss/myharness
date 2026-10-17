# Project instructions

## Purpose

This project teaches what an LLM harness is and what it brings: memory, tools,
instructions, skills, approvals, and context management. It is not primarily
about learning to program a harness. Make these behaviors visible and explain them.

## Required architecture

The UI and harness backend must be clearly separate. The full backend must be
usable and runnable without the UI, regardless of language or execution runtime.

- The backend owns the agent loop, conversation state, prompt construction,
  tools, approval enforcement, and context management.
- The UI sends actions and renders backend state/events. It must not implement
  harness decisions or be required to advance the agent loop.
- Keep the core independent of UI components, the DOM, Flask routes, and Worker
  APIs. Put transport and runtime integration in adapters.
- Expose a callable interface and structured events for messages, progress,
  approvals, cancellation, memory reset, compaction, and state inspection.
- Supply model and workspace/tool capabilities through adapters. Browser-only
  capabilities must not be mandatory dependencies of the core.
- Headless execution must preserve approval policy. Missing approval responses
  must never silently authorize actions. Report unsupported capabilities explicitly.
- Verify backend behavior without the UI, including tool execution, approval
  responses, and cancellation. UI smoke tests alone are insufficient.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the contract and current status. The
TypeScript backend implements this contract. Preserve the dependency direction:
clients use `NodeHarness`, `BrowserHarness` or the public `WorkerClient`, and runtime
adapters supply the shared `Harness` and `HarnessCore` with their capabilities.
Browser and Node runtimes must reuse this core rather than put harness logic in UI components.

## Current project rules

- Read [HANDOVER.md](HANDOVER.md) for implementation details and operational rules.
- All new code must have 100% test coverage.
- Keep `harness.py` as the minimal reference unless explicitly asked to change it.
- Do not interfere with the owner's running service on port 5000. Use port 5001
  and scratch workspaces/settings for integration checks.
- Do not commit unless asked.

## The Request tab shows what is really sent

The Request tab teaches by showing the real request, so two rules are binding and have regression tests
(`typescript/tests/request-view.test.ts`):

- **"As sent" is identical to what is posted to the model**, for Ollama and for each cloud provider: the same
  fields, values and order (only the display formatting differs). The harness's internal routing label
  (`provider`) is not part of any posted body and is not shown. A recorded request event is a snapshot and never
  changes afterwards.
- **"By section" shows the same content as "As sent"**: the system message, tool schemas, memory messages and this
  turn's messages are exactly the ones in the sent body, differing only in form. Every text a section shows
  must be present in the posted body.

Change request building, an adapter body, or `web/static/request-view.js` only together with those tests.

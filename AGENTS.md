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
clients use `NodeHarness`, and runtime adapters supply the core's capabilities.
Browser runtime work must reuse this core rather than put harness logic in UI components.

## Current project rules

- Read [HANDOVER.md](HANDOVER.md) for implementation details and operational rules.
- All new code must have 100% test coverage.
- Keep `harness.py` as the minimal reference unless explicitly asked to change it.
- Do not interfere with the owner's running service on port 5000. Use port 5001
  and scratch workspaces/settings for integration checks.
- Do not commit unless asked.

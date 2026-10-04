# Python to TypeScript backend migration

## Goal and defaults

Preserve the educational harness behavior while making the full backend runnable
without the UI, as required by [ARCHITECTURE.md](ARCHITECTURE.md). Follow three
gated phases: test the Python implementation, separate it from the UI, then port
the separated backend to TypeScript.

First target TypeScript running in Node.js with the current local Ollama and
workspace capabilities. Keep the existing UI and user-visible behavior through
the migration. Browser execution is a subsequent milestone with its own runtime
adapters; do not combine browser limitations with language-porting changes.
Keep `harness.py` as the minimal Python reference.

## Phase 1: establish a tested behavioral baseline

**Status: complete on October 4, 2026.** The deterministic suite has 100% line
and branch coverage of `web/app.py`; see [TESTING.md](TESTING.md). The shared
JSON corpus is in `tests/scenarios` and is exercised through HTTP/NDJSON by the
current Python host.

- Inventory maintained backend behavior and map it to tests. Start with the
  existing 13 passing tests, which currently import `web/app.py` and exercise
  selected file tools, project instructions, skills, and context management.
- Measure and enforce 100% line and branch coverage of maintained backend Python
  code, including routes and startup/configuration behavior. Exclude the frontend,
  vendored dependencies, scratch scripts, and the minimal reference CLI. Document
  any genuinely unreachable/platform-specific exclusions individually; do not
  hide untested behavior with blanket coverage exclusions.
- Cover the complete agent loop: streamed text/thinking, multiple tool rounds,
  tool arguments/errors, disabled tools, step limit, memory on/off, setup locking,
  instructions/skills, explorer output, and prompt reconstruction.
- Cover approvals and file changes, denial and timeout, commands and child-process
  termination, Stop during generation/approval/commands/compaction, concurrent
  operations, context boundaries, failed model requests, and cleanup after errors
  or client disconnection. Use controlled clocks and synchronization rather than
  long sleeps or timing-dependent assertions.
- Use scripted model responses and isolated workspaces/settings. Assert model
  requests, observable events, final state, and filesystem effects. Test real local
  process execution separately with short controlled commands. Real Ollama checks
  remain optional integration checks, not the deterministic acceptance gate.
- Add a language-neutral scenario corpus: JSON inputs, initial workspace files,
  scripted model chunks, client actions, and expected observable results. Drive it
  through a Python test host over the HTTP/NDJSON boundary, recording model calls
  and file effects. Include approval/Stop actions while streams are active. The
  same corpus and runner will later exercise the TypeScript host.
- Fix confirmed bugs in separate changes before freezing their expected behavior.
  Tests must enforce intended behavior rather than preserve known defects.

**Gate:** all tests pass; the backend coverage gate passes; every inventoried
behavior has an assertion; deterministic scenarios run without Ollama or the UI.
Coverage proves execution, not correctness, so both gates are required.

## Phase 2: separate the frontend and Python backend

- Extract a session-owned Python harness core from Flask handlers and module
  globals. Keep the current single-session product behavior; do not add a
  multi-user feature as part of this refactor.
- Define a public interface for initialization/configuration, turns, inspection,
  approval responses, Stop, reset, compaction, and workspace selection. Use
  structured state and events. Inject model, filesystem/workspace, command,
  configuration/catalog, and clock/ID services at runtime boundaries.
- Keep Flask as a thin HTTP/NDJSON adapter. Preserve existing endpoint behavior
  through compatibility mapping, including displayed memory and highlighted JSON
  parts, while keeping presentation formatting outside the core.
- Remove Jinja dependencies from the frontend. Load startup metadata through a
  documented bootstrap endpoint. Give the frontend a backend client boundary
  and configurable API base URL; support separately served frontend/backend
  origins with an explicit local-development origin policy.
- Provide a headless runner for the full Python core. It must work without Flask,
  templates, or browser code, and support streamed output, approvals, and Stop.
- Move implementation-specific unit tests to the extracted core. Retain the
  language-neutral contract suite and adapter tests; extend coverage to the new
  bootstrap and headless interfaces. Document the API and headless invocation.

**Gate:** all existing scenarios pass without changing their expected behavior;
100% backend line/branch coverage remains enforced; headless execution and the
separately served UI pass smoke checks; core imports require no Flask or UI.

## Phase 3: port the backend to TypeScript

- Create a strict TypeScript core with explicit types for configuration, messages,
  tool calls, client actions, state, and events. Use asynchronous iteration for
  streamed turns and explicit cancellation. Keep Node, HTTP, DOM, and Worker
  dependencies outside the core.
- Implement Node adapters for Ollama streaming, local files, settings/catalogs,
  and Bash commands. Preserve workspace confinement, command timeout/child cleanup,
  output limits, approval policy, context thresholds, and request ordering.
- Implement the same HTTP/NDJSON and bootstrap contracts plus a documented Node
  headless runner. Keep the UI unchanged and run Python and TypeScript test hosts
  against the same scenario corpus during the transition.
- Port subsystem by subsystem: prompt/catalog loading and file tools; session
  state and context management; agent loop, approvals, and cancellation; host
  adapters. Run parity checks after each subsystem rather than waiting for the
  entire rewrite.
- Compare structured results and ordered events, model requests, memory, and file
  effects. Normalize only explicitly variable fields such as generated IDs,
  timestamps, and temporary roots. Add targeted checks for Python/JavaScript
  differences in string length, globbing, JSON formatting/order, exception text,
  and Qwen prompt reconstruction. Do not mask semantic differences with broad
  snapshot normalization.
- Port unit tests to the TypeScript implementation and enforce 100% line/branch
  coverage of maintained TS backend code with the same exclusion policy. Keep
  the external contract tests language-neutral; Python coverage does not certify
  the new implementation.
- Switch the default launcher only after parity, headless, and UI checks pass.
  Preserve an explicitly documented Python fallback until the TS acceptance gate
  is satisfied; then retire the old full backend and its dependencies. Preserve
  the minimal Python reference and update setup, architecture, and handover docs.

**Gate:** strict type checking, TS unit/coverage checks, shared contract scenarios,
headless checks, and UI smoke checks pass. A separately isolated real-Ollama smoke
check confirms the production adapter when Ollama is available. Any intentional
behavior difference must be documented and reflected in the contract before cutover.

## Following milestone: browser runtime

Reuse the same TypeScript core with a Worker host, browser workspace adapter, and
chosen model adapter. Decide live-model delivery and supported tools separately.
Report unavailable OS capabilities explicitly and reuse the contract scenarios
for supported capabilities. This milestone is not required to complete the
Python-to-TypeScript replacement.

## Operational rules

Run integrations on isolated ports/workspaces/settings and never interact with
the owner's port-5000 session. Keep phases reviewable as separate changes. Do
not commit unless requested. These phases authorize a plan, not an implementation
change in the current documentation task.

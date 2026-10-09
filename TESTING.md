# Verification

`orchestration.test.ts` tests independent headless execution, child isolation,
elapsed-time timeout, retained partial output, restart history, global disabling,
inherited approvals, shared request limits, explicit resume, HTTP/Worker routing,
cloud child routes and current credentials. Injectable clocks keep deadline tests
deterministic. `master-config.test.ts` checks host ceilings, adoption without replay,
request accounting, deadline changes, cancellation, headless approvals and both runtimes.
`orchestration-ui.test.ts` checks hidden read-only inspection, stable child cards,
partial results, Stop, restoration and approvals/errors while closed. Cloud
child checks use native response fixtures; live authenticated inference remains unverified.

The maintained backend is TypeScript. Checks use scripted models, temporary
workspaces/settings/sessions and ephemeral localhost ports. They do not send
requests to Ollama or the owner's port-5000 service.

Install development dependencies:

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
npx playwright install chromium
```

Run strict compilation, deterministic checks and enforced coverage gates:

```bash
npm run test:ts
npm run coverage:ts
node --test tests/ui_response.test.mjs
.venv/bin/python -m coverage run -m unittest discover -s tests
.venv/bin/python -m coverage report -m
```

`coverage:ts` requires 100% lines, branches, functions and statements for every
module in `typescript/src/`, including startup and executable launchers. No
backend code is excluded. Coverage proves execution; behavioral assertions,
parity scenarios and UI checks provide separate evidence.

`guard-outcomes.test.ts` covers the repeat guard and the four approval outcomes
without any UI; `guard-ui.test.ts` checks that the UI words them. Node tests cover streamed text/thinking, terminal content, tool batches/errors,
snapshots/setup locking, skills, approvals/denial/timeouts, Stop, process-group
cleanup, output limits, context trim/compaction rollback, session recovery,
import/export, workspace changes, concurrency and disconnected clients.
They check Unicode lengths and line boundaries, globbing, JSON formatting,
literal newline repair, symlink confinement and serialized session writes.

`tests/scenarios/` is the language-neutral HTTP/NDJSON corpus. Both hosts receive
the same requests, model chunks and workspace files. The TypeScript runner compares
ordered events, actual model requests, retained memory and expected file effects
with `tests/parity_host.py`. Only temporary roots and generated approval IDs vary;
displayed JSON parts and tool arguments are parsed for structural comparison.
Cases include memory on/off, approval/denial/Stop, commands, editing, searches,
Unicode/CRLF boundaries, agent/skill instructions and empty model replies.

The retired Python backend under `tests/python_reference/` supplies the oracle.
Its historical suite still enforces 100% line and branch coverage. Flask and
coverage belong to `requirements-dev.txt`; neither is needed to run TypeScript.

`typescript/tests/browser.test.ts` uses real Chromium to verify the existing UI
against Node: bootstrap, terminal-chunk reply, history restoration, and a separately
served UI approving a write and exporting the backend session through `?api=`/CORS.
`tests/ui_response.test.mjs` independently checks the actual UI response helper.
Neither claims full frontend code coverage.

Browser-runtime unit tests execute `BrowserHarness` without UI or Worker and
cover every backend adapter, including IndexedDB failure recovery, unavailable
commands, workspace limits, external-file conflicts and approved/denied writes.
Worker transport tests exercise every action, cancellation, crashes and stream
errors. Eleven supported scenarios compare browser/Node ordered events, actual
model requests, retained memory and file effects; the Bash scenario stays Node-only.

`browser-distribution.test.ts` runs the built static distribution in Chromium.
It checks Worker execution, the no-UI SDK entrypoint, unavailable commands,
approval, IndexedDB reload/session/file persistence, exports, no network calls to
a harness API, and a turn after the static server stops. The Ollama check uses an
isolated CORS-aware scripted HTTP server through the real fetch adapter. Native
filesystem handles exercise Worker transfer, approval-gated edits and handle
persistence; the test uses OPFS handles in place of an interactive OS directory
picker. Manual picker/OS permission behavior remains browser-specific.
`npm run test:ts` and `coverage:ts` rebuild browser assets before these tests.
Playwright is pinned to 1.62.0 (Chromium 151): the 1.63.0 bundled Chromium 153
crashes when restoring OPFS handles from IndexedDB, also in an isolated reproduction
without our backend. Recheck native-handle persistence before upgrading this pin.

For headless operation, run `npm run headless:ts -- "message"`. This starts the
same full backend directly without HTTP or UI. It denies actions by default;
`--approve` explicitly approves them. Tests cover both policies and Ctrl+C.
Use distinct session directories for concurrent backend processes.

MCP checks use `typescript/tests/mcp-fixture.ts`, a scripted server for every
protocol era, over in-memory channels, injected HTTP and a real stdio child process
(`mcp-stdio-server.ts`). `mcp-protocol.test.ts` covers header encoding, `x-mcp-header`
validation and result conversion. `mcp-client.test.ts` covers era detection,
version retries, sessions, expiry, HTTP+SSE fallback, server requests, `input_required`
results and cancellation. `mcp-manager.test.ts` covers configuration, naming,
unsupported transports and failures. `node-mcp-stdio.test.ts` covers framing,
stderr, process exits and shutdown escalation. `mcp-harness.test.ts` runs Node and
browser backends without UI: approval, denial, timeout, Stop, instructions,
prompts, resources, reload, HTTP routes and Worker RPC. `mcp-registry.test.ts`
covers registry entry conversion for every package and remote shape, search
paging and failures, previews and their HTTP/Worker routes, without contacting
the real registry. `git.test.ts` runs one behavioural suite against both git adapters (real git in Node,
isomorphic-git over a real folder) on repositories made by real git, and checks results with
real `git log`, `status` and `fsck`; `git-fs.test.ts` covers the `fs` adapter's error codes.
`agentic-tools.test.ts` and `browser-agentic.test.ts` drive `delete_file`, `move_file`,
`update_plan` and the git tools through the backend without a UI (approve, deny, time out,
Stop, races, unavailable tools), on the Node, virtual and local-folder workspaces;
`agentic-ui.test.ts` checks the approvals and plan checklist in Chromium, live and after replay.
`websearch.test.ts` covers DuckDuckGo result parsing (ads, redirects, entities) and errors, a full headless
turn (no key, no approval), Stop and the browser's unsupported report. `mcp-ui.test.ts` (including the registry dialog, previews,
snippets and HTML-escaping of registry text) and `browser-distribution.test.ts`
check the UI and the packaged Worker in Chromium.

Real-model checks are optional integrations. Use scratch configuration/session
directories and port 5001 or an ephemeral port; never touch the owner's port 5000
or stop/reconfigure shared Ollama. The Phase 3 live check used `qwen3:8b` through
the production adapter, returned `OK`, retained two messages and saved one session.
This confirms wiring, not the reliability of model tool choices or summaries.

Cloud adapter checks in `cloud.test.ts` and `providers-harness.test.ts` use
scripted native HTTP/SSE responses. They exercise fragmented Unicode, call IDs,
ordered signed continuation replay, trimmed result serialization, terminal
metadata, missing completion, malformed calls, unknown usage and provider errors.
Headless tests exercise approvals, denial, Stop and compaction rollback across
Gemini, OpenAI and Anthropic. Browser tests check secret-free persistence and
key re-entry. `ModelControls` tests cover input clearing, state refresh without
reload and visible failures; model-picker tests cover stale selections.

Live authenticated browser/headless access remains unverified for Gemini, OpenAI
and Anthropic. Optional checks, using supplied credentials and a scratch
workspace, should answer, read a file, propose/approve an edit, follow up from
memory, compact and cancel. Use ephemeral ports or 5001, never 5000.

## Guide and bridge verification

`guide-bridge`, `guide-managed`, `guide-vault`, `guide-ui`, `guide-http` and
`guide-browser` test the new independent backend, lifecycle, private handoff,
credential races, native effects and setup controls. The browser test hosts an
HTTPS fixture with a temporary OpenSSL certificate, grants Chromium local-network
permission, and pairs an actual loopback bridge; it does not disable browser
security. Install OpenSSL alongside the existing Playwright dependencies.

`guide-folders` checks native directory browsing and selection, workspace-scoped
files/Git/commands, approval denial and execution, unchanged grants, cancellation
of folder selection, Worker routing and unpair restoration without a UI. The
Chromium guide test chooses a second repository through the actual folder chooser
and verifies that an approved command writes only in the selected repository.

`npm run coverage:ts` includes all backend modules and the new guide controllers/
bootstraps, and enforces 100% lines, branches, functions and statements per file.
Test processes use concurrency 2 to avoid competing browser fixtures exhausting
short execution deadlines. Tests require no live API keys or owner port-5000 access.

`bridge-tokenization.test.ts` checks real HTTP pairing and saved-request inspection
from a headless BrowserHarness, exact model/endpoint restrictions, byte preservation,
missing rendering, sanitized failures, cancellation and CLI environment configuration.
All upstream model/tokenizer responses are fixtures; no owner services are contacted.

`managed-tokenizer.test.ts` exercises real fixture helper child processes: automatic model discovery, explicit remote mappings, reuse/replacement,
missing binaries, permissions, invalid GGUF, startup exit/timeout/cancellation,
versioned vocabulary-only readiness checks, removal of inherited llama tool settings, unpair cleanup and
manual-binding precedence. A headless BrowserHarness requests automatic inspection
through real paired HTTP with no Bash grant. No live model or owner service is used.

`token-progress.test.ts` verifies stage callbacks, safe rendering/tokenizer
failures, progress during headless Node inspection and HTTP requests, real paired
bridge stage forwarding, advisory-status failures, cleanup and immediate Worker
progress while a managed inspection is pending. Token viewer smoke tests check
visible stage changes and reject delayed progress after final token pieces appear.


## Native tokenizer verification

Build `native/tokenizer` using the instructions in TOKENIZATION.md, then run:

```bash
python3 native/tokenizer/tests/verify.py \
  --llama-source /path/to/the/pinned/llama.cpp \
  --helper dist/tokenizer/bin/myharness-tokenizer
```

This compiles our helper against a test-only fault-injection shim, exercises every
explicit success/error branch, and requires 100% executable line coverage using
gcov. The shim is never linked into the real helper. It then runs the actual
helper against llama.cpp's Qwen2, GPT-2 and Llama-SPM vocabulary-only GGUFs and
independent upstream golden token IDs (46 cases per family). Byte-level round
trips check accented text, emoji, NULs, newlines and special markers. Native logs
must confirm skipped tensors. No owner weights, Ollama calls, or downloads of
inference models are involved. Reported fixture startup times are not guarantees
for an owner's GGUF/filesystem or comparisons with full inference startup.

`tokenizer-process.test.ts` covers bounded/fragmented protocol replies, invalid
output, input/output limits, concurrent requests, cancellation/timeouts, idle
exit, permission errors and restarting failed channels. Managed tests exercise
bridge cleanup and ensure the native path never calls HTTP tokenizer endpoints.
Browser smoke tests verify the vocabulary-only progress wording. Live checks
with the owner's GGUF remain an optional final parity/performance check.

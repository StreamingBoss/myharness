# Verification

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

Node tests cover streamed text/thinking, terminal content, tool batches/errors,
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

For headless operation, run `npm run headless:ts -- "message"`. This starts the
same full backend directly without HTTP or UI. It denies actions by default;
`--approve` explicitly approves them. Tests cover both policies and Ctrl+C.
Use distinct session directories for concurrent backend processes.

Real-model checks are optional integrations. Use scratch configuration/session
directories and port 5001 or an ephemeral port; never touch the owner's port 5000
or stop/reconfigure shared Ollama. The Phase 3 live check used `qwen3:8b` through
the production adapter, returned `OK`, retained two messages and saved one session.
This confirms wiring, not the reliability of model tool choices or summaries.

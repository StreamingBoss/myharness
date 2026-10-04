# Backend test baseline

Phase 1 establishes a deterministic behavioral baseline for the Python backend.
The suite runs against temporary workspaces and session directories. It never
contacts Ollama, opens the browser, or uses the owner's port-5000 session.

Run the full suite:

```bash
.venv/bin/python -m unittest discover -s tests -v
```

Run the enforced coverage gate:

```bash
.venv/bin/python -m coverage erase
.venv/bin/python -m coverage run -m unittest discover -s tests
.venv/bin/python -m coverage report -m
```

The gate requires 100% line and branch coverage for the maintained Python
backend: [web/core.py](web/core.py), [web/app.py](web/app.py), and
[web/headless.py](web/headless.py). It includes the direct launcher’s successful
and connection-failure paths with its server and model adapters replaced by
deterministic fakes. No backend lines are excluded from coverage.

[tests/test_backend_coverage.py](tests/test_backend_coverage.py) covers backend
units, filesystem effects, HTTP/NDJSON endpoints, session persistence, streamed
model responses, tool execution, approvals, cancellation, compaction, and
command timeout behavior. [tests/scenarios](tests/scenarios) holds a small,
language-neutral JSON contract corpus. Its runner drives the public HTTP/NDJSON
interface with scripted model responses and checks observable events, retained
memory, and workspace effects. The TypeScript implementation will run this same
corpus during Phase 3. [tests/test_core.py](tests/test_core.py) imports and runs
the agent loop directly with a deterministic adapter, without Flask or HTTP
routes.

## Backend boundary smoke checks

The UI document contains no Jinja template expressions. It gets all startup
state from `GET /bootstrap` and can target another backend through `?api=` or
`window.MYHARNESS_API_BASE`. Set `MYHARNESS_UI_ORIGIN` to a comma-separated list
of local UI origins when serving the UI separately. The deterministic tests
exercise this bootstrap/CORS contract and the headless approval flow.

## TypeScript port baseline

The TypeScript core is compiled in strict mode and has no Node, HTTP, browser,
or UI dependency. Run its deterministic tests with:

```bash
npm install
npm run test:ts
```

The TypeScript suite runs [tests/scenarios](tests/scenarios) unchanged, alongside
direct core tests for streamed events, context handling, tool actions,
cancellation, and the step limit. Node production adapters and the TypeScript
HTTP host are the next Phase 3 increment; Python remains the default backend.

## Headless use

Start the backend with `.venv/bin/python web/app.py`. The UI is optional: submit
a full streamed turn through the same public backend API with:

```bash
.venv/bin/python web/headless.py "Summarize this project"
```

The client prints NDJSON events. It denies file changes and commands by default;
pass `--approve` to authorize them. `Ctrl+C` sends `POST /stop` before exiting.
Use `--tools read_file,search` to set enabled tools and `--reset` to reset the
active session’s retained memory.

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
backend, [web/app.py](web/app.py). It includes the direct launcher’s successful
and connection-failure paths with its server and model adapters replaced by
deterministic fakes. No backend lines are excluded from coverage.

[tests/test_backend_coverage.py](tests/test_backend_coverage.py) covers backend
units, filesystem effects, HTTP/NDJSON endpoints, session persistence, streamed
model responses, tool execution, approvals, cancellation, compaction, and
command timeout behavior. [tests/scenarios](tests/scenarios) holds a small,
language-neutral JSON contract corpus. Its runner drives the public HTTP/NDJSON
interface with scripted model responses and checks observable events, retained
memory, and workspace effects. The TypeScript implementation will run this same
corpus during Phase 3.

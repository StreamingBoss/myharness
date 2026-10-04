# Contributor handover

Read [AGENTS.md](AGENTS.md) before editing. This project teaches what a harness
adds to an LLM: make behavior visible and explain it. Public setup is in
[README.md](README.md); boundaries are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Maintained implementation

- `typescript/src/core.ts`: strict, transport-free agent loop and runtime contract.
- `typescript/src/node/harness.ts`: session-owned backend with tools, approvals,
  cancellation, catalogs, snapshots, state inspection and context management.
- `typescript/src/node/`: model, filesystem, persistence, startup, HTTP and CLI adapters.
- `typescript/src/format.ts`: runtime-independent request/memory/prompt formatting.
- `web/templates/index.html` and `web/static/`: static UI and vendored renderers.
- `agents/`, `skills/`, `prompts/`: inspectable instruction examples.
- `tests/python_reference/`: retired Python implementation used only as a parity oracle.
- `harness.py`: unchanged minimal reference; do not change without explicit instruction.

Phase 3 is complete. `web.sh` starts TypeScript; browser runtime is next.
Node can run the backend directly without HTTP, Flask or the UI.

Sessions are JSON-compatible with existing Python exports and saved files.
Startup restores the latest session. Snapshots freeze the prompt, agent and skills;
project instructions refresh on resume, compaction and project change. Reset keeps
the transcript. Session saves are atomic and serialized within one backend process.
Use distinct session directories across concurrently running processes.

File tools resolve paths within the workspace and reject escaping or dangling
symlinks. Bash commands run with account permissions, a timeout and process-group
cancellation; they are not confined to the workspace. Missing approval answers
deny actions. Keep requests, proposed effects, decisions and results visible.

Context handling trims old tool output at 75% pressure and attempts summarization
at 90%, retaining the last four messages and whole tool batches. Failed, empty,
incomplete or larger summaries leave memory unchanged. Estimates and Qwen prompt
reconstruction remain illustrative. Node Stop aborts model requests and command
process groups and denies pending approvals. Resume repairs incomplete tool
batches without rerunning them.

## Safe verification

Never stop, restart or send requests to the owner's **port 5000** service.
Never call `ollama.sh stop`, kill shared processes or change the owner's model
for a check. Use scratch workspaces/settings/sessions and port **5001** or an
ephemeral port. Stop only exact processes you started.

Run [TESTING.md](TESTING.md). New backend code needs 100% line/branch coverage.
Backend coverage alone does not verify UI behavior. Deterministic tests use no live
model; Playwright smoke tests use scripted models. Do not commit unless asked.
Inspect the working tree and preserve other sessions' changes.

The owner must restart their service when ready to use the new backend. Do not
restart it for them. Hard-refresh the browser after UI updates.

`npm run start:ts` defaults to localhost:5001; `npm run headless:ts -- "message"`
starts the full backend directly. `MYHARNESS_*` settings are documented in README.
`web.sh` selects port 5000 unless overridden and uses the owner's machine-specific
Windows/WSL Ollama launcher. Public users should follow the portable Node setup.

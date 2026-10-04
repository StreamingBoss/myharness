# Contributor handover

Read [AGENTS.md](AGENTS.md) before editing. This project teaches what a harness
adds to an LLM: make behavior visible and explain it. The public introduction
and portable setup live in [README.md](README.md); backend boundaries live in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Maintained implementation

- `web/core.py`: transport-free agent loop, with `HarnessCore`, `Turn` and `TurnHost`.
- `web/app.py`: Python HTTP host and local adapters; also retains session,
  prompt/catalog, approval, tool and context-management implementation.
- `web/headless.py`: client of the same HTTP backend; denies approvals by default.
- `web/templates/index.html`: static UI, startup through `/bootstrap`, NDJSON rendering.
- `web/static/`: vendored Markdown renderer and sanitizer.
- `agents/`, `skills/`, `prompts/`: inspectable instruction examples.
- `typescript/`: parallel implementation under development; not the default host.
- `harness.py`: minimal reference; do not change without an explicit request.

Sessions are stored in git-ignored `sessions/`, with a single active session.
`settings.json` remembers the workspace. Browser display preferences stay in
local storage. Instruction snapshots retain the selected prompt, agent and
skills; project instructions refresh on resume, compaction and project change.
The transcript and retained model memory are different: resetting memory keeps
the transcript available. Export never bundles the workspace, but transcript
and tool events can contain its contents.

File tools resolve paths within the workspace. Commands run through Bash with
account permissions, a timeout and process-group cancellation. They are not
confined to the workspace. Missing approval answers deny actions. Keep the
request, proposed effect, approval decision and actual tool result visible.

Token estimates are approximate. Context handling trims old tool outputs at
75% pressure and attempts summarization at 90%, preserving the last four
messages and complete tool batches. A failed or larger summary leaves memory
unchanged. The Qwen reconstruction is illustrative and version-dependent;
matching token counts does not prove matching rendered text.

## Safe verification

The owner may have a live conversation on **port 5000**. Never stop, restart or
send requests to that service. Do not call `ollama.sh stop`, kill shared processes,
or change the owner's model/service for a check. Use scratch workspaces,
settings and session directories, and port **5001** for integrations.

The deterministic suite uses temporary directories and scripted models, with
no live Ollama requests. Run the checks in [TESTING.md](TESTING.md). All new code
must have 100% test coverage; backend checks alone do not verify UI behavior.

For an isolated Python integration, import the host from a separate launcher,
set `workspace`, `SETTINGS_FILE` and `SESSIONS_DIR` to scratch paths, initialize
`context_length`, create a fresh session and call `app.run(port=5001)`.
Stop only the exact process you started. Do not restore the owner's sessions.

Python changes require the owner to restart their service when ready. The
launcher disables automatic reload; hard-refresh the browser after UI changes.
Do not restart it on their behalf. Do not commit unless asked. When another
session is working, inspect the working tree and preserve its changes.

## Local convenience scripts

`web.sh` starts the owner's Windows Ollama installation and the Python web host.
`ollama.sh` provides start, stop and status for that installation. Its Windows
path is machine-specific. Public users should follow the portable README setup.

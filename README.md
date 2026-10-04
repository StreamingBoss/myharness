# myharness

An educational LLM harness for exploring what memory, tools, instructions,
skills, approvals, and context management bring to a model interaction.
The production host currently uses Python and Ollama, with a browser UI.

The UI and backend are separate: the Flask host adapts the Python core to the
HTTP/NDJSON API, and `web/headless.py` uses that same API without rendering the
UI. The TypeScript port is in progress; its transport-free core and shared
scenario runner live in `typescript/`.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the contract and current status, and
[AGENTS.md](AGENTS.md) for contributor instructions.

Run the current web version with `./web.sh`, then open http://localhost:5000.
See [HANDOVER.md](HANDOVER.md) for setup and implementation details and
[PYTHON_HARNESS.md](PYTHON_HARNESS.md) for the minimal Python CLI walkthrough.
See [TESTING.md](TESTING.md) for the deterministic backend test and coverage gate.

Run the TypeScript core and its shared contract scenarios with:

```bash
npm install
npm run test:ts
```

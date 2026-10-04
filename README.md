# myharness

An educational LLM harness for exploring what memory, tools, instructions,
skills, approvals, and context management bring to a model interaction.
The current implementation uses Python and Ollama, with a browser UI.

The UI and backend must remain clearly separate: the full harness backend must
be runnable without the UI. This is an architectural requirement for future
development; the current Flask implementation still needs that refactoring.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the contract and current status, and
[AGENTS.md](AGENTS.md) for contributor instructions.

Run the current web version with `./web.sh`, then open http://localhost:5000.
See [HANDOVER.md](HANDOVER.md) for setup and implementation details and
[PYTHON_HARNESS.md](PYTHON_HARNESS.md) for the minimal Python CLI walkthrough.

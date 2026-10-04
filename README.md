# myharness

**See what happens between your message and an LLM's answer.**

myharness is a local educational harness with a browser interface. It makes
memory, instructions, tools, skills, approvals and context management visible:
inspect the requests sent to Ollama, the responses it returns, and every tool
call in between. The goal is to understand what a harness adds to a model.

The Python backend runs the agent independently of the UI. A headless client
uses the same backend and approval flow. A TypeScript implementation is being
developed alongside it; Python is currently the default.

## What you can explore

| Harness behavior | What you can see and change |
| --- | --- |
| Memory | The retained messages, re-sent on each request; compare memory on and off. |
| Instructions | A base prompt, agent persona and project `AGENTS.md`, composed into the system message. |
| Tools | The definitions sent to the model, its requested calls, and the results the harness sends back. |
| Skills | Short descriptions offered to the model, then full instructions loaded on demand. |
| Approvals | File diffs and shell commands before you approve or deny them. |
| Context | Measured input tokens, estimated pressure, trimmed tool output and visible summary requests. |
| Sessions | Saved transcript, retained memory and instruction snapshots; reset memory while keeping the transcript visible. |

The **Chat** pane shows answers and actions. **Internals** shows the API exchange
and tool effects. **Explore** shows the pieces used to build a request, the model's
Ollama template, and an illustrative Qwen prompt reconstruction. Hover over the
controls for explanations.

## Run locally

Use Python 3.10 or later, Bash and a local [Ollama](https://ollama.com/) server.
The shell tool needs a Linux/WSL environment with process-group support.
Install Ollama using its [official instructions](https://docs.ollama.com/quickstart).
Then, from this repository:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
ollama pull qwen3:8b
```

Make sure Ollama is listening at `http://localhost:11434`. If it is not already
running, start `ollama serve` in another terminal. Launch the harness:

```bash
.venv/bin/python web/app.py
```

Open **http://localhost:5000**. Choose a scratch project folder for your first
experiment. Model loading and generation speed depend on your hardware; the
first request can take longer.

`web.sh` and `ollama.sh` are convenience scripts for the owner's Windows/WSL
installation. They contain a machine-specific Windows path; the commands above
are the portable setup. Windows/WSL localhost connectivity depends on your WSL
network configuration.

## A five-minute experiment

1. Leave Harness memory on. Say “My favourite number is 42”, then ask what it is.
   Compare the two SENT blocks: the harness sends the earlier exchange again.
2. Turn memory off and ask the same question. Inspect the shorter request.
   Turning memory off in the UI resets retained memory.
3. Enable `pwd`, `list_files` and `read_file`. Ask the model to inspect a file
   in your scratch folder. Follow the tool call, result and next model request.
4. Enable `write_file` and keep approvals on. Ask for a small file, inspect the
   proposed diff and deny it. See the denial sent back as a tool result.
5. Enable `use_skill`, or type `/write-readme` followed by a request. Explore
   the difference between a skill's description and its loaded instructions.

Tools are requests from the model; the harness executes them. A model may fail
to request the intended tool. The internals make that difference visible.

## Use the backend without the browser

With the backend running, the following client prints NDJSON events and denies
requested file changes and commands by default:

```bash
.venv/bin/python web/headless.py --tools pwd,list_files "List the project files"
```

Use `--approve` to approve every requested change and command for that invocation.
`Ctrl+C` requests cancellation. The client operates on the backend's active
session, so its actions also affect an open browser using that backend.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the core interface and HTTP endpoints.

## Scope and limits

This is a local, single-user learning tool. The HTTP service has no authentication;
keep it on localhost. File tools check that resolved paths stay in the chosen
project folder. Shell commands run with your account's permissions and are not
sandboxed; approvals are on by default. Missing approval responses deny the action.

SENT contains the actual Ollama API payload. RECEIVED combines streamed content
and thinking with the final statistics. The prompt reconstruction is illustrative,
not a capture of Ollama's internal rendered text. Token estimates use character
counts; the context meter uses Ollama's measured input count. Summaries are lossy.
Displayed thinking is model-provided text, not a guarantee of its internal reasoning.

Prompt-library files are community-collected examples from
[system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks), with
unverified product attribution. Selecting one sends its text literally, including
any placeholders. These examples do not reproduce those products' tools or behavior.
Sessions and exports may contain messages, file contents, command output and local
paths; inspect them before sharing. Exports do not bundle project files.

## Development and further reading

- [ARCHITECTURE.md](ARCHITECTURE.md): backend boundaries, interface and current limitations.
- [TESTING.md](TESTING.md): deterministic verification and coverage gates.
- [PYTHON_HARNESS.md](PYTHON_HARNESS.md): memory and context in the minimal CLI reference.
- [HANDOVER.md](HANDOVER.md) and [AGENTS.md](AGENTS.md): contributor and operating rules.

Run the Python suite without a model or browser:

```bash
.venv/bin/python -m coverage run -m unittest discover -s tests
.venv/bin/python -m coverage report -m
```

The maintained Python backend requires 100% line and branch coverage. TypeScript
work is under `typescript/`; run its current checks with `npm install` and
`npm run test:ts`. It has not replaced the default backend.

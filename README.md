# myharness

**See what happens between your message and an LLM's answer.**

myharness is a local educational harness with a browser interface. It makes
memory, instructions, tools, skills, approvals and context management visible:
inspect the requests sent to the model, the responses it returns, and every tool
call in between. The goal is to understand what a harness adds to a model.

The TypeScript backend runs independently of the UI, either inside a browser
Worker or in Node. Both reuse the same harness and approval policy.

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

The bottom **Explore → tokenization of a saved request** view can inspect individual model calls. It shows token pieces and IDs where a configured/provider tokenizer exposes them, and explicitly explains count-only or unavailable results. See [TOKENIZATION.md](TOKENIZATION.md) for Ollama tokenizer setup, remote Gemini configuration, and exactness limits.

The **Chat** pane shows answers and actions. **Internals** shows the API exchange
and tool effects. **Explore** shows the pieces used to build a request, the model's
Ollama template, and an illustrative Qwen prompt reconstruction. Hover over the
controls for explanations.

## Run entirely in the browser

Build and serve the browser edition with Node.js 20.19 or later:

```bash
npm ci
npm run start:browser
```

Open **http://localhost:5001**. This server serves static files only: the full
harness backend runs in a Worker on your browser's machine. The default model is
a clearly labelled **scripted demo**, with no model installation or inference.
Try `Remember 42`, `What do you remember?`, `List files`, `Read README.md`,
`Write note.txt: hello`, and `Edit note.txt: hello => goodbye`. Inspect SENT,
tool results, proposed diffs and approval decisions. Disable memory or tools to
see what changes. Demo replies and summaries follow prepared rules.

To distribute it, run `npm run package:browser` (requires the `zip` command).
The resulting **`dist/myharness-browser.zip`** contains a standalone static site
and backend SDK. Unzip it and serve that folder through HTTP(S), for example
`python3 -m http.server 8000`. No Node or Python backend is required by recipients;
any static hosting works. Opening `index.html` through `file://` is unsupported.
The demo makes no model network requests, and all rendering assets are bundled.

### Work with local code

**Open local folder…** grants the backend direct access to a folder on the
machine running the browser. Reads inspect its current files; approved writes
and edits write back to disk. The backend rejects edits if the file changed
externally while waiting for approval. Supporting browsers require a secure
context (HTTPS or localhost) and a user gesture. Chrome and Edge support the
[File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).
Permissions can expire: open the folder again when prompted.

**Import folder copy** and **Import project JSON** create virtual text projects
in browser storage. Changes to these copies do not modify the original folder;
use **Export project** to save their files. Folder copies skip binary/non-UTF8
files. Direct access reads UTF8 text up to 10 MiB per file and skips dependency
directories; exporting a local project requires its included files to be text.
The browser does not run Bash; `run_command` is visibly unavailable. Use the Node
edition below when you need shell commands.

### Connect a real model

Choose **Local Ollama**, enter its URL and model name, then start a new session.
Ollama performs inference outside the browser; the harness, tools and approvals
still run inside it, including direct access to your selected local-code folder.
Install and start Ollama and pull a model as described below. Configure
`OLLAMA_ORIGINS` on your Ollama server to allow the exact page origin, for example
`http://localhost:5001`; see the [Ollama FAQ](https://docs.ollama.com/faq).
For a site served through HTTPS, browser network policies may also restrict
connections to local HTTP services. Connection failures appear in the toolbar.
Accept any browser local-network permission prompt for your Ollama server.

Sessions, virtual projects and granted directory handles are saved in IndexedDB,
scoped to this site's origin and browser profile. Changing the host or port uses
different storage. Clearing site data removes these saves. **Export session**
saves conversation state and frozen instructions; **Export project** saves files.

## Run the Node backend locally

Use Node.js 20.19 or later, Bash and a local [Ollama](https://ollama.com/) server.
The shell tool needs a Linux/WSL environment with process-group support.
Install Ollama using its [official instructions](https://docs.ollama.com/quickstart).
Then, from this repository:

```bash
npm ci
ollama pull qwen3:8b
```

Make sure Ollama is listening at `http://localhost:11434`. If it is not already
running, start `ollama serve` in another terminal. Launch the harness:

```bash
npm run start:ts
```

Open **http://localhost:5001**. Choose a scratch project folder for your first
experiment. Model loading and generation speed depend on your hardware; the
first request can take longer.

`web.sh` and `ollama.sh` are convenience scripts for the owner's Windows/WSL
installation. `web.sh` now starts TypeScript on port 5000, or `MYHARNESS_PORT`.
The Ollama script contains a machine-specific Windows path; the commands above
are the portable setup. Windows/WSL localhost connectivity depends on your WSL
network configuration.

## A five-minute experiment with Ollama

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

## Use the backend without the UI

The browser distribution includes `headless.html`, which starts a backend Worker
and exposes `window.harness` without loading the UI. Its public SDK exports
`WorkerClient`, `BrowserHarness`, `BrowserStorage`, `DemoModel` and `OllamaAdapter`.
See [ARCHITECTURE.md](ARCHITECTURE.md) for a callable browser example.

The direct runner starts the full backend and prints NDJSON events. It requires
Ollama, but no HTTP server or browser. It denies changes and commands by default:

```bash
npm run headless:ts -- "List the project files" --tools pwd,list_files
```

Use `--approve` to approve every requested change and command for that invocation.
`Ctrl+C` requests cancellation. `--reset` clears retained memory; `--compact`
summarizes it. The runner restores the latest saved session. Use separate
`MYHARNESS_SESSIONS` directories when running more than one backend process.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the core interface and HTTP endpoints.

Configuration uses `MYHARNESS_MODEL`, `OLLAMA_URL`, `MYHARNESS_WORKSPACE`,
`MYHARNESS_SESSIONS`, `MYHARNESS_SETTINGS`, `MYHARNESS_ROOT` and `MYHARNESS_PORT`.
Defaults are `qwen3:8b`, `http://localhost:11434`, the saved project or `workspace/`,
`sessions/`, `settings.json`, the current directory and port 5001.

## Scope and limits

This is a local, single-user learning tool. The HTTP service has no authentication;
keep it on localhost. File tools check that resolved paths stay in the chosen
project folder. Shell commands run with your account's permissions and are not
sandboxed; approvals are on by default. Missing approval responses deny the action.

SENT contains the actual model API payload. RECEIVED combines streamed content
and thinking with the final statistics. The prompt reconstruction is illustrative,
not a capture of Ollama's internal rendered text. Token estimates use character
counts; the context meter uses Ollama's measured input count in real-model mode
and a labelled demo estimate in scripted mode. Summaries are lossy.
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

Install development checks, including the Python parity reference and Chromium:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
npx playwright install chromium
npm run coverage:ts
.venv/bin/python -m coverage run -m unittest discover -s tests
.venv/bin/python -m coverage report -m
```

The TypeScript backend and Python test reference have enforced 100% line and
branch coverage. Python is only needed for development parity checks or the
unchanged minimal `harness.py` example. The retired full backend lives under
`tests/python_reference/`; it is no longer a supported application runtime.
The browser edition runs both UI and backend on the learner's machine. The Node
edition remains available for shell tools, the HTTP API and the terminal runner.

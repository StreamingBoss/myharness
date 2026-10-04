"""Web version of harness.py: same chat + context-window tracking, streamed to a browser.

Left pane = chat like you'd see in Claude or another model's UI.
Right pane = what goes to and comes back from Ollama, plus the tools the harness runs.
Bottom box = the harness memory.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

import requests
from flask import Flask, Response, render_template, request

OLLAMA_URL = "http://localhost:11434"
MODEL = "qwen2.5:7b"

app = Flask(__name__)

messages: list[dict] = []  # same role as the list in harness.py — the whole "memory"
context_length: int = 0

MAX_STEPS = 5  # max calls to the model per user message, in case it keeps calling tools

PROJECT_ROOT = Path(__file__).parent.parent
AGENTS_DIR = PROJECT_ROOT / "agents"  # harness agents, usable on any project
PROJECT_AGENTS_DIR = Path("agents")  # inside the project folder

SETTINGS_FILE = PROJECT_ROOT / "settings.json"  # remembers the project folder across restarts

# the project folder: the file tools can only see this folder; changed from the page
workspace = (PROJECT_ROOT / "workspace").resolve()


def load_saved_workspace() -> None:
    global workspace
    if not SETTINGS_FILE.exists():
        return
    saved = Path(json.loads(SETTINGS_FILE.read_text())["project"])
    if saved.is_dir():
        workspace = saved
    else:
        print(f"Saved project folder {saved} no longer exists, using {workspace}")
MAX_FILE_CHARS = 10_000  # a big file would fill the context window


def get_current_time() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def pwd() -> str:
    return str(workspace)


def workspace_path(path: str) -> Path:
    p = Path(path)
    if p.is_absolute() and p.resolve().is_relative_to(workspace):
        full = p.resolve()  # a full path, e.g. built from what pwd returned
    else:
        # models often write "/" or "/notes.txt" meaning the top of the project folder
        full = (workspace / path.lstrip("/")).resolve()
    if not full.is_relative_to(workspace):
        raise ValueError(f"'{path}' is outside the project folder")
    return full


def list_files(path: str = ".") -> str:
    entries = sorted(workspace_path(path).iterdir())
    if not entries:
        return "(empty folder)"
    return "\n".join(e.name + "/" if e.is_dir() else e.name for e in entries)


def read_file(path: str) -> str:
    text = workspace_path(path).read_text(errors="replace")
    if len(text) > MAX_FILE_CHARS:
        return text[:MAX_FILE_CHARS] + f"\n[truncated: file has {len(text)} characters]"
    return text


TOOL_FUNCTIONS = {
    "get_current_time": get_current_time,
    "pwd": pwd,
    "list_files": list_files,
    "read_file": read_file,
}

# what the model is told about the tools: sent with every request
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "Get the current local date and time",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "pwd",
            "description": "Get the full path of the project folder, "
            "the folder that list_files and read_file work in",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List the files and folders in the project folder. "
            "Folders end with '/'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Folder inside the project folder, '.' for the top",
                    }
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text file from the project folder",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path inside the project folder, e.g. 'README.md'",
                    }
                },
                "required": ["path"],
            },
        },
    },
]


def run_tool(name: str, arguments: dict, enabled: list[str]) -> str:
    if name not in enabled:
        return f"error: unknown tool '{name}'"
    try:
        return TOOL_FUNCTIONS[name](**arguments)
    except TypeError as e:
        return f"error: bad arguments for '{name}': {e}"
    except OSError as e:
        return f"error: {e.strerror}: '{arguments.get('path', '.')}'"
    except ValueError as e:
        return f"error: {e}"


def load_agent_file(file: Path, source: str) -> dict:
    # optional "tools: a, b" header ending at a "---" line, then the system prompt
    text = file.read_text()
    tools: list[str] = []
    header, sep, prompt = text.partition("\n---\n")
    if not sep:
        prompt = text
    else:
        for line in header.splitlines():
            key, _, value = line.partition(":")
            if key.strip() == "tools":
                tools = [t.strip() for t in value.split(",") if t.strip() in TOOL_FUNCTIONS]
    return {"prompt": prompt.strip(), "tools": tools, "source": source}


def load_agents() -> dict[str, dict]:
    # read on every call, so new and edited agent files apply without a server restart;
    # a project agent replaces a harness agent with the same name
    agents = {}
    for folder, source in [(AGENTS_DIR, "harness"), (workspace / PROJECT_AGENTS_DIR, "project")]:
        for file in sorted(folder.glob("*.md")):
            agents[file.stem] = load_agent_file(file, source)
    return agents


def get_context_length(model: str) -> int:
    resp = requests.get(f"{OLLAMA_URL}/api/tags")
    resp.raise_for_status()
    for entry in resp.json()["models"]:
        if entry["name"] == model:
            return entry["details"]["context_length"]
    raise ValueError(f"Model '{model}' not found locally. Run: ollama pull {model}")


def stream_chat(payload: dict):
    resp = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, stream=True)
    resp.raise_for_status()
    for line in resp.iter_lines():
        if line:
            yield line.decode("utf-8")


@app.route("/")
def index():
    return render_template(
        "index.html",
        model=MODEL,
        context_length=context_length,
        memory=str(messages),
        tool_names=list(TOOL_FUNCTIONS),
        agents=agent_list(),
        project=str(workspace),
    )


def agent_list() -> list[dict]:
    # what the page needs for the dropdown (no prompts)
    return [
        {"name": name, "source": a["source"], "tools": a["tools"]}
        for name, a in load_agents().items()
    ]


@app.route("/project", methods=["POST"])
def set_project():
    global workspace
    raw = request.json["path"].strip()
    if len(raw) >= 2 and raw[1] == ":":
        return {"error": "use a WSL path: C:\\code\\x is /mnt/c/code/x"}, 400
    path = Path(raw).expanduser().resolve()
    if not path.exists():
        return {"error": f"'{raw}' does not exist"}, 400
    if not path.is_dir():
        return {"error": f"'{raw}' is a file, not a folder"}, 400
    workspace = path
    SETTINGS_FILE.write_text(json.dumps({"project": str(workspace)}, indent=2) + "\n")
    return {"path": str(workspace), "agents": agent_list()}


@app.route("/browse")
def browse():
    raw = request.args.get("path") or str(workspace)
    path = Path(raw).expanduser().resolve()
    if not path.is_dir():
        return {"error": f"'{raw}' is not a folder"}, 400
    try:
        # hidden folders (.cache, .git...) are left out to keep the list short
        folders = sorted(
            (p.name for p in path.iterdir() if p.is_dir() and not p.name.startswith(".")),
            key=str.lower,
        )
    except OSError as e:
        return {"error": f"cannot open '{path}': {e.strerror}"}, 400
    parent = str(path.parent) if path.parent != path else None
    return {"path": str(path), "parent": parent, "folders": folders}


@app.route("/reset", methods=["POST"])
def reset():
    messages.clear()
    return {"memory": str(messages)}


@app.route("/chat", methods=["POST"])
def chat_endpoint():
    user_input = request.json["message"]
    use_memory = request.json["use_memory"]
    # names of the tools ticked in the page; empty when tools are off
    enabled_tools = [name for name in request.json["tools"] if name in TOOL_FUNCTIONS]
    selected_tools = [t for t in TOOLS if t["function"]["name"] in enabled_tools]
    agent = load_agents().get(request.json["agent"])
    # the agent's persona; added in front of every request, never stored in memory
    system = [{"role": "system", "content": agent["prompt"]}] if agent else []
    user_message = {"role": "user", "content": user_input}
    if use_memory:
        messages.append(user_message)

    def event(**fields) -> str:
        return json.dumps(fields) + "\n"

    def generate():
        # without memory, this turn's messages are thrown away once the turn is over
        conversation = messages if use_memory else [user_message]

        # the agent loop: call the model until it answers with text instead of a tool call
        for _ in range(MAX_STEPS):
            payload = {"model": MODEL, "messages": system + conversation}
            if selected_tools:
                payload["tools"] = selected_tools
            payload |= {"stream": True, "options": {"num_ctx": context_length}}
            yield event(type="request", raw=json.dumps(payload, indent=2), memory=str(messages))

            reply_parts: list[str] = []
            tool_calls: list[dict] = []

            for raw in stream_chat(payload):
                chunk = json.loads(raw)
                content = chunk["message"].get("content", "")
                reply_parts.append(content)
                tool_calls += chunk["message"].get("tool_calls", [])
                if not chunk.get("done"):
                    yield event(type="chunk", content=content)

            # the final chunk carries the stats; put the whole reply back in it,
            # which is what stream:false would have returned
            reply = "".join(reply_parts)
            assistant_message = {"role": "assistant", "content": reply}
            if tool_calls:
                assistant_message["tool_calls"] = tool_calls
            conversation.append(assistant_message)
            chunk["message"] = assistant_message

            tokens_in = chunk.get("prompt_eval_count", 0)
            tokens_out = chunk.get("eval_count", 0)
            tokens_used = tokens_in + tokens_out
            tokens = (
                f"[{tokens_in} in + {tokens_out} out = {tokens_used} "
                f"|{tokens_used} / {context_length} ]"
            )
            yield event(
                type="response",
                raw=json.dumps(chunk, indent=2),
                tokens=tokens,
                memory=str(messages),
            )

            if not tool_calls:
                return

            for call in tool_calls:
                name = call["function"]["name"]
                arguments = call["function"].get("arguments", {})
                result = run_tool(name, arguments, enabled_tools)
                conversation.append({"role": "tool", "tool_name": name, "content": result})
                yield event(
                    type="tool",
                    name=name,
                    arguments=json.dumps(arguments),
                    result=result,
                    memory=str(messages),
                )

        yield event(type="stopped", reason=f"stopped after {MAX_STEPS} calls to the model")

    return Response(generate(), mimetype="application/x-ndjson")


if __name__ == "__main__":
    try:
        context_length = get_context_length(MODEL)
    except requests.exceptions.ConnectionError:
        print("Could not reach Ollama at localhost:11434 — is the server running?")
        sys.exit(1)

    load_saved_workspace()
    print(f"Model: {MODEL}  (context window: {context_length} tokens)")
    print(f"Project folder: {workspace}")
    print("Serving on http://localhost:5000")
    app.run(port=5000, debug=True, use_reloader=False)

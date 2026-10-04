"""Web version of harness.py: same chat + context-window tracking, streamed to a browser.

Left pane = chat like you'd see in Claude or another model's UI.
Right pane = what goes to and comes back from Ollama, plus the tools the harness runs.
Bottom box = the harness memory.
"""

import difflib
import json
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

import requests
from flask import Flask, Response, render_template, request

OLLAMA_URL = "http://localhost:11434"
MODEL = "qwen3:8b"

app = Flask(__name__)

messages: list[dict] = []  # same role as the list in harness.py — the whole "memory"
context_length: int = 0

MAX_STEPS = 20  # max calls to the model per user message, in case it keeps calling tools

PROJECT_ROOT = Path(__file__).parent.parent
AGENTS_DIR = PROJECT_ROOT / "agents"  # harness agents, usable on any project
PROJECT_AGENTS_DIR = Path("agents")  # inside the project folder
PROMPTS_DIR = PROJECT_ROOT / "prompts"  # product system prompts, from system_prompts_leaks
SKILLS_DIR = PROJECT_ROOT / "skills"  # harness skills: skills/<name>/SKILL.md
PROJECT_SKILLS_DIR = Path("skills")  # inside the project folder

# the agent and system prompt chosen when the conversation started; locked until memory is cleared
conversation_setup = {"agent": "", "prompt": ""}

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

# file changes waiting for the user's Approve/Deny click, by id
pending_approvals: dict[str, dict] = {}

# set by the Stop button; checked between chunks and before each tool
stop_requested = threading.Event()
STOPPED_RESULT = "stopped: the user stopped the turn before this tool ran"
APPROVAL_TIMEOUT = 600  # seconds; no answer counts as refused


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


ESCAPE_NOTE = "the harness turned literal \\n sequences sent by the model into real line breaks"


def unescape(text: str) -> str:
    # models sometimes escape their tool-call JSON twice: "\\n" arrives instead of a line break
    for escaped, real in [("\\r\\n", "\n"), ("\\n", "\n"), ("\\t", "\t"), ('\\"', '"')]:
        text = text.replace(escaped, real)
    return text


# the write tools only prepare the change: (file, its new content, a note about repairs);
# the harness shows the diff, asks the user if needed, and writes the file itself
def write_file(path: str, content: str) -> tuple[Path, str, str]:
    target = workspace_path(path)
    if target.is_dir():
        raise ValueError(f"'{path}' is a folder")
    if "\n" not in content and "\\n" in content:
        return target, unescape(content), ESCAPE_NOTE
    return target, content, ""


def edit_file(path: str, old_text: str, new_text: str) -> tuple[Path, str, str]:
    target = workspace_path(path)
    text = target.read_text()
    if not old_text:
        raise ValueError("old_text is empty; use write_file to create a new file")
    note = ""
    if old_text not in text and "\\n" in old_text and unescape(old_text) in text:
        old_text, new_text, note = unescape(old_text), unescape(new_text), ESCAPE_NOTE
    count = text.count(old_text)
    if count == 0:
        raise ValueError(
            f"old_text was not found in '{path}'. Read the file again and copy the exact text, "
            "including spaces and indentation."
        )
    if count > 1:
        raise ValueError(
            f"old_text appears {count} times in '{path}'. "
            "Include more surrounding lines so it matches only once."
        )
    return target, text.replace(old_text, new_text, 1), note


COMMAND_TIMEOUT = 60  # seconds


# like the write tools, this only prepares: the harness asks the user if needed, then runs it
def run_command(command: str) -> dict:
    if not command.strip():
        raise ValueError("command is empty")
    return {"command": command}


def use_skill(name: str) -> str:
    skills = load_skills()
    if name not in skills:
        available = ", ".join(skills) or "(none)"
        raise ValueError(f"there is no skill '{name}'. Available skills: {available}")
    return f"Skill '{name}' loaded. Follow these instructions:\n\n{skills[name]['body']}"


TOOL_FUNCTIONS = {
    "get_current_time": get_current_time,
    "pwd": pwd,
    "list_files": list_files,
    "read_file": read_file,
    "write_file": write_file,
    "edit_file": edit_file,
    "run_command": run_command,
    "use_skill": use_skill,
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
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create a new file in the project folder, or replace a file's whole "
            "content. Use edit_file instead to change part of an existing file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path inside the project folder, e.g. 'src/app.py'",
                    },
                    "content": {"type": "string", "description": "The complete file content"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Change part of an existing file: replaces old_text with new_text. "
            "old_text must match the file exactly (spaces and indentation included) and appear "
            "only once. Read the file first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path inside the project folder",
                    },
                    "old_text": {
                        "type": "string",
                        "description": "The exact text to replace, copied from the file",
                    },
                    "new_text": {"type": "string", "description": "The text to put instead"},
                },
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Run a shell command (bash) in the project folder and get its output "
            "and exit code. Use it to run scripts and tests, e.g. 'python3 primes.py', to check "
            f"that code works. Commands are stopped after {COMMAND_TIMEOUT} seconds.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The bash command to run"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "use_skill",
            "description": "Load a skill: detailed instructions for a specific task. Call it "
            "when the task matches a skill listed in the system message, then follow what it "
            "returns.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "The skill's name, from the list"},
                },
                "required": ["name"],
            },
        },
    },
]


def run_tool(name: str, arguments: dict, enabled: list[str]) -> str | tuple | dict:
    # returns the result for the model, (file, new content, note) from a write tool,
    # or {"command": ...} from run_command
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


MARKER = "@@HIGHLIGHT@@"


def split_json(shown: dict, highlighted: dict) -> list[str]:
    # `shown` has MARKER where `highlighted` goes; returns the pretty JSON as
    # [before, highlighted, after] so the page can style the middle part
    before, _, after = json.dumps(shown, indent=2).partition(f'"{MARKER}"')
    line_start = before[before.rfind("\n") + 1 :]
    indent = line_start[: len(line_start) - len(line_start.lstrip())]
    middle = json.dumps(highlighted, indent=2).replace("\n", "\n" + indent)
    return [before, middle, after]


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


def load_prompts() -> dict[str, str]:
    return {file.stem: file.read_text() for file in sorted(PROMPTS_DIR.glob("*.md"))}


def prompt_list() -> list[dict]:
    # ~4 characters per token is only an estimate; the TOKENS line shows the real count
    return [
        {"name": name, "tokens": len(text) // 4, "fits": len(text) // 4 < context_length}
        for name, text in load_prompts().items()
    ]


def load_skill_file(file: Path, source: str) -> dict:
    # "---", then "key: value" lines (name, description), then "---", then the instructions
    text = file.read_text()
    meta: dict[str, str] = {}
    body = text
    if text.startswith("---\n"):
        header, sep, rest = text[4:].partition("\n---\n")
        if sep:
            body = rest
            for line in header.splitlines():
                key, _, value = line.partition(":")
                meta[key.strip()] = value.strip()
    return {
        "name": meta.get("name") or file.parent.name,
        "description": meta.get("description", ""),
        "body": body.strip(),
        "source": source,
    }


def load_skills() -> dict[str, dict]:
    # read on every call, like agents; a project skill replaces a harness skill with the same name
    skills = {}
    for folder, source in [(SKILLS_DIR, "harness"), (workspace / PROJECT_SKILLS_DIR, "project")]:
        for file in sorted(folder.glob("*/SKILL.md")):
            skill = load_skill_file(file, source)
            skills[skill["name"]] = skill
    return skills


def skills_section() -> str:
    # progressive disclosure: only names and descriptions go in every request
    skills = load_skills()
    if not skills:
        return ""
    lines = "\n".join(f"- {s['name']}: {s['description']}" for s in skills.values())
    return (
        "# Skills\n\nSkills are detailed instructions for specific tasks. When a task matches a "
        "skill's description, call use_skill with its name before starting, then follow what it "
        f"returns.\n\n{lines}"
    )


def system_messages(setup: dict, with_skills: bool) -> list[dict]:
    # the system message = product prompt, then the agent's instructions, then the skill list
    # (when use_skill is checked); added in front of every request, never stored in memory
    agent = load_agents().get(setup["agent"])
    parts = [
        load_prompts().get(setup["prompt"]),
        agent["prompt"] if agent else None,
        skills_section() if with_skills else None,
    ]
    text = "\n\n".join(p for p in parts if p)
    return [{"role": "system", "content": text}] if text else []


def go_json(value) -> str:
    # compact JSON with map keys sorted, like Go's encoder that Ollama's template uses
    return json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def tool_as_go_value(tool: dict) -> str:
    # Ollama 0.35's qwen3 template prints each tool with Go's default struct format, not JSON:
    # {name description {type <nil> <nil> [required] map[prop:{[type] <nil> description}]}}
    # (found by matching Ollama's token counts; map keys come out sorted)
    f = tool["function"]
    params = f["parameters"]
    props = " ".join(
        f"{name}:{{[{prop['type']}] <nil> {prop.get('description', '')}}}"
        for name, prop in sorted(params["properties"].items())
    )
    required = " ".join(params.get("required", []))
    return f"{{{f['name']} {f['description']} {{{params['type']} <nil> <nil> [{required}] map[{props}]}}}}"


def render_qwen_prompt(messages: list[dict], tools: list[dict]) -> str:
    # a Python copy of qwen3's Ollama template (see the "model template" view). Ollama turns
    # thinking on by default for qwen3, so the last user message gets " /think"
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    turns = [m for m in messages if m["role"] != "system"]
    last_user = max((i for i, m in enumerate(turns) if m["role"] == "user"), default=-1)
    out = ""
    if system or tools:
        out += "<|im_start|>system\n"
        if system:
            out += "\n" + system
        if tools:
            out += (
                "\n\n# Tools\n\nYou may call one or more functions to assist with the user query."
                "\n\nYou are provided with function signatures within <tools></tools> XML tags:"
                "\n<tools>"
            )
            for tool in tools:
                out += '\n{"type": "function", "function": ' + tool_as_go_value(tool) + "}"
            out += (
                "\n</tools>\n\nFor each function call, return a json object with function name "
                "and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n"
                '{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>'
            )
        out += "<|im_end|>\n"
    for i, m in enumerate(turns):
        last = i == len(turns) - 1
        if m["role"] == "user":
            think = " /think" if i == last_user else ""
            out += f"<|im_start|>user\n{m['content']}{think}<|im_end|>\n"
        elif m["role"] == "assistant":
            out += "<|im_start|>assistant\n"
            if m.get("content"):
                out += m["content"]
            elif m.get("tool_calls"):
                out += "<tool_call>\n"
                for call in m["tool_calls"]:
                    f = call["function"]
                    out += f'{{"name": "{f["name"]}", "arguments": {go_json(f.get("arguments", {}))}}}\n'
                out += "</tool_call>"
            if not last:
                out += "<|im_end|>\n"
        elif m["role"] == "tool":
            out += f"<|im_start|>user\n<tool_response>\n{m['content']}\n</tool_response><|im_end|>\n"
        if m["role"] != "assistant" and last:
            out += "<|im_start|>assistant\n"
    return out


def get_context_length(model: str) -> int:
    resp = requests.get(f"{OLLAMA_URL}/api/tags")
    resp.raise_for_status()
    for entry in resp.json()["models"]:
        if entry["name"] == model:
            return entry["details"]["context_length"]
    raise ValueError(f"Model '{model}' not found locally. Run: ollama pull {model}")


def stream_chat(payload: dict):
    # leaving this generator early closes the connection, which makes Ollama stop generating
    with requests.post(f"{OLLAMA_URL}/api/chat", json=payload, stream=True) as resp:
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
        tools=[
            {"name": t["function"]["name"], "description": t["function"]["description"]}
            for t in TOOLS
        ],
        agents=agent_list(),
        prompts=prompt_list(),
        project=str(workspace),
        # the page locks the agent and prompt choice while a conversation is in memory
        locked=conversation_setup if messages else None,
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


@app.route("/stop", methods=["POST"])
def stop():
    stop_requested.set()
    for pending in pending_approvals.values():
        pending["event"].set()  # stop waiting; "approved" stays False
    return {"ok": True}


@app.route("/approve", methods=["POST"])
def approve():
    pending = pending_approvals.get(request.json["id"])
    if not pending:
        return {"error": "this change is no longer waiting for an answer"}, 404
    pending["approved"] = bool(request.json["approved"])
    pending["event"].set()
    return {"ok": True}


@app.route("/explore", methods=["POST"])
def explore():
    # everything that goes into the next request, for the bottom box's explorer views
    if request.json["use_memory"] and messages:
        setup = dict(conversation_setup)  # locked for this conversation
    else:
        setup = {"agent": request.json["agent"], "prompt": request.json["prompt"]}
    agent = load_agents().get(setup["agent"])
    tools = [t for t in TOOLS if t["function"]["name"] in request.json["tools"]]
    show = requests.post(f"{OLLAMA_URL}/api/show", json={"model": MODEL}).json()

    history = messages if request.json["use_memory"] else []
    with_skills = "use_skill" in request.json["tools"]
    next_messages = (
        system_messages(setup, with_skills)
        + history
        + [{"role": "user", "content": "(your next message)"}]
    )
    final = render_qwen_prompt(next_messages, tools) if "qwen" in MODEL else (
        f"The reconstruction is only written for Qwen templates, and the model is {MODEL}."
    )
    return {
        "system_prompt": load_prompts().get(setup["prompt"], ""),
        "prompt_name": setup["prompt"],
        "agent": agent,
        "agent_name": setup["agent"],
        "tools": json.dumps(tools, indent=2),
        "template": show.get("template", ""),
        "parameters": show.get("parameters", ""),
        "final": final,
        "skills": list(load_skills().values()),
        "skills_section": skills_section(),
        "skills_listed": with_skills,
    }


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
    ask_approval = request.json["ask_approval"]
    stop_requested.clear()
    selected_tools = [t for t in TOOLS if t["function"]["name"] in enabled_tools]
    setup = {"agent": request.json["agent"], "prompt": request.json["prompt"]}
    if use_memory:
        if not messages:
            # a new conversation: its agent and system prompt are fixed until memory is cleared
            conversation_setup.update(setup)
        setup = dict(conversation_setup)

    system = system_messages(setup, with_skills="use_skill" in enabled_tools)

    # "/name rest of message": the user loads a skill themselves; its instructions are put in
    # the message (and kept in memory), so the model gets them without calling use_skill
    manual_skill = ""
    if user_input.startswith("/"):
        word, _, rest = user_input[1:].partition(" ")
        skill = load_skills().get(word)
        if skill:
            manual_skill = word
            user_input = (
                f'<skill name="{word}">\n{skill["body"]}\n</skill>\n\n'
                f"{rest.strip() or 'Use this skill.'}"
            )

    user_message = {"role": "user", "content": user_input}
    if use_memory:
        messages.append(user_message)

    def event(**fields) -> str:
        return json.dumps(fields) + "\n"

    def apply_change(name: str, target: Path, new_text: str, note: str):
        # shows the diff, waits for the user's answer if asked to, writes the file;
        # yields events for the page and returns the result for the model
        is_new = not target.exists()
        old_text = "" if is_new else target.read_text()
        rel = str(target.relative_to(workspace))
        diff = "\n".join(
            difflib.unified_diff(
                old_text.splitlines(),
                new_text.splitlines(),
                "/dev/null" if is_new else f"a/{rel}",
                f"b/{rel}",
                lineterm="",
            )
        )
        if not diff:
            return f"no change: '{rel}' already has this content"
        approved = yield from ask_user(name=name, path=rel, diff=diff, note=note)
        yield event(type="change", path=rel, diff=diff, approved=approved, note=note)
        if stop_requested.is_set():
            return STOPPED_RESULT
        if not approved:
            return "refused: the user did not approve this change. Ask them what to do instead."
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(new_text)
        result = f"ok: {'created' if is_new else 'updated'} '{rel}'"
        return f"{result} (note: {note})" if note else result

    def ask_user(**fields):
        # if asked to, shows Approve/Deny in the page and waits for the click; returns approved
        if not ask_approval:
            return True
        approval_id = uuid.uuid4().hex
        pending = pending_approvals[approval_id] = {"event": threading.Event(), "approved": False}
        yield event(type="approval", id=approval_id, **fields)
        pending["event"].wait(timeout=APPROVAL_TIMEOUT)
        return pending_approvals.pop(approval_id)["approved"]

    def execute_command(command: str):
        # asks the user if needed, runs the command in the project folder; yields events for
        # the page and returns the result for the model
        approved = yield from ask_user(name="run_command", command=command)
        if stop_requested.is_set():
            yield event(type="command", command=command, approved=False, output="", status="")
            return STOPPED_RESULT
        if not approved:
            yield event(type="command", command=command, approved=False, output="", status="")
            return "refused: the user did not approve this command. Ask them what to do instead."
        # a new session, so a timeout or Stop can kill the command and everything it started
        proc = subprocess.Popen(
            ["bash", "-c", command],
            cwd=workspace,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=True,
        )
        started = time.time()
        killed = ""
        while True:
            try:
                output, _ = proc.communicate(timeout=0.3)
                break
            except subprocess.TimeoutExpired:
                if stop_requested.is_set() or time.time() - started > COMMAND_TIMEOUT:
                    killed = "stopped by the user" if stop_requested.is_set() else (
                        f"timed out after {COMMAND_TIMEOUT} seconds"
                    )
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # it just finished on its own
        if len(output) > MAX_FILE_CHARS:
            # errors usually come last, so keep the end
            output = f"[first {len(output) - MAX_FILE_CHARS} characters cut]\n" + (
                output[-MAX_FILE_CHARS:]
            )
        status = killed or f"exit code {proc.returncode}"
        yield event(type="command", command=command, approved=True, output=output, status=status)
        return f"{status}\noutput:\n{output}" if output else f"{status}\n(no output)"

    def generate():
        # without memory, this turn's messages are thrown away once the turn is over
        conversation = messages if use_memory else [user_message]
        if manual_skill:
            yield event(type="skill", name=manual_skill)

        # the agent loop: call the model until it answers with text instead of a tool call
        for _ in range(MAX_STEPS):
            payload = {"model": MODEL, "messages": system + conversation}
            if selected_tools:
                payload["tools"] = selected_tools
            payload |= {"stream": True, "options": {"num_ctx": context_length}}
            shown = payload | {
                "messages": [MARKER if m is user_message else m for m in payload["messages"]]
            }
            yield event(
                type="request", parts=split_json(shown, user_message), memory=str(messages)
            )

            reply_parts: list[str] = []
            thinking_parts: list[str] = []
            tool_calls: list[dict] = []

            chunks = stream_chat(payload)
            for raw in chunks:
                if stop_requested.is_set():
                    chunks.close()
                    break
                chunk = json.loads(raw)
                content = chunk["message"].get("content", "")
                thinking = chunk["message"].get("thinking", "")
                reply_parts.append(content)
                thinking_parts.append(thinking)
                tool_calls += chunk["message"].get("tool_calls", [])
                if thinking:
                    yield event(type="thinking", content=thinking)
                if not chunk.get("done"):
                    yield event(type="chunk", content=content)

            reply = "".join(reply_parts)
            if stop_requested.is_set():
                # keep the partial answer, but not a half-received tool call
                if reply:
                    conversation.append({"role": "assistant", "content": reply})
                yield event(type="stopped", reason="stopped by the user", memory=str(messages))
                return
            assistant_message = {"role": "assistant", "content": reply}
            if tool_calls:
                assistant_message["tool_calls"] = tool_calls
            # the thinking is shown but not kept in memory: earlier reasoning isn't sent back
            conversation.append(assistant_message)

            # the final chunk carries the stats; put the whole reply back in it,
            # which is what stream:false would have returned
            received_message = {"role": "assistant"}
            if "".join(thinking_parts):
                received_message["thinking"] = "".join(thinking_parts)
            received_message |= assistant_message

            tokens_in = chunk.get("prompt_eval_count", 0)
            tokens_out = chunk.get("eval_count", 0)
            tokens_used = tokens_in + tokens_out
            tokens = (
                f"[{tokens_in} in + {tokens_out} out = {tokens_used} "
                f"|{tokens_used} / {context_length} ]"
            )
            yield event(
                type="response",
                parts=split_json(chunk | {"message": MARKER}, received_message),
                tokens=tokens,
                memory=str(messages),
            )

            if not tool_calls:
                return

            for call in tool_calls:
                name = call["function"]["name"]
                arguments = call["function"].get("arguments", {})
                if stop_requested.is_set():
                    # every tool call needs a result, or the next request is inconsistent
                    result = STOPPED_RESULT
                else:
                    result = run_tool(name, arguments, enabled_tools)
                if isinstance(result, tuple):
                    result = yield from apply_change(name, *result)
                elif isinstance(result, dict):
                    result = yield from execute_command(result["command"])
                conversation.append({"role": "tool", "tool_name": name, "content": result})
                yield event(
                    type="tool",
                    name=name,
                    arguments=json.dumps(arguments),
                    result=result,
                    memory=str(messages),
                )

            if stop_requested.is_set():
                yield event(type="stopped", reason="stopped by the user", memory=str(messages))
                return

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

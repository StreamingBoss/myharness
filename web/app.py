"""Web version of harness.py: same chat + context-window tracking, streamed to a browser.

Left pane = chat like you'd see in Claude or another model's UI.
Right pane = what goes to and comes back from Ollama, plus the tools the harness runs.
Bottom box = the harness memory.
"""

import json
import sys
from datetime import datetime

import requests
from flask import Flask, Response, render_template, request

OLLAMA_URL = "http://localhost:11434"
MODEL = "qwen2.5:7b"

app = Flask(__name__)

messages: list[dict] = []  # same role as the list in harness.py — the whole "memory"
context_length: int = 0

MAX_STEPS = 5  # max calls to the model per user message, in case it keeps calling tools


def get_current_time() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


TOOL_FUNCTIONS = {"get_current_time": get_current_time}

# what the model is told about the tools: sent with every request
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "Get the current local date and time",
            "parameters": {"type": "object", "properties": {}},
        },
    }
]


def run_tool(name: str, arguments: dict) -> str:
    if name not in TOOL_FUNCTIONS:
        return f"error: unknown tool '{name}'"
    try:
        return TOOL_FUNCTIONS[name](**arguments)
    except TypeError as e:
        return f"error: bad arguments for '{name}': {e}"


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
        "index.html", model=MODEL, context_length=context_length, memory=str(messages)
    )


@app.route("/reset", methods=["POST"])
def reset():
    messages.clear()
    return {"memory": str(messages)}


@app.route("/chat", methods=["POST"])
def chat_endpoint():
    user_input = request.json["message"]
    use_memory = request.json["use_memory"]
    use_tools = request.json["use_tools"]
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
            payload = {"model": MODEL, "messages": conversation}
            if use_tools:
                payload["tools"] = TOOLS
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
                result = run_tool(name, arguments)
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

    print(f"Model: {MODEL}  (context window: {context_length} tokens)")
    print("Serving on http://localhost:5000")
    app.run(port=5000, debug=True, use_reloader=False)

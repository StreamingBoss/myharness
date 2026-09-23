"""Web version of harness.py: same chat + context-window tracking, streamed to a browser.

Left pane = chat like you'd see in Claude or another model's UI.
Right pane = exactly what harness.py prints to the terminal, streamed live
alongside the chat.
"""

import json
import sys

import requests
from flask import Flask, Response, render_template, request

OLLAMA_URL = "http://localhost:11434"
MODEL = "qwen2.5:7b"

app = Flask(__name__)

messages: list[dict] = []  # same role as the list in harness.py — the whole "memory"
context_length: int = 0


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


@app.route("/chat", methods=["POST"])
def chat_endpoint():
    user_input = request.json["message"]
    messages.append({"role": "user", "content": user_input})

    def generate():
        payload = {
            "model": MODEL,
            "messages": messages,
            "stream": True,
            "options": {"num_ctx": context_length},
        }
        yield json.dumps(
            {"type": "request", "raw": json.dumps(payload, indent=2), "memory": str(messages)}
        ) + "\n"

        reply_parts: list[str] = []

        for raw in stream_chat(payload):
            chunk = json.loads(raw)
            content = chunk.get("message", {}).get("content", "")
            reply_parts.append(content)

            if not chunk.get("done"):
                yield json.dumps({"content": content, "done": False}) + "\n"
                continue

            reply = "".join(reply_parts)
            messages.append({"role": "assistant", "content": reply})

            # final chunk with the reassembled reply = what stream:false would have returned
            chunk["message"]["content"] = reply
            full_response = json.dumps(chunk, indent=2)

            tokens_in = chunk.get("prompt_eval_count", 0)
            tokens_out = chunk.get("eval_count", 0)
            tokens_used = tokens_in + tokens_out

            tokens = (
                f"[{tokens_in} in + {tokens_out} out = {tokens_used} "
                f"|{tokens_used} / {context_length} ]"
            )
            yield json.dumps(
                {
                    "content": content,
                    "raw": full_response,
                    "done": True,
                    "tokens": tokens,
                    "memory": str(messages),
                }
            ) + "\n"

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

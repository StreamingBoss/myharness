"""Minimal chat harness: memory + context-window tracking. No tools, no agents."""

import sys
import requests

OLLAMA_URL = "http://localhost:11434"
MODEL = "qwen2.5:7b"


def get_context_length(model: str) -> int:
    resp = requests.get(f"{OLLAMA_URL}/api/tags")
    resp.raise_for_status()
    for entry in resp.json()["models"]:
        if entry["name"] == model:
            return entry["details"]["context_length"]
    raise ValueError(f"Model '{model}' not found locally. Run: ollama pull {model}")


def chat(messages: list[dict], num_ctx: int) -> dict:
    resp = requests.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": MODEL,
            "messages": messages,
            "stream": False,
            "options": {"num_ctx": num_ctx},
        },
    )
    resp.raise_for_status()
    return resp.json()


def main():
    try:
        context_length = get_context_length(MODEL)
    except requests.exceptions.ConnectionError:
        print("Could not reach Ollama at localhost:11434 — is the server running?")
        sys.exit(1)

    print(f"Model: {MODEL}  (context window: {context_length} tokens)")
    print("Type 'exit' to quit.\n")

    messages: list[dict] = []  # the harness's entire "memory" lives in this list

    while True:
        try:
            user_input = input("").strip()
        except EOFError:
            break
        if user_input.lower() in ("exit", "quit"):
            break
        if not user_input:
            continue

        messages.append({"role": "user", "content": user_input})

        result = chat(messages, context_length)
        reply = result["message"]["content"]
        messages.append({"role": "assistant", "content": reply})

        print(f"{reply}")

        tokens_in = result.get("prompt_eval_count", 0)
        tokens_out = result.get("eval_count", 0)
        tokens_used = tokens_in + tokens_out
        percent_remaining = max(0.0, 100 * (1 - tokens_used / context_length))

        print(
            f"[{tokens_in} in + {tokens_out} out = {tokens_used} "
            f"|{tokens_used} / {context_length} ]\n"
            f"{messages}"
        )


if __name__ == "__main__":
    main()

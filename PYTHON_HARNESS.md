# Writing a basic Python harness

This walks through `harness.py` in this repo: a minimal command-line chat
loop against the local Ollama model (see [OLLAMA.md](OLLAMA.md) for how that
server is set up). It does exactly three things and nothing else:

1. Keeps a running conversation so the model has "memory" across turns.
2. Tracks how much of the model's context window each turn has used.
3. Prints the token count and % of context window remaining after every turn.

No tools, no skills, no multi-step agent behavior — that's for later.

## Part 1 — virtual environments

A **virtual environment** ("venv") is a private, isolated copy of Python
just for this project: its own `pip install`s, separate from your system
Python and from any other project's dependencies. Without it, installing a
package for one project can silently break the version another project
needs — a very common beginner trap.

**Create one** (once per project):
```bash
cd /home/streamingboss/code/myharness
python3 -m venv .venv
```
This creates a `.venv/` folder containing a private Python interpreter and
its own `site-packages`. It should never be committed to git — this repo's
`.gitignore` already excludes it.

**Activate it** (once per terminal session — do this every time you open a
new shell to work on this project):
```bash
source .venv/bin/activate
```
Your prompt will usually change to show `(.venv)`. From this point on,
`python3` and `pip` inside this shell refer to the venv's private copies,
not the system ones.

**Install packages** (only needed once, or whenever you add a new
dependency):
```bash
pip install requests
```

**Record dependencies** so the project is reproducible elsewhere:
```bash
pip freeze > requirements.txt
```
Anyone (including future you, on a fresh machine) can then recreate the
exact same environment with:
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**Deactivate** when you're done (returns to system Python):
```bash
deactivate
```

This repo already has `.venv/` set up with `requests` installed and
`requirements.txt` committed, so day-to-day you only need the *activate*
step above before running anything.

## Part 2 — what "memory" actually means here

Ollama's `/api/chat` endpoint is **stateless**: it has no idea a previous
call ever happened. Every request stands alone. So "memory" in a harness is
nothing magical — it's just a Python list, kept in the harness process, that
gets **resent in full on every turn**:

```python
messages: list[dict] = []

messages.append({"role": "user", "content": "My favorite number is 42."})
# → send the whole `messages` list to the model, get a reply
messages.append({"role": "assistant", "content": reply})

messages.append({"role": "user", "content": "What's my favorite number?"})
# → send the whole `messages` list again (now 3 entries) — the model sees
#   the full history and can answer correctly
```

The model answering "42" on turn two isn't remembering anything itself —
your harness is doing the remembering, by re-transmitting the transcript
every time. This is also *why* token usage grows every turn: you're paying
to re-process the entire conversation so far, not just the new message.

## Part 3 — tracking the context window

Every model has a maximum number of tokens it can hold at once — the
**context window**. For `qwen2.5:7b` that's 32768 tokens. Once
`messages` plus the model's reply exceeds that, something has to give
(older messages get dropped or the request fails) — this harness doesn't
implement that eviction logic yet, it just makes the number visible so you
can see it coming.

Two API calls matter:

**1. Look up the context window size, once, at startup:**
```python
resp = requests.get("http://localhost:11434/api/tags")
for entry in resp.json()["models"]:
    if entry["name"] == "qwen2.5:7b":
        context_length = entry["details"]["context_length"]  # 32768
```

**2. Pin every request to use that full window explicitly**, instead of
trusting Ollama's own default (which may be smaller or otherwise not equal
to what you're tracking against — being explicit here keeps the math
honest):
```python
requests.post("http://localhost:11434/api/chat", json={
    "model": "qwen2.5:7b",
    "messages": messages,
    "stream": False,
    "options": {"num_ctx": context_length},
})
```

**3. After each reply, read the token counts straight from the response**
(see [OLLAMA.md](OLLAMA.md#5-raw-wire-format) for the full field list):
- `prompt_eval_count` — tokens in everything sent *into* the model this
  turn (the whole resent history).
- `eval_count` — tokens the model generated *out* this turn.

Their sum is how many tokens of the context window are occupied right now:
```python
tokens_used = result["prompt_eval_count"] + result["eval_count"]
percent_remaining = 100 * (1 - tokens_used / context_length)
```

## Part 4 — the full harness

```python
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
            user_input = input("You: ").strip()
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

        print(f"\nAssistant: {reply}\n")

        tokens_in = result.get("prompt_eval_count", 0)
        tokens_out = result.get("eval_count", 0)
        tokens_used = tokens_in + tokens_out
        percent_remaining = max(0.0, 100 * (1 - tokens_used / context_length))

        print(
            f"[tokens this round: {tokens_in} in + {tokens_out} out = {tokens_used} "
            f"| context remaining: {percent_remaining:.1f}%]\n"
        )


if __name__ == "__main__":
    main()
```

## Running it

```bash
source .venv/bin/activate
python3 harness.py
```

Real transcript from testing this exact script:
```
Model: qwen2.5:7b  (context window: 32768 tokens)
Type 'exit' to quit.

You: My favorite number is 42. Remember it.

Assistant: Of course! I've remembered your favorite number, which is 42. Is there anything specific you'd like to know about this number or any particular context you have in mind?

[tokens this round: 40 in + 38 out = 78 | context remaining: 99.8%]

You: What is my favorite number?

Assistant: Your favorite number is 42. Is there anything specific you'd like to know about this number or any particular context you have in mind?

[tokens this round: 93 in + 30 out = 123 | context remaining: 99.6%]

You: exit
```

Notice `prompt_eval_count` jumps from 40 → 93 on turn two — that's the
first exchange being resent in full, plus the new question, plus the
model's own turn-formatting overhead. That growth is exactly what fills the
context window over a long conversation, and exactly what this harness now
makes visible.

## Where this doesn't go (yet)

On purpose, this version has no:
- **Trimming/summarization** when the context gets close to full — it'll
  just keep growing until requests start failing or Ollama truncates.
- **Streaming** — it waits for the full reply (`stream: false`) rather than
  printing tokens as they arrive.
- **Tools, skills, or multi-step planning** — one user turn, one model
  reply, nothing else happens in between.

Each of those is a reasonable "next" step once this base loop feels solid.

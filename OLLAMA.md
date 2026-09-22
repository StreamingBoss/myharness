# Ollama setup notes

Ollama runs natively on **Windows** (not inside WSL2). Because Windows and WSL2
share `localhost`, everything in WSL2 (scripts, curl, the future harness)
reaches it at `http://localhost:11434` with no extra networking setup.

- App: `C:\Users\emman\AppData\Local\Programs\Ollama`
- Models: `D:\Users\emman\.ollama\models` (moved off C: — it was at 95% full)
- Model in use: `qwen2.5:7b` (Q4_K_M, ~4.7GB, fits fully on the RTX 3060's 12GB VRAM)

Ollama on Windows is actually **two processes**:

| Process | Role |
|---|---|
| `ollama app.exe` | Tray app (icon near the clock). Auto-starts at login. Watches and respawns the server if it dies. |
| `ollama.exe` (as `ollama.exe serve`) | The actual API server on port 11434. Does the inference. |

This matters because killing only `ollama.exe` doesn't work — the tray app
just restarts it.

## Stopping the server

**GUI:** click the tray icon → **Quit Ollama**. Stops both processes.

**From WSL2:**
```bash
powershell.exe -Command "Stop-Process -Name 'ollama app' -Force -ErrorAction SilentlyContinue; Stop-Process -Name 'ollama' -Force -ErrorAction SilentlyContinue"
```

## Starting the server

**GUI:** Start Menu → "Ollama".

**From WSL2:**
```bash
powershell.exe -Command "Start-Process 'C:\Users\emman\AppData\Local\Programs\Ollama\ollama app.exe'"
```

**Foreground mode (no tray app)** — useful for development, shows live
request logs, stop with Ctrl+C. Don't run this at the same time as the tray
app (both will try to bind port 11434):
```bash
powershell.exe -Command "& 'C:\Users\emman\AppData\Local\Programs\Ollama\ollama.exe' serve"
```

## Restarting

There's no single "restart" — just stop, then start. The one gotcha:
**environment variable changes (e.g. `OLLAMA_MODELS`) only take effect for
processes started *after* the change.** Reopening a window isn't enough; you
need to fully quit (tray icon → Quit, not just close) and relaunch.

## Sanity checks

```bash
curl http://localhost:11434/api/version    # is the server up?
curl http://localhost:11434/api/tags       # which models does it see?
cmd.exe /c "tasklist | findstr /i ollama"  # are the processes running?
```

Ollama auto-launches at Windows login by default, so after a reboot it
should already be running without manual intervention.

---

## Using the model directly (no harness)

Ways to talk to the model before any custom harness code exists.

### 1. Interactive chat via the CLI

```bash
ollama run qwen2.5:7b
```
(From WSL2, prefix with `cmd.exe /c` and the full path, or add the Windows
Ollama folder to your WSL `PATH`.) Drops into a REPL; `/bye` to exit.

Other useful CLI commands:
```bash
ollama list          # models you have pulled
ollama ps            # what's currently loaded in memory / GPU
ollama stop qwen2.5:7b   # unload the model from VRAM
```

### 2. REST API — native endpoint

Single-shot generation:
```bash
curl http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:7b",
  "prompt": "Explain what a KV cache is in one sentence.",
  "stream": false
}'
```

Chat-style (multi-turn, with roles):
```bash
curl http://localhost:11434/api/chat -d '{
  "model": "qwen2.5:7b",
  "messages": [
    {"role": "system", "content": "You are a concise assistant."},
    {"role": "user", "content": "What is 2+2?"}
  ],
  "stream": false
}'
```
Drop `"stream": false` (or set it `true`) to get newline-delimited JSON
chunks streamed back instead of one final blob — this is what a real harness
would consume.

### 3. REST API — OpenAI-compatible endpoint

Same server, different path, shaped like the OpenAI Chat Completions API:
```bash
curl http://localhost:11434/v1/chat/completions -d '{
  "model": "qwen2.5:7b",
  "messages": [{"role": "user", "content": "What is 2+2?"}]
}'
```

### 4. From Python, without any harness code

Using the OpenAI SDK pointed at the local server:
```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:11434/v1", api_key="unused")

resp = client.chat.completions.create(
    model="qwen2.5:7b",
    messages=[{"role": "user", "content": "What is 2+2?"}],
)
print(resp.choices[0].message.content)
```

Or plain `requests` against the native API:
```python
import requests

resp = requests.post("http://localhost:11434/api/chat", json={
    "model": "qwen2.5:7b",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": False,
})
print(resp.json()["message"]["content"])
```

`qwen2.5:7b` also supports the `tools` field in `/api/chat` and
`/v1/chat/completions` for function-calling — relevant once the harness
starts giving the model tools to call.

### 5. Raw wire format

This is what a harness actually has to parse — not the pretty printed
content, the literal bytes on the wire.

**Non-streaming** (`"stream": false`) — one JSON object:
```json
{
    "model": "qwen2.5:7b",
    "created_at": "2026-09-22T19:05:59.0801598Z",
    "message": {
        "role": "assistant",
        "content": "2 + 2 equals 4."
    },
    "done": true,
    "done_reason": "stop",
    "total_duration": 6866930900,
    "load_duration": 6616206300,
    "prompt_eval_count": 36,
    "prompt_eval_cached_count": 0,
    "prompt_eval_duration": 100309000,
    "eval_count": 9,
    "eval_duration": 146917000
}
```
- `total_duration` / `load_duration` / `eval_duration` are in **nanoseconds**.
- `prompt_eval_count` = input tokens, `eval_count` = output tokens.
- `prompt_eval_cached_count` = how many of the input tokens were served from
  Ollama's prompt cache (see the streaming example below — it jumps to 24/37
  on the second call because the system/model context was already warm).

**Streaming** (default, or `"stream": true`) — newline-delimited JSON,
one object per token/small chunk, no wrapping array or commas:
```json
{"model":"qwen2.5:7b","created_at":"2026-09-22T19:06:02.7626271Z","message":{"role":"assistant","content":"Sure"},"done":false}
{"model":"qwen2.5:7b","created_at":"2026-09-22T19:06:02.815752Z","message":{"role":"assistant","content":"!"},"done":false}
{"model":"qwen2.5:7b","created_at":"2026-09-22T19:06:02.8713516Z","message":{"role":"assistant","content":" Here"},"done":false}
...
{"model":"qwen2.5:7b","created_at":"2026-09-22T19:06:03.2074778Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","total_duration":539118700,"load_duration":2088100,"prompt_eval_count":37,"prompt_eval_cached_count":24,"prompt_eval_duration":89255000,"eval_count":23,"eval_duration":445044000}
```
A harness reading this:
1. Reads the HTTP response line by line (each line is a complete JSON object).
2. Appends each chunk's `message.content` to build the full reply.
3. Stops when it sees `"done": true` — that final line also carries the
   stats block (durations, token counts) instead of more content.

This NDJSON-per-line shape (not SSE, no `data:` prefix, no `[DONE]` sentinel)
is specific to Ollama's native API. The OpenAI-compatible endpoint
(`/v1/chat/completions`) streams as actual Server-Sent Events instead
(`data: {...}` lines, terminated by `data: [DONE]`), which matters if the
harness is meant to also work against real OpenAI-style APIs later.

# Tokenization viewer

Select **Explore → tokenization of a saved request** at the bottom of the UI.
Choose a model call and click **Inspect selected request**. Tool follow-ups and
compaction requests can be inspected individually. Opening or replaying a saved
inspection does not call a model or tokenizer. Fresh inspection can use provider
quota; it never executes agent tools.

Alternating colours show token boundaries, not semantic categories. Click a
piece for its position, model-specific ID and raw bytes. Spaces/newlines/tabs use
visible display symbols. UTF-8 characters can span tokens, so individual invalid
UTF-8 pieces display hex escapes; the combined-byte preview restores the text.
IDs are stored as strings to preserve large provider IDs exactly.

The view opens to at least 45% of the window height. The pieces come first; the
explanation, model/provider, source, coverage and limitations always remain
visible directly below them. When a result has no pieces, a highlighted notice
says so first and gives the reason. Displayed token counts are separate from the input
count reported during the original generation. Equal counts do not establish
identical token sequences.

During inspection, the viewer displays backend progress: locating the model,
loading or reusing llama.cpp, rendering the saved prompt with Ollama, and
requesting token pieces. Progress is read-only and never advances the agent loop.
A failed Ollama rendering request or llama.cpp tokenization request identifies
that service and gives recovery steps; raw provider responses are not displayed.
The tokenizer helper transport allows up to 260 seconds to cover the existing
30-second startup, 180-second rendering and 30-second tokenization limits.
Stop still cancels inspection. Unavailable results remain retryable.

## What "exact" means here

This implementation does **not** claim to capture the full inference token
sequence. Standard Ollama chat does not expose input IDs, and remote Gemini does
not expose its complete internal prompt. The viewer reports evidence honestly:

- **Provider tokenization of text:** actual pieces and IDs returned by Vertex AI
  for saved text segments, not hidden chat formatting or tool serialization.
- **Configured tokenizer:** actual pieces returned by a llama.cpp service for a
  prompt rendered separately by Ollama. Model identity is configured by the
  operator, not independently verified. It is not an inference trace.
- **Count only:** an API-reported count; token boundaries/IDs are unavailable.
- **Unavailable:** no fabricated pieces and no generic-tokenizer fallback.

A future full inference trace requires instrumenting the inference backend at
its prepared-token boundary. It should use a new explicit evidence type only
when the sequence is captured there, including additions and truncation. No
Ollama patch or unsupported internal runner endpoint is required by this version.

## Model vocabulary

Explore → "model vocabulary" lists every token the selected model can read or write, in ID
order, with search, a whole-piece option and "Go to ID". `Harness.vocabulary()` builds it
from Ollama's `/api/show` with `verbose: true` (the tokenizer fields `tokenizer.ggml.tokens`
and `token_type`; no weights are loaded), decodes byte-level BPE and SentencePiece pieces to
real text in `typescript/src/vocabulary.ts`, caches it for the selected model and serves
pages through `POST /vocabulary` (also the browser worker action `vocabulary`). Providers that
do not publish a vocabulary, such as the remote APIs, get an explanation instead of a list.

## Special tokens

Control tokens such as `<|im_end|>` carry structure, not words. `tokenPiece()` in
`typescript/src/tokenization.ts` looks up each piece's exact text in the glossary in
`typescript/src/special-tokens.ts` and adds an optional `special` field (label, meaning,
model families). The viewer shows it on hover and when the token is clicked. A tokenizer
returns only IDs and bytes, and IDs differ between models, so recognition is by text:
the glossary covers ChatML/Qwen, Llama 2/3, Mistral, Gemma, Phi, gpt-oss and DeepSeek
markers, and any other `<|…|>` token gets a generic "control token" note. Tokens that are
not recognised have no `special` field. Add a model family by adding entries to the table.

## Local Ollama

Without additional setup, inspection can show Ollama's rendered prompt if the
installed version supports `_debug_render_only`. Unsupported versions may
ignore the flag: inspection limits generation to one token and rejects that
response as rendering evidence. This extra inspection request can load the
model. It does not change chat memory or generate a chat reply.

To see token pieces, run a separate **llama.cpp server with the matching GGUF**.
Use the exact model file/vocabulary, including model revision, rather than a
similarly named model. Configure the server alias explicitly:

```bash
llama-server -m /path/to/the-matching-model.gguf --alias qwen3:8b --port 8081
```

Then configure myharness before starting it:

```bash
export MYHARNESS_TOKENIZERS='{"qwen3:8b":{"url":"http://localhost:8081","alias":"qwen3:8b","identity":"GGUF SHA-256 and revision you verified"}}'
npm run start:ts
```

Bindings are keyed by the **exact Ollama model ID**, not a substring/family.
The adapter checks that the configured service advertises the requested alias;
this does not verify its vocabulary or model digest. The operator must verify
the matching GGUF. A switched/unconfigured model shows an explanation instead
of reusing the previous tokenizer. llama.cpp `/tokenize` is called with
`with_pieces=true`, `parse_special=true`, `add_special=false`: automatic BOS/EOS
insertion is deliberately not guessed. Ollama runner additions or later
truncation can differ from this separately rendered/tokenized prompt.

## Browser harness through the tokenizer helper

A web page cannot read a model file, so the browser edition shows token pieces
for a local Ollama model through an optional **tokenizer helper**: one small
native program (under 10 MB, nothing else to install) that runs on the same
computer as Ollama. The page renders the saved request with Ollama as usual and
sends the rendered text to the helper, which splits it with the model's own
vocabulary. The helper tokenizes text and does nothing else: it reads no project
files, runs no commands, holds no conversation, never generates, and accepts no
file path or address from the browser. Without the helper, the viewer still
shows the rendered prompt, the counts and the model vocabulary.

### Use it

1. Download the helper for your system from the
   [latest release](https://github.com/StreamingBoss/myharness/releases/latest),
   unpack it and start it in a terminal:

   ```bash
   ./token-helper                                    # serves https://harnessarium.com
   ./token-helper --origin http://localhost:5001     # serves another page
   ```

   On Windows the program is `token-helper.exe`. It listens on
   `http://127.0.0.1:5002`. `--origin` names the exact website that may use it
   and can be repeated; `--port` changes the port.
2. In the harness, open **Tokens**. Under a request without token pieces, open
   **Show token pieces for my Ollama model (optional)** and click **Connect**.
3. Click **Inspect selected request**.

There is no pairing code. The helper refuses every website except the ones it
was started for, checked on each request from the browser's `Origin` and `Host`
headers. Another program already running on your computer could call it, but
such a program could read the model files itself.

After the first Connect, the browser remembers only that you use the helper
(its loopback address; nothing secret). On later visits the page contacts
nothing until you open the Tokens view; then it reconnects without a click, and
an inspection reconnects by itself too. If the helper is not running, the panel
says so and shows the start command. **Forget helper** stops this. Your browser
may ask once to allow the site to reach devices on your local network.

### Start at every login

```bash
./token-helper --install       # add the same --origin and --port you use
./token-helper --uninstall
./token-helper --print-install # show the entry without changing anything
```

`--install` adds an entry for your user account only and needs no administrator
rights: a systemd user service on Linux, a launch agent on macOS, a `Run`
registry value on Windows. It records the program's own location, the `--origin`
and `--port` given, and those of `OLLAMA_URL`, `MYHARNESS_TOKENIZER_MODELS` and
`MYHARNESS_WSL_MOUNT_ROOT` that are set; nothing else from your environment. On
Windows those settings cannot be recorded, so set them for your user account
instead; the helper also starts only at the next login there. If the entry
cannot be enabled, it is removed again. Run `--install` again after moving the
program.

### How it finds the vocabulary

For each request the helper needs the GGUF file of the exact model:

- By default it asks its own Ollama (`OLLAMA_URL`, default
  `http://localhost:11434`) which file the model uses, and reads that file. This
  needs Ollama on the same computer, reached over plain `http://`.
- For Docker, a remote Ollama or an `https://` address, name the file yourself:

  ```bash
  export MYHARNESS_TOKENIZER_MODELS='{"qwen3:8b":"/absolute/path/to/matching-model.gguf"}'
  ```

Windows Ollama reports drive paths such as `D:\Users\...`. On Windows they are
used as they are; under WSL they become `/mnt/d/Users/...`
(`MYHARNESS_WSL_MOUNT_ROOT` changes `/mnt`).

The helper checks the GGUF header and loads the vocabulary only: llama.cpp's
`vocab_only` skips all weight tensors, and there is no inference context and no
GPU use. One vocabulary stays loaded; another model or a changed file replaces
it. Special markers in the text are parsed, automatic BOS/EOS insertion is
disabled, and a token's bytes need not be valid UTF-8 on their own. A request is
limited to 8 MiB of text. Explanations sent to the page never contain a path.

The page compares its own Ollama address with the helper's, because the prompt
is rendered by one and the vocabulary found through the other. Model matching
remains the operator's responsibility when a file is named by hand, and the
evidence is labelled separate tokenization: it is not an inference trace.

### Protocol

Two requests, both `POST` with a JSON body, on `http://127.0.0.1:5002`:

| Request | Body | Answer |
|---|---|---|
| `/v1/info` | `{}` | `{ "value": { "protocol": 2, "ollamaUrl", "models", "automatic" } }` |
| `/v1/tokenize` | `{ "model", "content" }` | `{ "value": { "identity", "tokens": [{ "id", "bytes" }] } }` |

`403` means the website is not allowed, `422` carries a plain explanation of why
this model cannot be tokenized, `400` and `413` reject a malformed or oversized
request. `typescript/src/helper-protocol.ts` and `native/tokenizer/main.cpp` are
the two sides.

### The downloads

`.github/workflows/token-helper.yml` builds the helper for Linux (x64), macOS
(Apple silicon) and Windows (x64). Pushing a tag such as `token-helper-v1`
publishes the downloads as a GitHub release; running the workflow by hand only
builds them. On each system the built program is checked with
`scripts/smoke-token-helper.mjs`, which uses the page's own client code and a
real Qwen vocabulary file; on Linux `native/tokenizer/tests/verify.py` runs too.

The downloads are not signed by a registered developer. macOS asks for
confirmation under System Settings → Privacy & Security, and Windows shows
"Windows protected your PC" (More info → Run anyway). The macOS and Windows
builds have not yet been run on real machines; the Windows job reports its
result without blocking the other systems.

### Build it from source

The helper is built from `native/tokenizer` against llama.cpp at a pinned
revision, with the HTTP and JSON libraries that llama.cpp already ships. On
Ubuntu/WSL, install Git, CMake and a C++ compiler, then run:

```bash
sudo apt update
sudo apt install -y git cmake build-essential
npm run build:token-helper        # cmake configure and build
npm run token-helper -- --origin http://localhost:5001
```

The first build downloads llama.cpp source. For an offline build, use an
existing checkout of the pinned revision:

```bash
cmake -S native/tokenizer -B dist/tokenizer \
  -DMYHARNESS_LLAMA_SOURCE=/absolute/path/to/llama.cpp
```

The pin is recorded in `native/tokenizer/CMakeLists.txt`. The program is
statically linked and built without TLS.

Migration: the loopback bridge (`npm run bridge:ts`, pairing codes, `--allow-*`
grants), the Node tokenizer helper (`npm run token-helper:ts`) and the separate
`myharness-tokenizer` program with its `MYHARNESS_LLAMA_TOKENIZER` setting have
been removed. The helper no longer uses `MYHARNESS_TOKENIZERS`; that setting
still configures an operator-run llama.cpp tokenizer for the Node edition.
Shell commands, native files and web search are available in the Node edition
only.

Successful inspections save rendered text and token evidence; replaying them
requires no model or helper. Remote API adapters do not use the helper and keep
their existing pieces/count/unavailable behavior.

## Remote Gemini in the Node runtime

Gemini generation uses a native provider adapter, so the right pane displays the
actual Google JSON request, not the internal Ollama-shaped harness request.
Generation is currently delivered as a terminal response rather than streamed
text. Tool calls/results and thought signatures survive subsequent calls and
saved-session restoration. Credentials are held only by the model adapter;
they are not saved in request events, sessions or exports.

Start a new session when changing provider/model. Use separate sessions folders
if switching between providers so startup does not restore the wrong model.
The context length is an explicit harness budget, not discovered model metadata.

### Gemini Developer API (AI Studio API key)

```bash
export MYHARNESS_PROVIDER=gemini
export MYHARNESS_MODEL=gemini-3.8-flash
export GEMINI_API_KEY='your-key'
export MYHARNESS_CONTEXT_LENGTH=32768
export MYHARNESS_SESSIONS=/path/to/gemini-sessions
npm run start:ts
```

The native Interactions adapter reports individual input tokens as unavailable;
measured generation usage is shown separately. It never treats a generateContent
count as an exact Interactions count. The legacy injectable `GeminiAdapter` still
supports `countTokens` with `generateContentRequest`, returning count-only
evidence for its own requests. No request is silently routed through Vertex AI
or a substitute tokenizer.

### Gemini through Vertex AI

```bash
export MYHARNESS_PROVIDER=vertex
export MYHARNESS_MODEL=gemini-2.5-flash
export GOOGLE_CLOUD_PROJECT='your-project'
export GOOGLE_CLOUD_LOCATION=global
export GOOGLE_ACCESS_TOKEN='your-current-access-token'
export MYHARNESS_CONTEXT_LENGTH=32768
export MYHARNESS_SESSIONS=/path/to/vertex-sessions
npm run start:ts
```

The token must authorize the requested Vertex APIs. Refresh expired credentials
outside myharness and restart when ready; no credential acquisition is automated.
Model/region/permission availability is checked by the provider response.

`computeTokens` returns provider token IDs and base64 byte pieces for text-only
content on supported models. We inspect each system/user/assistant text segment
separately. System text is sent as user text solely to obtain its text tokens.
Function declarations, function calls/results, thought signatures, role markers,
media and hidden provider formatting are excluded. This is explained visibly;
the sum is labelled displayed text tokens, not the full inference input count.

## Browser runtime

The static browser edition supports the shared inspection endpoint through its
Worker transport. The scripted demo has no tokenizer and says so. Browser
Ollama can show supported debug rendering; configured llama.cpp bindings and
Gemini credentials are currently configured through the Node runtime described
above, not the browser model controls.

## Saving and errors

Successful pieces/count evidence is saved as a session event referring to the
original request's event index. It replays without network calls and keeps its
original model label. Unsupported/failed inspections remain retryable. A request
belonging to another provider is refused rather than sent elsewhere. Inspection
locks session/model changes and new turns; Stop cancels its adapter request.
Inspecting now can reflect a changed model/server revision; saved evidence does
not retroactively change. This limitation is shown in the view.

No live Gemini account or local tokenizer service is required by deterministic
checks. They verify the adapters using scripted HTTP responses, not live-provider
parity. Live integration is still required to validate an operator's installed
Ollama version, matching GGUF and Gemini account/model permissions.

## References

- https://docs.ollama.com/api/chat
- https://github.com/ollama/ollama/blob/main/server/routes.go
- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- https://ai.google.dev/api/tokens
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/projects.locations.publishers.models/computeTokens

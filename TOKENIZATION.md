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
The bridge inspection transport allows up to 260 seconds to cover the existing
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

## Browser harness through the local bridge

The paired bridge can render Ollama prompts and call the matching llama.cpp
server on behalf of the browser. The browser needs access to the bridge, but
llama.cpp does not need browser CORS settings or a public listening address.
The browser still connects directly to Ollama for ordinary chat.

Install llama.cpp once using the [official build instructions](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md).
On Ubuntu, the CPU build is:

```bash
sudo apt update
sudo apt install -y git cmake build-essential
git clone https://github.com/ggml-org/llama.cpp.git "$HOME/llama.cpp"
cmake -S "$HOME/llama.cpp" -B "$HOME/llama.cpp/build" -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF
cmake --build "$HOME/llama.cpp/build" --config Release --target llama-server -j4
export MYHARNESS_LLAMA_SERVER="$HOME/llama.cpp/build/bin/llama-server"
```

Run the export in the bridge terminal. If `llama-server` is already on PATH, it
is discovered automatically. Then **start only the bridge**:

```bash
npm run bridge:ts -- --workspace "$(pwd)" --origin http://localhost:5001 --port 5002 --allow-tokenizer
```

Use your page's exact origin. Add the existing writes, commands or Git-write flags
only for those capabilities; token inspection does not need general Bash grants.
Hard-refresh Guide & Setup and pair using the new code. Connect Ollama with the
same URL as the bridge's `OLLAMA_URL` (default `http://localhost:11434`), select the
exact model ID, and send a message in the linked harness. Open **Explore →
tokenization of a saved request → Inspect selected request**.

On the first inspection the bridge asks local Ollama for its model file, verifies
the GGUF header, starts llama-server on an unused loopback port, and waits for its
model alias to appear. Subsequent inspections reuse that owned process. Switching
models or changing the file replaces it; unpairing, ending the session, lease
expiry or bridge shutdown stops it. Startup cancellation also stops the process.
The bridge never runs an installation shell or downloads models. It strips
`LLAMA_ARG_*` defaults so they cannot enable llama.cpp agent tools or alter the
fixed launch arguments. Startup has a 30-second deadline. The managed server uses
CPU, one slot and a small context, but still loads the model weights separately.

Windows Ollama drive paths are automatically translated to standard WSL mounts:
`D:\Users\...` becomes `/mnt/d/Users/...`. If the file is readable there, no
manual mapping is needed. Custom drive mounts, Docker or remote Ollama may still
return paths inaccessible from the bridge. Supply an exact model-to-local-file mapping in the bridge terminal:

```bash
export OLLAMA_URL=http://your-ollama-host:11434
export MYHARNESS_TOKENIZER_MODELS='{"qwen3:8b":"/absolute/path/to/matching-model.gguf"}'
```

Remote hosts require this explicit mapping. Verify the same vocabulary and model
revision; automatic local discovery records the Ollama-reported file identity,
while overrides are labelled operator-configured. Neither is an inference trace.
Inspection reports missing executables, inaccessible models and startup failures
without exposing process output. Ollama must support `_debug_render_only`.

If you prefer an already running tokenizer, configure `MYHARNESS_TOKENIZERS` as
shown above. Those exact model bindings take precedence and do not require
`--allow-tokenizer`. Previously saved successful inspections replay their saved
evidence without launching a process.

The bridge advertises explicit model bindings and its automatic-start grant, validates saved-request structure,
and only calls its own configured Ollama and tokenizer endpoints. A browser
cannot supply a tokenizer URL or use this operation as a general network proxy.
Pairing, origin checks, cancellation and connection leases apply to inspection.
The bridge holds no conversation or agent loop, and never executes agent tools
as part of inspection. Ollama must support `_debug_render_only`; otherwise the
viewer explains why no pieces are available. Model matching remains the
operator's responsibility, and the evidence is labelled separate tokenization.

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

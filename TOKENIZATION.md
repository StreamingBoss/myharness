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

The explanation, model/provider, source, coverage and limitations always remain
beside the visualization. Displayed token counts are separate from the input
count reported during the original generation. Equal counts do not establish
identical token sequences.

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
export MYHARNESS_MODEL=gemini-2.5-flash
export GEMINI_API_KEY='your-key'
export MYHARNESS_CONTEXT_LENGTH=32768
export MYHARNESS_SESSIONS=/path/to/gemini-sessions
npm run start:ts
```

Inspection calls `countTokens` with `generateContentRequest`, covering submitted
contents, system instructions and function declarations. This documented API
returns counts, not individual input IDs: the viewer explicitly says **count
only**. Generation usage can differ from a separate count request. No request
is silently routed through Vertex AI or a substitute tokenizer.

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

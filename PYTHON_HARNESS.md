# Memory in the minimal Python reference

[`harness.py`](harness.py) is the intentionally small reference: one model call
per message, a retained conversation list, and input/output token counts. The
full backend adds tools, approvals, skills, streaming and context management.
Use the [README](README.md) to run that version.

## What “memory” means

Every `/api/chat` request contains the conversation the model should see.
The harness appends a user message, sends the list, then appends the assistant's
answer. On the next turn it sends that growing list again:

```json
[
  {"role": "user", "content": "My favourite number is 42."},
  {"role": "assistant", "content": "Understood."},
  {"role": "user", "content": "What is my favourite number?"}
]
```

The harness keeps this state. The model does not retain a personal conversation
between independent API requests. Ollama may cache work on a shared prompt
prefix; that cache is different from the harness's conversation memory.

## What the counters mean

`prompt_eval_count` measures input tokens and `eval_count` measures generated
tokens. The script prints their sum and the configured window size, followed
by the Python messages list. Counts include formatting overhead and are not
simply word counts. They describe the completed request, not a precise forecast
of what the next turn will need.

The script sets `options.num_ctx` explicitly. It does not trim or summarize
history, stream output, execute tools or persist sessions. Long conversations
can overflow the context window.

## Running the reference

After the setup in the README, pull its separate model:

```bash
ollama pull qwen2.5:7b
.venv/bin/python harness.py
```

Type `exit` or `quit` to finish; EOF also exits. Memory disappears with the
process. This reference remains unchanged for comparison with the full harness.

**Compatibility limitation:** the reference reads `details.context_length`
from `/api/tags`. Current Ollama documents model context metadata under
`model_info` from `/api/show`, so the unchanged reference can fail at startup
with `KeyError` on installations that omit that field. The maintained full
backend uses `/api/show`. See the
[Ollama API reference](https://github.com/ollama/ollama/blob/main/docs/api.md#show-model-information).

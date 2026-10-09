# Guide & Setup implementation

The separate `guide.html` page implements the first delivery in
[browser-guide-connections-plan.md](browser-guide-connections-plan.md).
The existing preview and proposal remain unchanged.

## Run it

```bash
npm run start:browser
```

Open `http://localhost:5001/guide.html`. Choose shared-computer or personal-device
mode, connect Ollama or Gemini/OpenAI/Anthropic, and open the existing harness.
The guide owns a dedicated backend Worker; the harness attaches through a private
MessageChannel. Keep both tabs open. Ordinary `index.html` still starts its own
backend. The Node distribution also serves `/guide.html` after
`npm run build:browser`; its existing `/` landing page remains the Node harness.

The four manual lessons use the bundled disposable browser project and existing
request, tool, memory and approval inspection. They do not submit tasks or change
projects automatically. A model is external inference; Ollama does not supply a
shell. Existing GitHub HTTP MCP configuration supplies remote repository tools
when the server permits browser connections.

## Local workspace capabilities

```bash
npm run bridge:ts -- \
  --workspace /path/to/scratch-project \
  --origin https://your-harness.example \
  --port 5001 \
  --allow-writes --allow-commands --allow-git-writes
```

For a local guide use its exact origin, such as `http://localhost:5001`, and run
the bridge on a different unused port. Do not share the static server's port.
The bridge supports Linux, macOS and WSL. It binds only to `127.0.0.1`, starts with
the configured workspace and owns no conversation or agent loop. Pair with the printed five-minute,
single-use code. Omitted flags leave the corresponding effects unavailable.
The guide reports these grants; website controls cannot increase them.

When paired, **Choose bridge folder…** browses native directories through the
bridge. Select any local repository, or type its absolute native path into the
Project folder field and click Set. Browser directory handles cannot supply the
absolute path needed for a command's working directory. The authenticated
`selectProject` operation registers each chosen directory; file, Git and command
requests carry its root explicitly. The initial folder and other selected roots
remain separate, so switching sessions does not redirect their effects. Selecting
another repository keeps the same startup grants and harness approval policy.

The browser backend retains approvals and sends approved effects to native
workspace, Git, command and web-search adapters. Commands have account permissions,
a 60-second default timeout, retained output limits and process-group cancellation.
A workspace working directory is not an OS sandbox. Native file proposals carry
expected contents and reject external changes. Disconnecting never substitutes
an editable browser copy. Unpair bridge restores the browser workspace and keeps
model credentials and conversation. Pairing a replacement requires unpairing or
locking first and starting a fresh bridge process with a new code.

Requests use `/v1/pair` and `/v1/call`, exact Host/Origin checks and in-memory bearer
tokens. Every operation has an ID. Command settlement uses a final NDJSON frame
with the existing output/status shape; incremental output and background jobs are
outside this delivery. Shared-computer bridge pairings have a 120-second lease renewed every five seconds.
Private-computer pairings persist until release or bridge process exit.
Stop and release cancel operations; lease expiry handles missing browser cleanup.

An HTTPS-to-loopback flow is exercised in Chromium with local-network permission.
Browser policies and provider/MCP CORS still determine connectivity; this is not
a claim of universal browser support. Home Ollama needs `OLLAMA_ORIGINS` configured
for the website's exact origin. The bridge is not an inference proxy.

## Privacy and lifecycle

Shared mode is the default. It injects `MemoryStorage` before initialization,
never reads existing browser projects/sessions or opens a credential database,
and clears its storage on End session. Approved external changes and downloads
remain. Personal mode persists ordinary sessions and files unencrypted.

On a personal device, optionally create a vault with a matching passphrase of at
least 12 characters. Explicit model/MCP save actions persist authenticated AES-256-GCM
ciphertext in a separate IndexedDB database. PBKDF2-HMAC-SHA-256 uses 600,000 iterations
and random 16-byte salts; encryption uses fresh 12-byte nonces. Provider/server
identity and endpoint are authenticated bindings. No passphrases, keys or tokens
are placed in cookies, URLs or plaintext browser storage. Authentication redirects
are rejected. The managed flow suppresses the legacy localhost MCP debug logger.

Vaults reopen locked. Unlocking does not resume cancelled work or automatically
connect a provider. Restore a selected credential explicitly. Forget controls
remove selected encrypted entries; Delete removes the vault without deleting
ordinary conversations. Lock clears active connections and keys but retains the
vault. Another website visitor or separate managed session gets no unlocked key.
An already-unlocked session, same-origin malicious scripts, extensions and a
compromised browser/OS remain outside this protection boundary.

Explicit lock, ten minutes without user interaction in shared mode, closing the harness tab, closing/reloading Guide, and End session cancel work and clear unlocked credentials.
Background model output does not count as interaction. Missed linked-page heartbeats do not destroy sessions; the next request resumes
activity. Private mode does not lock credentials for inactivity. Delayed startup and connection completion cannot restore
credentials after locking; End session is idempotent for simultaneous tab cleanup.

### Clarification to the proposal

Bridge bearer tokens deliberately remain session-only. Saving a single-use pairing
code or an origin/process-bound 120-second lease token would not provide a reusable
connection after lock/reload. Re-pairing requires a fresh local startup. The vault
supports connection bindings, but this delivery offers persistence only for model
API keys and HTTP MCP headers. It does not advertise saved bridge authentication.

Copilot remains research rather than an implemented provider. See
[copilot-feasibility.md](copilot-feasibility.md) for the OpenCode comparison and
unverified prerequisites. No OAuth client identity or undocumented token extraction
has been copied.

## Callable boundaries and verification

`BrowserHarness.attachBridge`, `bridgeStatus`, `bridgeHeartbeat` and
`lockCredentials` are callable without the pages. `ManagedSession` owns temporary
storage lifecycle, vault actions, inactivity and link/bridge leases. `ManagedHost`
protects both setup actions and existing harness connection actions from races
with locking. Storage injection remains caller-owned for ordinary SDK use;
managed End session explicitly disposes its storage. `ChannelWorker` and
`SessionRelay` adapt the existing public WorkerClient transport.

The `guide-*` tests cover native effects and cancellation, credential encryption
and binding, asynchronous lock races, private handoff, backend startup, Node asset
routes, guide controls and actual HTTPS browser networking. Tests use deterministic
model fixtures, scratch directories and ephemeral ports; no live model account,
owner service restart, deployment or commit is required.

### Acceptance run

On 2026-10-08, `npm run coverage:ts` passed all 304 tests and the per-file
100% line, branch, function and statement gates for the entire backend and new
page controllers/bootstraps. `node --test tests/ui_response.test.mjs` passed both
checks. The browser ZIP was produced and inspected for `guide.html`, `guide-ui.js`,
`managed-worker.js` and `library.json`. `git diff --check` passed.

Model and bridge connection buttons show immediate progress and sanitized success
or failure messages beside their controls. Buttons are disabled during connection
and secret fields clear on settlement. The guide defaults its bridge address to
`http://127.0.0.1:5002` to avoid the static server’s default port 5001, and shows
the current website origin required by the bridge.

Bridge failure messages include the current page’s exact `--origin` argument,
explain HTTP versus HTTPS, and give restart/fresh-code steps conditionally. They
also cover matching-origin failures without claiming to detect a CORS-blocked
bridge’s configuration.

Token inspection is now available through the paired bridge for explicitly
configured Ollama models. See [TOKENIZATION.md](../TOKENIZATION.md) for
`MYHARNESS_TOKENIZERS`, `OLLAMA_URL`, matching GGUF requirements and browser steps.
Ordinary chat still uses the browser's model connection; prompt rendering and
tokenization use fixed operator endpoints on the bridge.

`--allow-tokenizer` enables dedicated on-demand llama.cpp process management
without enabling Bash. The bridge discovers local Ollama GGUF files; operator
`MYHARNESS_TOKENIZER_MODELS` overrides cover remote/container/WSL paths.
`MYHARNESS_LLAMA_SERVER` selects an installed executable. The bridge owns one
reusable CPU process and stops it on unpair, lease expiry, model replacement or
shutdown. Startup cancellation and failures are explicit. No installation or
model downloads occur. See [TOKENIZATION.md](../TOKENIZATION.md) for setup.

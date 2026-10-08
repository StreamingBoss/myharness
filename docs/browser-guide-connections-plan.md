# Browser Guide, Private Connections, and Local Workspace Bridge

**Status:** Proposed implementation plan.

## 1. Outcome and boundaries

Help users understand agent behavior, what the harness supplies, and how it differs from the LLM. Users begin with guided experiments, then explore their own tasks and source code.

Support two deployment targets:

| Target | Harness execution | Model connection | Workspace and tools |
|---|---|---|---|
| Run locally | Existing Node backend remains supported | Ollama or supported API provider | Existing local files, Git, Bash, web search, and MCP |
| Hosted website | Shared harness backend runs in a browser Worker | Home Ollama or supported API provider | Browser workspace, existing MCP connections, and optional native workspace bridge |

The hosted distribution remains static. It requires no execution server or credential service operated by the website owner.

### Preserve existing behavior

- Keep the current harness layout, displays, and event presentation unchanged.
- Add the guide and new connection/privacy controls on a separate page.
- Permit backend and transport integration changes required to support those controls.
- Keep `Harness` and `HarnessCore` independent of UI, HTTP, DOM, Worker APIs, and platform implementations.
- Keep `harness.py` unchanged.
- Preserve current direct Node, browser SDK, Worker, and headless entrypoints.
- Preserve existing MCP functionality; GitHub remains an example of using it.
- Preserve unrelated working-tree changes and existing planning documents.

### First delivery

Include the separate guide, optional encrypted credential storage, shared-computer mode, native workspace bridge, and Copilot feasibility research.

Defer browser JavaScript/Python execution, arbitrary-language browser builds, background command jobs, Git clone/push/pull additions, website accounts, and server-side credential synchronization.

## 2. Separate Guide & Setup page

Use the approved preview as the layout reference: guided lessons on the left, connection and privacy controls on the right, and an action opening the current harness.

Publish the page as `guide.html` in the static browser distribution. Also make the guide available from the local distribution without changing the existing harness landing page.

### Guided learning

Each lesson contains:

- The concept being demonstrated.
- A small task and required capabilities.
- Explicit settings to change between attempts.
- What to observe in the existing harness.
- A short explanation separating model behavior from harness behavior.
- A statement of what the experiment does not establish.

Initial lessons:

1. **Model versus harness:** compare the same file question with file tools disabled and enabled.
2. **Tools and execution location:** distinguish browser workspace tools, local bridge capabilities, and remote MCP tools.
3. **Instructions and memory:** change instructions and compare follow-ups with memory enabled and disabled.
4. **Approvals and the agent loop:** reject and approve separate proposed changes; follow the result into the next model request.

Include links explaining skills and context management using the current harness's inspection facilities.

Use small bundled text fixtures for the initial lessons. Run file-changing experiments in disposable workspace copies. Never reset or overwrite an existing project automatically.

Manual instructions are the required first implementation. Automated experiment launching is deferred; **Open harness** launches a configured harness, not an automatically submitted task.

Do not imply that displayed thinking or tool events reveal the model's internal reasoning. Explain observable requests, responses, and effects.

### Setup controls

Provide:

- Ollama endpoint, model selection, and connection check.
- Current cloud provider/model selection and session-only API-key entry.
- Personal-device versus shared-computer mode.
- Credential vault creation, unlocking, locking, saving selected credentials, and forgetting them.
- Native bridge pairing, workspace identification, and capability status.
- Guidance for the existing MCP configuration flow.
- **Open harness** and **End session** actions.

Clear password and token fields after successful submission. Show sanitized errors without provider response bodies or credential values.

Default a new guide session to shared-computer mode. Personal persistence requires an explicit selection.

### Guide-to-harness handoff

The guide stays open while the harness runs in a second tab.

- The guide starts a dedicated backend Worker for its managed experiment.
- The harness tab attaches to that backend through a private `MessageChannel` transport.
- Validate the exact origin and expected child-window identity during the handshake.
- Transfer the channel once; do not offer discovery of active backends to other tabs.
- Keep credentials out of URLs, browser history, cookies, localStorage, and plaintext sessionStorage.
- Adapt the existing `WorkerClient` transport; retain the direct dedicated-Worker path for ordinary standalone use.
- Permit one harness tab per managed experiment. Additional experiments require separate guide sessions.

The channel carries backend actions and events. Neither page advances the agent loop or makes approval decisions.

Closing or reloading either linked tab stops the experiment and clears unlocked credentials. Use explicit lifecycle notifications plus a heartbeat fallback; do not depend solely on unload handlers.

The guide remains available for locking, ending the session, and changing connections. Reject connection/workspace changes during active execution using the existing backend execution locks.

## 3. Credentials and session privacy

### Credential vault

Save credentials only when the user explicitly opts in on a personal device.

Introduce a browser-owned vault with:

- A local vault identifier and optional user-facing label.
- Versioned encrypted records in IndexedDB.
- Web Crypto PBKDF2-HMAC-SHA-256, 600,000 iterations, and a random salt of at least 16 bytes.
- AES-256-GCM with a fresh 12-byte nonce for every encryption.
- Authenticated record metadata binding each secret to its connection identity.
- A minimum 12-character passphrase, with confirmation when creating a vault.
- An encrypted verification record for detecting an incorrect passphrase.
- No plaintext passphrase, derived key, or secret stored persistently.

Allow multiple separately locked vaults in one browser profile. Never automatically unlock a vault or inject its credentials into an unrelated experiment.

A forgotten passphrase cannot be recovered. Provide an explicit delete-and-recreate flow without deleting ordinary saved conversations.

### Connection binding

Support saved credentials for:

- Gemini, OpenAI, and Anthropic model connections.
- Authentication headers for existing HTTP MCP connections.
- Bridge connection credentials where explicitly selected.

Bind model credentials to the provider and approved endpoint. Bind MCP credentials to the server identity and configured endpoint.

Changing an endpoint invalidates automatic credential reuse until the user confirms the new connection. Do not forward authentication headers across redirects to another origin.

Existing imported MCP headers remain session-only unless the user explicitly saves them. Preserve the current behavior of stripping headers from ordinary persisted MCP configuration.

Return only credential availability and lock status through state inspection. Secrets must never enter model prompts, tool arguments, transcripts, saved requests, exports, or logs.

### Locking behavior

Lock on:

- Explicit **Lock**.
- Ten minutes without user interaction in either linked page.
- Closing or reloading either linked page.
- **End session**.

Model output and background activity do not extend the user inactivity timer.

Locking must:

1. Cancel active turns, goals, children, and pending approvals.
2. Abort authenticated model/MCP requests and bridge operations.
3. Close authenticated connections.
4. Remove all unlocked credentials and derived-key references.
5. Retain encrypted vault records.

Implement this as an asynchronous backend lifecycle operation. Do not call the existing idle-only `forgetApiKey()` while execution is still active.

Unlocking makes credentials available again but does not resume cancelled work automatically.

### Shared-computer mode

Inject an in-memory storage implementation before backend initialization.

- Do not load existing persistent sessions, projects, directory handles, or vaults.
- Do not write conversation, workspace, settings, or credential data to IndexedDB.
- Keep imported configuration and directory handles in memory only.
- Disable credential saving.
- Keep each managed experiment isolated.
- On **End session**, stop execution, close connections, revoke channels, terminate the Worker, and clear page-held references and input fields.

Exports remain explicit user actions. Ending a session does not delete downloaded exports or undo approved changes already made to local files or GitHub.

On personal devices, conversations and browser workspace files retain ordinary persistence. Only credentials are encrypted.

### Protection boundary

This design isolates remote website visitors and protects locked saved credentials from the next person using the same browser.

It does not promise protection from someone using an already-unlocked session, malicious same-origin application code, browser extensions, or a compromised browser/OS. Keep this limitation in the design documentation and credential-help text.

## 4. Native local workspace bridge

The bridge supplies runtime capabilities while the agent loop remains in the browser.

### Runtime integration

Add a browser bridge adapter implementing the existing workspace, Git, command, and web-search boundaries.

The selected local project becomes the harness's native workspace. Existing built-in tools retain their names, approval flow, and event shapes.

Because some `WorkspacePort` methods are synchronous:

- Fetch a metadata snapshot during workspace attachment and refresh.
- Resolve synchronous path/existence/directory queries against that snapshot.
- Perform content reads and mutations remotely.
- Revalidate paths and filesystem state on the bridge before every operation.
- Invalidate cached metadata after mutations or connection loss.

Support project instructions through the bridge. Continue loading application-owned agent/skill/prompt catalogs through the existing browser catalog, with project instructions read from the selected local workspace.

Add an injectable browser-runtime factory so workspace capabilities can be selected without placing runtime decisions in UI components.

Runtime changes require an idle backend. A disconnected bridge remains explicitly unavailable until reconnected; do not silently redirect local operations into a browser copy.

### Bridge process and pairing

Provide an independent Node CLI:

```bash
npm run bridge:ts -- \
  --workspace /path/to/project \
  --origin https://harness.example \
  --port 5001
```

Defaults and restrictions:

- Bind to IPv4 loopback only.
- Permit exactly configured website origins.
- Permit one selected workspace per process.
- Support Linux, macOS, and Windows through WSL.
- Do not advertise native Windows command execution.
- Do not run an agent loop or accept model turns.
- Do not load credentials or settings from the owner's running harness service.

Generate a single-use pairing code at startup, valid for five minutes. Successful pairing creates a random, in-memory connection token bound to the website origin and bridge process.

Require authenticated requests, validate `Host` and `Origin`, reject arbitrary filesystem roots, and provide no general HTTP proxy or arbitrary server-side URL-fetch endpoint.

Use explicit local startup flags to grant file writes, command execution, and Git mutations. The guide reports missing grants; the browser cannot increase them.

### Minimum protocol

Expose a versioned HTTP protocol for:

- Pairing and capability inspection.
- Workspace metadata refresh and current file content.
- Existing workspace operations.
- Existing Git operations.
- Command execution.
- Existing web search.
- Operation cancellation.
- Heartbeat and connection release.

Carry request IDs, structured sanitized errors, and cancellation through the protocol. Stream command settlement over NDJSON; preserve the existing final `{ output, status }` command contract.

Use a 15-second connection lease with heartbeats every five seconds. Explicit cancellation acts immediately; lease expiry cancels any remaining operations.

### Effects and approval

Approval remains enforced by the shared browser backend:

- The runtime adapter sends mutations only after the current approval gate permits execution.
- Missing, rejected, cancelled, and unavailable approvals execute nothing.
- The bridge additionally enforces its locally granted capability ceiling.
- Reads follow the existing non-effectful read policy.
- File writes, deletes, and moves include the approved expected-content state; reject stale proposals after external changes.

Reuse Node filesystem and Git adapters. Preserve their path confinement, Git safety settings, and explicit unsupported capabilities.

Reuse the existing command executor's default 60-second timeout, last-10,000-character output retention, and process-group cancellation. Commands run with local account permissions; the workspace working directory is not an OS sandbox.

Stop, lock, End session, connection release, and lease expiry must stop active command process groups. Never replay a command automatically after reconnection or a transport failure.

### Browser networking

Serve the hosted page over HTTPS. Pairing diagnostics must distinguish origin configuration, local-network permission, unreachable bridge, and authentication failures where the browser exposes enough information.

Modern Chrome gates relevant local-network requests behind permission checks; verify the actual hosted-to-loopback flow rather than treating CORS configuration as sufficient. [Chrome local-network documentation](https://developer.chrome.com/blog/local-network-access).

If browser policy blocks the connection, report it explicitly. Do not recommend disabling browser security or claim universal browser support.

## 5. Public interfaces, verification, and delivery

### Interface additions

Preserve the current contracts and add:

| Interface | Required addition |
|---|---|
| Browser storage | Injectable persistent or in-memory implementation |
| Browser runtime | Browser workspace or native bridge capability selection |
| Credential service | Create/open vault, save selected secret, unlock, lock, forget, sanitized status |
| Backend lifecycle | Cancel and clear all authenticated connections safely |
| Managed page transport | Private MessageChannel adapter compatible with `WorkerClient` |
| Bridge client/server | Versioned capability operations, pairing, cancellation, and lease |
| Guide backend actions | Connection checks, privacy mode, bridge attachment, and End session |

Do not expose vault or bridge administrative actions as model tools. Keep credentials separate from session serialization.

Existing databases and exports remain compatible. Store vault data separately; never migrate old data into shared-computer mode or automatically reinterpret plaintext configuration as saved credentials.

Direct headless callers must be able to exercise the new backend operations without either page.

### Copilot research milestone

Use OpenCode's implementation as the concrete reference for Copilot authentication and model discovery. Research supported access, subscription requirements, and browser/headless suitability against GitHub documentation as well.

#### Verified OpenCode reference

Inspected on 2026-10-07 at commit `a697115b203395c54a7496dc3d1863fe7b319c0c`. Pin the research to these source links because authentication and endpoint behavior have changed between versions.

**Authentication:** OpenCode starts GitHub OAuth device authorization, displays the verification URL/code, and polls for an access token. The current plugin stores that GitHub access token in its `refresh` and `access` fields and uses it directly as the Copilot bearer credential. The `refresh` field name does not establish that it is an OAuth refresh token. This inspected path does not exchange it for a separate short-lived Copilot token. It targets `https://api.githubcopilot.com`, with a separate enterprise-domain path, and supplies Copilot-specific request headers including initiator attribution. [Pinned authentication plugin](https://github.com/anomalyco/opencode/blob/a697115b203395c54a7496dc3d1863fe7b319c0c/packages/opencode/src/plugin/github-copilot/copilot.ts).

**Model access:** OpenCode requests authenticated `GET /models`, derives model limits and capabilities from the response, excludes unusable or policy-disabled entries, and separately tracks picker eligibility. It selects Anthropic Messages, OpenAI Responses, or Chat Completions from `supported_endpoints` metadata. Its provider fallback also contains model-specific routing rules; one universal OpenAI endpoint is insufficient. [Pinned model discovery](https://github.com/anomalyco/opencode/blob/a697115b203395c54a7496dc3d1863fe7b319c0c/packages/opencode/src/plugin/github-copilot/models.ts), [provider routing](https://github.com/anomalyco/opencode/blob/a697115b203395c54a7496dc3d1863fe7b319c0c/packages/core/src/plugin/provider/github-copilot.ts).

OpenCode's documented user flow is connect, authorize the device, then select a model; subscription level can affect availability. [OpenCode provider documentation](https://opencode.ai/docs/providers/#github-copilot).

#### Implications for this harness

- Design Copilot as a separate provider with **Sign in with GitHub**, rather than presenting a generic API-key input as its primary authentication path.
- Keep Copilot model authentication distinct from GitHub MCP/repository authentication; a repository token must not automatically become an inference credential.
- Represent OAuth credentials explicitly instead of forcing them into the existing API-key-only configuration. Preserve existing provider configuration compatibility.
- If enabled after feasibility verification, persist OAuth credentials only through the opt-in encrypted vault; apply the same lock, cancellation, and shared-computer rules.
- Use live model discovery and preserve endpoint/capability metadata. Distinguish unavailable models, policy restrictions, picker eligibility, and failed discovery; never present a fallback catalog as confirmed account access.
- Implement cancellable, bounded device authorization with expiry, denial, and polling backoff. GitHub requires device flow to be enabled for the application and defines the polling/error behavior. [GitHub device-flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
- Verify our OAuth client registration and Copilot entitlement separately. Do not assume a token issued to our application has the same access as OpenCode's, or silently reuse OpenCode's embedded client identity.
- Test device authorization, model discovery, required headers, and inference from the actual hosted browser origin. Node fetch success does not establish browser CORS compatibility.
- If browser-only access is blocked, document that limitation. Any proposed local authentication/inference relay must be an explicit follow-up design; the first bridge deliberately excludes a general HTTP proxy.
- Treat OpenCode's implementation as compatibility evidence, not proof that GitHub offers a stable public contract for each Copilot endpoint. Verify current supported usage before advertising access.

Produce a feasibility note containing:

- Which supported API, if any, meets the requirement.
- The pinned OpenCode behavior and any differences from the version being implemented.
- Authentication lifecycle and browser compatibility.
- Whether requests use Copilot inference or invoke a separate coding agent.
- Credential persistence constraints.
- A recommended follow-up scope.

Use fixtures to cover pending authorization, slow-down, denial, expiry, cancellation, malformed discovery, zero eligible models, policy-disabled models, endpoint selection, and credential clearing. Live authenticated checks require user-supplied access; none were performed during this research.

Do not implement undocumented token extraction or advertise Copilot support before this milestone establishes a supported path. This research update does not authorize implementing the Copilot adapter.

### Tests and acceptance criteria

Require 100% coverage for all new code under the project rules, including backend line/branch/function/statement gates. Add browser coverage for new page controllers and transport behavior.

Use deterministic models, local fixtures, scratch workspaces/settings, and port 5001 or ephemeral ports.

**Credential tests**

- Encryption round trips, wrong passphrase, tampered ciphertext, unsupported record version.
- Fresh encryption nonces and connection-binding validation.
- Provider/MCP credential separation and endpoint changes.
- All lock triggers during idle, inference, tools, approvals, and child execution.
- No secrets in IndexedDB plaintext, cookies, URLs, logs, events, or exports.
- Two experiments/users cannot obtain each other's unlocked credentials.
- Forgetting removes selected encrypted records without removing unrelated sessions.

**Storage and lifecycle tests**

- Shared mode never opens persistent project/session storage.
- Personal persistence survives reload while credentials reopen locked.
- End session clears temporary state and stops pending effects.
- Page closure/crash is handled through heartbeat expiry.
- Reload never resumes authenticated work automatically.
- Exported and already-applied external effects remain intact.

**Bridge tests**

- Pairing expiry, code reuse, wrong origin, invalid host, token rejection, and capability ceilings.
- Workspace confinement, escaping/dangling symlinks, external-change conflicts.
- Native reads, approved writes, Git tools, commands, and web search without UI.
- Every approval outcome, timeout, cancellation, lost transport, and lease expiry.
- Process-group cleanup and bounded output.
- Bridge disconnect never silently switches workspace.
- Hosted HTTPS-to-loopback connection using real browser networking.
- No requests to or interference with the owner's port-5000 service.

**Guide and compatibility tests**

- Responsive layout, keyboard access, labeled inputs, and clear status messages.
- Lessons work manually and describe unsupported execution honestly.
- Open harness attaches to the correct backend without leaking secrets.
- Existing harness displays remain unchanged.
- Existing Node, Worker, browser SDK, session import/export, MCP, and headless tests pass.
- Static packaging contains all required guide assets and uses relative URLs.

### Delivery order

1. Establish storage/runtime injection and managed-session lifecycle.
2. Implement the encrypted credential vault and cancellation-safe locking.
3. Implement the native bridge and verify it headlessly.
4. Add the private page transport and integrate the separate guide.
5. Complete browser, coverage, packaging, and compatibility checks.
6. Finish the Copilot feasibility note and document any follow-up.
7. Update README, architecture status, testing instructions, and handover notes.

Do not commit, deploy, restart the owner's service, or overwrite existing preview/planning files without a separate request.

### Completion definition

A learner can open the statically hosted guide, select temporary or personal use, connect a supported model, open the unchanged harness, and follow the initial lessons.

They can optionally attach a paired local project and use existing built-in tools against it. Locking or ending the session stops authenticated work, and a later visitor cannot unlock saved credentials without the passphrase.

The same capabilities are verified through callable backend interfaces without the UI.

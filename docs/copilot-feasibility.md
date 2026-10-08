# Copilot feasibility — 2026-10-08

**Decision:** do not advertise a Copilot provider yet. OpenCode demonstrates a
working integration pattern, but we have not established that our own registered
client can use the same inference endpoints from a static hosted browser.
No live authenticated checks have been performed.

## OpenCode reference

The plan pins OpenCode to commit
`a697115b203395c54a7496dc3d1863fe7b319c0c`. Its
[authentication plugin](https://github.com/anomalyco/opencode/blob/a697115b203395c54a7496dc3d1863fe7b319c0c/packages/opencode/src/plugin/github-copilot/copilot.ts)
uses GitHub OAuth device authorization and uses the resulting GitHub access token
directly as the Copilot bearer credential. Its `refresh` field name does not prove
that the value is an OAuth refresh token. This path does not exchange it for a
separate short-lived Copilot token.

Its [model discovery](https://github.com/anomalyco/opencode/blob/a697115b203395c54a7496dc3d1863fe7b319c0c/packages/opencode/src/plugin/github-copilot/models.ts)
requests authenticated `/models` metadata and filters models by usable capabilities
and policy. Its [provider routing](https://github.com/anomalyco/opencode/blob/a697115b203395c54a7496dc3d1863fe7b319c0c/packages/core/src/plugin/provider/github-copilot.ts)
selects Messages, Responses or Chat Completions according to supported endpoints,
with additional fallback rules. Generic OpenAI-compatible API-key configuration
would miss authentication and routing requirements.

OpenCode documents signing in through device authorization and notes that available
models can depend on the subscription. This is compatibility evidence for OpenCode,
not confirmation that a different OAuth application inherits its entitlement.
[OpenCode provider documentation](https://opencode.ai/docs/providers/#github-copilot).

## Supported access and browser suitability

GitHub documents device flow for headless applications, requires enabling it for
the registered application, and specifies polling and error responses. Registration
and credential lifetimes must follow GitHub's current OAuth settings rather than
assuming all tokens have identical behavior. The documentation does not establish
browser CORS access to Copilot inference or our application's Copilot entitlement.
[GitHub OAuth documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

Consequently, no supported API has yet been verified to meet this delivery's exact
requirement: arbitrary learners using their Copilot subscription directly from the
static browser harness. GitHub Models is a separate product and should not be
presented as equivalent Copilot subscription access.
[GitHub Models documentation](https://docs.github.com/en/github-models).

OpenCode's referenced path invokes model inference. It does not delegate the task
to a separate repository coding agent; our own harness would still own tools,
approvals, memory and the loop.

## Follow-up scope

1. Register our own permitted OAuth application; establish account entitlement and
   supported API usage. Do not reuse OpenCode's embedded application identity.
2. Verify authorization, authenticated model discovery, required headers and actual
   inference from the hosted browser origin. Node fetch alone is insufficient.
3. If supported, implement a distinct provider with GitHub sign-in, cancellable,
   bounded polling and endpoint-aware model metadata. Keep GitHub MCP credentials
   separate. Persist OAuth material only through explicit encrypted-vault saving;
   clear it under the same shared-device and locking rules.
4. Test pending authorization, slow-down, denial, expiry, cancellation, malformed
   discovery, zero eligible models, policy exclusions, endpoint selection and key
   clearing before enabling the provider. Those tests belong with the future adapter;
   this delivery contains no simulated Copilot access or unimplemented sign-in UI.
5. If CORS or entitlement blocks browser-only access, record that result and design
   an explicit inference/authentication relay separately. The current workspace
   bridge intentionally has no general HTTP proxy.

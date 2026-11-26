# Project instructions

## Purpose

This project teaches what an LLM harness is and what it brings: memory, tools,
instructions, skills, approvals, and context management. It is not primarily
about learning to program a harness. Make these behaviors visible and explain them.

## Required architecture

The UI and harness backend must be clearly separate. The full backend must be
usable and runnable without the UI, regardless of language or execution runtime.

- The backend owns the agent loop, conversation state, prompt construction,
  tools, approval enforcement, and context management.
- The UI sends actions and renders backend state/events. It must not implement
  harness decisions or be required to advance the agent loop.
- Keep the core independent of UI components, the DOM, Flask routes, and Worker
  APIs. Put transport and runtime integration in adapters.
- Expose a callable interface and structured events for messages, progress,
  approvals, cancellation, memory reset, compaction, and state inspection.
- Supply model and workspace/tool capabilities through adapters. Browser-only
  capabilities must not be mandatory dependencies of the core.
- Headless execution must preserve approval policy. Missing approval responses
  must never silently authorize actions. Report unsupported capabilities explicitly.
- Verify backend behavior without the UI, including tool execution, approval
  responses, and cancellation. UI smoke tests alone are insufficient.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the contract and current status. The
TypeScript backend implements this contract. Preserve the dependency direction:
clients use `NodeHarness`, `BrowserHarness` or the public `WorkerClient`, and runtime
adapters supply the shared `Harness` and `HarnessCore` with their capabilities.
Browser and Node runtimes must reuse this core rather than put harness logic in UI components.

## Current project rules

- Read [HANDOVER.md](HANDOVER.md) for implementation details and operational rules.
- All new code must have 100% test coverage.
- Keep `harness.py` as the minimal reference unless explicitly asked to change it.
- Do not interfere with the owner's running service on port 5000. Use port 5001
  and scratch workspaces/settings for integration checks.
- Do not commit unless asked.

## The Request tab shows what is really sent

The Request tab teaches by showing the real request, so two rules are binding and have regression tests
(`typescript/tests/request-view.test.ts`):

- **"As sent" is identical to what is posted to the model**, for Ollama and for each cloud provider: the same
  fields, values and order (only the display formatting differs). The harness's internal routing label
  (`provider`) is not part of any posted body and is not shown. A recorded request event is a snapshot and never
  changes afterwards.
- **"By section" shows the same content as "As sent"**: the system message, tool schemas, memory messages and this
  turn's messages are exactly the ones in the sent body, differing only in form. Every text a section shows
  must be present in the posted body.

Change request building, an adapter body, or `web/static/request-view.js` only together with those tests.

## Interface languages

The interface is translated into the 11 languages of harnessarium.com: `zh` (Simplified Chinese), `es`, `pt`
(Brazilian Portuguese), `ja`, `ru`, `de`, `fr`, `ko`, `tr`, `hi`, `it`. English is the source.

- **Only the interface is translated.** What the harness sends to a model (prompts, agents, skills, tool
  descriptions, tool results), what it stores in sessions, the backend's raw diagnostics and the model's answers
  stay as they are. The Request tab must keep showing the real request.
- `web/static/i18n.js` chooses the language (`?lang=` link, then the saved choice `lang` shared with
  harnessarium.com, then the browser languages) and loads `web/static/i18n-<lang>.js`. Each catalog maps an English
  text to its translation; a missing entry falls back to English.
- Markup is translated by `MyHarnessI18n.apply()`: text, `title`, `placeholder` and `aria-label`. Mark brand
  names and raw output `translate="no"`. Text with inline elements needs `data-i18n-html` on its parent; its key
  writes each child as `<tag>…</tag>`, and translations keep the same tags.
- Scripts call `t("English text {name}", { name })` and `tn(one, other, count)` with **literal** English texts, so
  `scripts/i18n-keys.mjs` can list every key. Numbers in placeholders are formatted for the language.
- Any change to an English interface text changes its key: update all 11 catalogs in the same change, translated by
  the `translator` agent (one per language, defined in `.agents/translator.md`) and revised by a second, native
  reviewer. `typescript/tests/i18n.test.ts` fails while a catalog is missing a key, has an unknown key, or loses a
  placeholder or tag (`node scripts/i18n-keys.mjs --check [lang]` after `npm run build:ts` shows the same list).

### Terms

Each language has chosen once how to write its key terms. The choice is binding in the interface and on
harnessarium.com: the "harness" and "agent" rows are the website's (see its `AGENTS.md`). No gloss in the
interface: the explanation in parentheses belongs only to the website's home page.

| Language | harness | agent |
|---|---|---|
| French (`fr`) | harness (le harness, plural les harness) | agent (un agent) |
| Spanish (`es`) | harness (el harness, plural los harness) | agente (un agente) |
| Portuguese (`pt`) | harness (o harness, plural harnesses) | agente (um agente) |
| German (`de`) | Harness (der Harness, plural Harnesses) | Agent (der Agent, zum Agenten) |
| Italian (`it`) | harness (l’harness, un harness, plural gli harness) | agente (un agente) |
| Turkish (`tr`) | harness (harness’i, harness’in, plural harness’ler) | agent (agent’a, agent’ı, plural agent’lar); not "ajan" |
| Chinese (`zh`) | harness | Agent; not 智能体 |
| Japanese (`ja`) | ハーネス | エージェント |
| Korean (`ko`) | 하네스 | 에이전트 |
| Hindi (`hi`) | हार्नेस (masculine) | एजेंट |
| Russian (`ru`) | обвязка (feminine, declined) | агент (animate: превращает в агента) |

Other recurring terms (memory, tool, token, prompt, context, session, approval, skill, subagent, compaction…) are
listed per language in [docs/interface-terms.md](docs/interface-terms.md). A translator who needs a new one adds it
there for their language.

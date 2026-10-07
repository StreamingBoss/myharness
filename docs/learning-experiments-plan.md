# Plan: learn harness behavior through checked coding exercises

Proposed additions to MyHarness, informed by the Decoding AI course. This is a
plan, not an implemented feature or a claim of measured improvement.

Use small coding tasks to show what tools, agents, skills, memory, and subagents
bring to a model. The learner asks for a concrete change, watches the harness
investigate and act, and checks the actual program independently. The learning
objective remains understanding the harness, rather than learning to build one.

## 1. What to borrow from the course

| Course idea | Proposed addition | Priority |
| --- | --- | --- |
| Tasks with a repository and an independent verifier | Small seeded projects, public requirements, trusted outcome tests | First |
| Benchmarks and behavioral regressions | Repeat a task under controlled configurations; separate correctness from method | First |
| Runnable demonstration skills | An inspectable workflow for making and verifying a small code change | First |
| Failure analysis | Find the first mistaken assumption in a failed attempt, then change one thing | First |
| Sandboxed tools | An optional execution adapter for isolated exercise commands and grading | First for automated execution |
| Scoped subagents | A comparison of one investigator with two independent code investigators | Next |
| Memory and compaction | Coding continuations that test whether constraints survive | Next |
| LSP diagnostics and experimental replay | Later exercises comparing feedback and decisions under the same conditions | Later |

Relevant course explanations:
[evaluations](https://www.decodingai.com/p/evaluate-ai-agents-benchmarks-regression-tests),
[failure analysis and replay](https://www.decodingai.com/p/transform-agent-traces-into-regression-cases),
[context engineering](https://www.decodingai.com/p/context-engineering-for-coding-agents), and
[sandboxing](https://www.decodingai.com/p/run-coding-agents-safely).

Adopt these principles before integrating external evaluation platforms. Start
with one repository and a checker that can distinguish a working change from a
convincing description of one.

## 2. First exercise: add JSON output to a small log analyzer

### The project and task

Prepare a dependency-free Python project called LogLens. It reads a local log
file and prints counts of INFO, WARN, and ERROR events. Keep the initial project
small enough that a learner can understand it in a few minutes:

| File | Purpose |
| --- | --- |
| `README.md` | Current behavior, input format, and documented commands |
| `src/loglens/cli.py` | Command-line arguments and text output |
| `src/loglens/parser.py` | Parse the documented log records |
| `src/loglens/summary.py` | Count events by level |
| `tests/` | Existing public tests for the working behavior |
| `examples/` | Sample inputs, including an empty log |

Ask the assistant:

> Add a --json option to LogLens. It must print one JSON object with events,
> errors, and by_level counts. Preserve the existing default text output and
> input-handling behavior. Add tests and document the new command in README.md.
> Use the existing project conventions, run the relevant checks when possible,
> and explain what you verified.

Publish the complete contract: `events` counts parsed events, `errors` counts
ERROR events, and `by_level` always includes INFO, WARN, and ERROR with integer
counts, including zero. JSON mode emits exactly one object on stdout, without
extra commentary. Existing behavior for malformed input, missing files, stderr,
exit codes, and help remains as documented in the seed project. Include a concrete
sample input/output pair in the task.

The task is small, but it crosses arguments, existing APIs, output formatting,
tests, and documentation. It can expose guessed function names, forgotten empty
input, changed default output, and tests that only cover the happy path. These
are ordinary coding mistakes, not deliberately obscure traps.

A short optional warm-up fixes an off-by-one bug in a standalone range function.
Use it to introduce read → edit → run → observe. Use the JSON feature exercise for
comparisons, since a one-line fix may be too easy to reveal a benefit from guidance.

### What the independent checker verifies

Submit an immutable snapshot of the actual workspace changes. Grade a fresh copy
of that snapshot, not the final chat message or an unexecuted proposed diff.

The trusted verifier keeps its tests outside the agent's workspace during the
attempt, then checks the submitted program against published requirements:

- Mixed-level input produces the correct JSON counts.
- Empty input produces zero counts with all required keys.
- Existing default output, input handling, help, and error behavior still work.
- README documents the new option and an executable example.
- Agent-added tests include mixed and empty input and pass on the submission.
- Original public tests and unrelated files are unchanged; allowed change paths
  are published before the task, including the location for new tests.

Check documentation structure and execute its example where practical. Do not
use a rigid exact sentence match as a proxy for accurate documentation. Trusted
behavior tests establish correctness; inspect the added tests separately, with
known buggy variants if needed, to see whether they would catch the advertised
failures. A test's name alone is not evidence of its coverage.

Validate the verifier itself: the reference solution passes, the unchanged seed
fails the feature checks while passing the old behavior checks, and representative
broken solutions fail the appropriate criteria. Distinguish an agent failure from
an execution environment or verifier failure.

## 3. Compare tools, agents, and skills fairly

### First show what tools add

| Condition | Available capabilities | Interpretation |
| --- | --- | --- |
| A | No workspace tools | The model can discuss a solution but cannot apply or verify it |
| B | File discovery, search, reads, edits, writes, and command execution | The model can inspect, change, and test the real project |

Keep the task prompt identical. A does not receive the repository contents pasted
into its prompt. Honest inability to inspect or modify the project is reported as
an incomplete task with a correctly identified limitation; guesses are recorded
separately. This is a capability demonstration, not a fair contest of two coding
strategies. Measure guidance only among conditions with the same capabilities.

### Then compare guidance with identical tools

| Condition | Agent instructions | Skill |
| --- | --- | --- |
| B | No additional persona | None |
| C | A proposed careful-coder persona | None |
| D | No additional persona | A proposed make-small-code-change skill |

Compare B with C to assess the persona and B with D to assess the skill. Include
`use_skill` in all three configurations; only D offers this exercise skill. Record
whether the skill actually loads. Test a manual slash invocation separately if
automatic discovery fails. A combined persona-plus-skill comparison comes later.

The persona teaches general habits: inspect before assuming, respect existing
interfaces, make a focused change, and verify before claiming completion. Its tool
allowlist must match B's. The existing coder agent is a useful starting point, but
its delegation guidance and extra permissions must not introduce another variable.

The skill teaches a reusable workflow: read project instructions, locate the entry
point and tests, reproduce existing behavior, implement the change, add boundary
checks, run relevant tests, and review the diff. It includes no solution, fixture
answers, additional product requirements, or mandated sequence of exact tool calls.

### Experimental controls

Start every attempt in a fresh session and a clean copy of the same seed commit.
Hold the model, provider, supported generation parameters, base instructions,
context budget, request ceiling, and approval policy constant. Record the exact
instructions, schemas, loaded skill text, exercise version, and source snapshot.

For a pilot, try five attempts per condition, rotating condition order. Validate
promising findings on additional task variants with matching seeds within each
comparison. One paired attempt is a demonstration; five attempts are exploratory,
not statistical proof. Keep failed attempts visible and do not select only wins.

Record outcome checks, unsupported claims, model requests, tool errors, repeated
calls, elapsed time, reported input/output tokens, and changed-file scope. Separate
completion, quality of evidence, and effort. If every configuration succeeds, report
that; guidance may improve efficiency, add overhead, or make no observable difference.

Keep approval decisions explicit and comparable. For automated pilots, any permission
preset is chosen by the operator and recorded; the runner never infers approval from
silence. Interrupted or denied attempts remain visible instead of being discarded.

## 4. Explain how wise tool use helps us master the job

The central coding loop is:

**Locate → read → make a focused change → run a check → interpret the result →
repair if needed → inspect the final diff.**

| Decision | Why it helps | Evidence the learner sees |
| --- | --- | --- |
| Search for argument parsing and current output | Find the actual implementation | Matched paths and lines |
| Read the caller, function, and relevant tests | Understand the existing contract | Real signatures, return values, expectations |
| Edit a small region | Reduce accidental changes | Proposed diff and approval |
| Run a focused check | Get fast feedback on the feature | Command, exit status, stdout/stderr |
| Run regression checks | Catch collateral damage | Old behavior still passes |
| Inspect git diff | Confirm what really changed | Final files and patch |
| Adapt after failure or denial | Avoid an unproductive loop | The result and subsequent changed approach |

More tools and fewer calls are not automatically better. Reading a caller can
prevent a wrong edit. A passing focused test does not establish that regressions
are absent. A shell is flexible, while specialized file tools provide clearer
operations and proposals. Teach the purpose of each choice rather than scoring
an exact call sequence.

After an attempt, ask the learner which observation supports the completion claim,
where the first mistake happened, and what one change they would try next. Keep
attempts with trusted-checker feedback separate from blind comparisons: feedback
changes the evidence available to the model.

## 5. Token-saving exercise: find and repair one bug in a larger repository

Expand LogLens into a modest project with multiple commands, documentation, example
logs, and unrelated modules. Seed a reproducible bug in a relevant module. Publish
its expected behavior and a reproduction command; do not disclose the faulty line.

Compare two explicit investigation strategies with the same tools and task:
reading broadly to build context, and using `find_files`/`search` followed by useful
line ranges and a focused reproduction. These are disclosed strategy comparisons,
not a deliberately foolish unguided baseline. Both must pass the same trusted bug
and regression checks.

Explain that retained context is usually sent again on subsequent calls. An irrelevant
file or a long test log can therefore cost input tokens repeatedly. Show the actual
outputs entering subsequent requests, not just a context meter.

| Technique | Possible saving | Required tradeoff check |
| --- | --- | --- |
| Locate symbols and read useful ranges | Less unrelated source in context | Include callers and constraints needed for a correct repair |
| Run focused tests first | Shorter feedback during iteration | Still run the final regression checks |
| Limit output at the source | Smaller logs | Retain failures and exit status; do not hide evidence with truncation |
| Offer relevant tools only | Smaller repeated schemas | Preserve needed capabilities |
| Load a skill when needed | Avoid unused workflow bodies | Count the skill's own input overhead |
| Avoid repeated failed calls | Fewer requests and duplicate output | Confirm the revised approach solves the problem |
| Compact before a long continuation | Smaller later inputs | Include summary-generation cost and check retained constraints |

Compare total reported input and output tokens across the whole attempt, including
retries, summaries, and any child calls. Show correctness beside usage. If usage is
unavailable, report it as unavailable; bytes/characters can describe payload size
but do not establish token savings. Label estimates. Keep latency and monetary cost
separate, and only calculate cost from a known provider price.

A later compaction exercise continues a coding task with a previously stated
constraint, such as preserving the public API. Check the resulting API behavior
independently. Compaction is not a guaranteed saving for a short continuation.

## 6. Subagent exercise: investigate two independent bugs

Prepare a larger LogLens variant with two reproducible issues in separate modules:
for example, timezone normalization in filtering and empty-group handling in a
summary command. Specify both contracts and provide independent reproduction cases.
The parent must deliver one integrated patch that fixes both and preserves the
working commands.

Compare one investigator with a parent delegating one investigation to each of two
read-only children. Give each child the issue, module scope, reproduction evidence,
report contract, and limits. Request a concise report containing relevant locations,
root cause, suggested change, boundary cases, and uncertainties. The parent reviews
those reports, makes the edits, runs checks, and owns the final integration.

Read-only children need no new effect grants. They can inspect code; they cannot
claim to have run commands if no command capability is granted. If command execution
or independent child edits become a later exercise, require explicit host grants and
use isolated workspaces for concurrent edits. Do not have children race on shared files.

A subagent is a separate working conversation for a bounded task. Its detailed
investigation can remain outside the parent's context, while a report returns the
useful findings. In MyHarness this is conversation and permission isolation, not
an operating-system sandbox. A second model-generated opinion is not an independent
correctness check; trusted tests still decide whether the patch works.

| Question | Evidence to inspect |
| --- | --- |
| Why delegate? | Two independently investigable issues with a clear integration point |
| What does a child know? | Actual child request, task, instructions, and grants |
| What reaches the parent? | Reports and explicitly forwarded context |
| Did delegation help? | Correctness, wall-clock time, parent context size, total family usage |
| What did it cost? | Repeated setup, duplicate reads, synthesis, retries |
| What if one child fails? | Partial findings, timeout, and the parent's handling of incomplete work |

Hold the total family request budget constant and count each request once. Do not
claim token savings just because the parent's context is smaller. Include the tiny
warm-up bug as a counterexample: delegation may be unnecessary overhead there.

Add a timeout variant. The parent must distinguish a partial investigation from a
completed fix; restarts are explicit and counted. Host settings enable subagents
for this comparison. The exercise never silently expands child authority.

## 7. Follow-up exercises

| Exercise | Harness behavior | Independent check |
| --- | --- | --- |
| Deny a proposed source edit | Approvals and adaptation | File unchanged; denial returned; no silent retry |
| Preserve an API preference across turns | Conversation memory | Constraint present in the request and honored by the patch |
| Start a new task with AGENTS.md | Persistent project instructions | Exact injected rule and observable coding behavior |
| Continue after compaction | Context management | Required constraint and correct patch survive |
| Get diagnostics after an edit | Optional LSP feedback | Faster error discovery without replacing tests |
| Review a previous failure | Experimental replay, later | Fresh model decisions under an explicit recorded-tool policy |

Extend the English, French, and Markdown guides with these experiments, plus goals,
subagents, deadlines, and shared budgets. Keep simulation, recorded demonstration,
and live model execution visibly distinct.

## 8. Runtime and execution requirements

Start the runnable coding exercises in the Node edition. The existing browser
edition can read and edit source, but cannot run Python or Bash. Do not present a
browser patch as behaviorally verified without a working execution adapter.

An optional isolated command adapter should run both agent checks and trusted
verification in disposable environments. Keep its files consistent with the
workspace the file tools expose. Use a fresh copy for grading, bounded execution,
and explicit cancellation. The reference oracle and grading results stay under
checker control, outside the agent's tools. Sandboxing does not replace approvals.

A first manual pilot can use the documented Node command tool in a scratch project
with user-approved commands; label it as host execution. Automated grading of
submitted executable code needs the isolated executor before becoming a normal
exercise feature. Move this requirement earlier than in the report-based plan.

The browser can initially offer inspect/edit-only participation and export the patch
for Node verification. A connected or browser-compatible execution adapter is a later
option. Report unsupported checking explicitly; downloading a patch is not a passed
exercise. Runtime capabilities come through adapters, never UI decisions.

## 9. Implementation phases and acceptance criteria

### Phase 1: validate the task and checker

Prepare LogLens, the public task contract, a reference solution, trusted tests,
the persona, and the skill. Validate baseline/reference/broken solutions. Run a
manual headless pilot in scratch workspaces and review its actual traces. Prototype
the isolated execution adapter for automated checks.

Completion: the grader distinguishes a working implementation, feature omission,
regression, missing submission, cancellation, and infrastructure failure. Agent
claims cannot substitute for workspace changes or test outcomes.

### Phase 2: add reproducible attempts and the learner interface

Add exercise selection, fresh workspace preparation, configuration snapshots,
explicit submission, independent checking, and comparison results. Support direct
headless operation as well as UI actions. Surface command and edit approvals.

Completion: Node attempts preserve seed version, submitted changes, effective
settings, events, test results, and verdicts. Cancellation stops execution;
restoration never automatically reruns work. Browser limitations are explicit.

### Phase 3: add token and subagent comparisons

Add the larger-repository bug and two-issue investigation fixtures. Run repeated
real-model comparisons and update the guides from observed results. Record whole
family usage and do not promise that a preset always wins.

Completion: a learner can reproduce a comparison from its export and explain the
relationship between tool choices, correctness, context, and delegation costs.
Keep real-model evaluations separate from deterministic CI checks.

### Phase 4: extend only when a lesson needs it

Consider diagnostics, reviewed cross-session memory, more task variants, and
experimental replay. Each addition needs a concrete coding task and an observable
benefit or tradeoff. External tracing/evaluation services remain optional.

## 10. Preserve the project architecture

Introduce a runtime-independent exercise service beside the shared harness. It
owns definitions, attempt lifecycle, immutable submissions, configuration snapshots,
verification orchestration, and comparison records. It calls public backend APIs.
The UI sends actions and renders state/events.

Supply workspace preparation, persistence, and isolated execution through adapters.
Expose callable prepare/start/submit/check/cancel/inspect operations and structured
attempt events. Keep verifier state and authority separate from model tools.
Missing approval responses deny actions, including during headless pilots.

All new implementation code must meet project coverage requirements. Verify backend
behavior headlessly, including approvals, tool effects, cancellation, restoration,
and unavailable runtime capabilities. Add UI checks for the learner workflow. Use
scratch settings/workspaces and port 5001 or an ephemeral port. Preserve harness.py
and the owner's port-5000 service. Do not commit unless asked.

The first deliverable is **one runnable coding task, an independent verifier, and
controlled tool/agent/skill comparisons**. Then add the token-saving repair and
subagent investigation. The learner should finish able to explain how the harness
helped produce a working patch and when additional machinery was unnecessary.

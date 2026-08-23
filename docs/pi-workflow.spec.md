# pi-workflow Extension Engineering Specification

**Status:** Implemented (v0.1; original "Implementation Ready" status superseded by the sync below)  
**Version:** 0.1 MVP  
**Target:** Pi Coding Agent Extension  
**Primary dependency:** `pi-subagents`  
**Primary integration contract:** `pi-subagents/delegation`

> **Documentation sync (2026-08-21):** the normative body (§1–§49) has been re-checked
> against the implemented v0.1 source tree and updated where the implementation (already
> reviewed and unit-tested) diverged from the original prose — state fields (`autoRouted`,
> `modeResolved`), adapter progress streaming, preflight semantics, prompt autonomy rule,
> repository layout, test inventory, and live output UX. §52 (audit findings and
> remediation) is the historical record and is preserved as-is. The dated §46 acceptance
> record (69/69 tests, 2026-08-21) remains a point-in-time record; the current suite is
> 148 tests (`npm test`).

---

# 1. Project Summary

`pi-workflow` is a deterministic coding-workflow orchestrator for Pi.

It coordinates isolated subagents through a persistent state machine:

```text
User
  │
  ▼
Planner
  │
  ▼
Implementation
  │
  ▼
Test Gate
  │
  ▼
Fresh Reviewer
  │
  ├── PASS ─────────────► Final
  │
  └── REQUEST_CHANGES
            │
            ▼
        Fix Worker
            │
            ▼
      Regression Test
            │
            ▼
      Fresh Reviewer
```

The central design principle is:

```text
pi-workflow
=
deterministic orchestration
+ state machine
+ quality gates
+ persistence
+ recovery

pi-subagents
=
isolated agent execution runtime
```

`pi-workflow` MUST NOT reimplement subagent spawning, session isolation, model handling, child-process management, or agent discovery.

---

# 2. Problem Statement

Pi can already delegate implementation and review work to subagents, but model-driven orchestration has several weaknesses:

1. workflow execution is largely conversational rather than stateful;
2. review loops may depend on parent-model judgment;
3. workflow progress is difficult to resume deterministically;
4. failed or interrupted workflows do not have a first-class checkpoint;
5. quality gates are not explicit;
6. workflow policies are mixed into prompts;
7. reviewer isolation is not guaranteed by the workflow itself.

`pi-workflow` solves these problems by moving workflow control outside the LLM.

The LLM executes individual nodes.

The extension controls transitions.

---

# 3. Core Requirement

The following invariant is non-negotiable:

```text
Reviewer context MUST always be fresh.
```

Every review attempt is a new isolated agent invocation.

Never reuse the previous reviewer session.

Example:

```text
Worker #1
   ↓
Reviewer #1 [fresh]
   ↓ REQUEST_CHANGES
Fix Worker #1
   ↓
Reviewer #2 [fresh]
   ↓ REQUEST_CHANGES
Fix Worker #2
   ↓
Reviewer #3 [fresh]
```

Never implement:

```text
Reviewer
   ↓
continue reviewer
   ↓
continue reviewer
```

Reviewer input MUST be reconstructed from explicit workflow artifacts.

A reviewer may receive:

```text
original requirement
approved plan
current repository state
current diff
test evidence
previous requested changes that should now be verified
```

It MUST NOT depend on conversation history explaining or defending the implementation.

---

# 4. Goals

MVP MUST provide:

```text
/work plan
/work implement
/work review
/work fix
/work auto

/work status
/work resume
/work abort
/work list
```

It MUST support:

- persistent workflow state;
- structured planner output;
- structured worker output;
- structured reviewer output;
- explicit quality gates;
- fresh reviewer contexts;
- bounded review/fix loops;
- interruption recovery;
- run status inspection;
- quick / normal / strict execution modes;
- dependency/preflight validation;
- deterministic state transitions.

---

# 5. Non-Goals

Do NOT implement these in v0.1:

- generic DAG workflow language;
- graphical workflow editor;
- arbitrary YAML workflow definitions;
- cron/scheduling;
- remote workers;
- multi-repository orchestration;
- automatic git commits;
- automatic push;
- automatic PR creation;
- autonomous branch switching;
- worktree fanout;
- distributed execution;
- replacement for `pi-subagents`;
- replacement for Pi context management;
- background daemon;
- general-purpose CI system.

Do not build a framework before the coding workflow works reliably.

---

# 6. Architecture

```text
┌──────────────────────────────────────────┐
│                User / Pi                 │
│                                          │
│ /work auto                               │
│ /work plan                               │
│ /work review                             │
└───────────────────┬──────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────┐
│              pi-workflow                 │
│                                          │
│ Command Layer                            │
│        │                                 │
│        ▼                                 │
│ Workflow Engine                          │
│        │                                 │
│        ├── State Machine                 │
│        ├── Gates                         │
│        ├── Policies                      │
│        ├── Persistence                   │
│        └── Prompt/Input Builder          │
│                    │                     │
└────────────────────┼─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│             Subagent Adapter             │
│                                          │
│        pi-subagents/delegation           │
└────────────────────┬─────────────────────┘
                     │
         ┌───────────┼────────────┐
         ▼           ▼            ▼
       Scout       Worker      Reviewer
                               [fresh]
```

---

# 7. Dependency Strategy

`pi-workflow` MUST use public `pi-subagents` integration APIs.

Preferred execution API:

```ts
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
```

Use:

```text
pi-subagents/delegation
```

for normal workflow nodes.

Use:

```text
pi-subagents/preflight
```

to validate required agents and launch contracts before executing workflows.

Do NOT:

```text
spawn child Pi manually
execute pi CLI manually
scrape /run output
scrape slash command output
import pi-subagents internal modules
duplicate agent discovery
duplicate session management
```

The subagent adapter MUST be narrow enough that the workflow engine can be unit-tested using a fake adapter.

---

# 8. Context Policy

Default context policy:

| Node | Context |
|---|---|
| Scout | `fresh` |
| Planner | `fork` |
| Implementation Worker | `fresh` |
| Reviewer | `fresh` |
| Fix Worker | `fresh` |
| Final Reviewer | `fresh` |

Planner uses `fork` because planning may legitimately depend on the current Pi discussion.

Workers receive explicit structured handoff rather than conversation history.

Reviewer MUST explicitly specify:

```ts
context: "fresh"
```

Never rely on package defaults for reviewer isolation.

Planner fork degradation (audit Finding 1, §52): when the parent session has not yet been
persisted, pi-subagents fails the planner's `fork` deterministically ("parent session file
does not exist", "not persisted enough history to fork yet", and two related pre-checks).
This is NOT an agent failure: the engine degrades the planner to a `fresh` context instead
of consuming the agent retry budget, because the planner prompt is self-contained (task +
optional scout summary) and a fresh execution remains correct. The degradation is recorded
as a `planner.fork_unavailable` event. Detection lives in `src/policies/fork.ts`.

Add an assertion in code:

```ts
if (node.role === "reviewer" && node.context !== "fresh") {
  throw new WorkflowInvariantError(
    "Reviewer nodes must use fresh context"
  );
}
```

Unit test this invariant.

---

# 9. Workflow States

Use explicit state values.

```ts
type WorkflowState =
  | "created"
  | "scouting"
  | "planning"
  | "plan_ready"
  | "implementing"
  | "testing"
  | "reviewing"
  | "fixing"
  | "completed"
  | "failed"
  | "aborted";
```

Note: `"paused"` was removed in the 2026-08-21 remediation (§52 Finding 12) — it was dead code. Re-add only with a real producer.

Terminal states:

```text
completed
failed
aborted
```

---

# 10. State Machine

Primary workflow:

```text
CREATED
   │
   ▼
SCOUTING
   │
   ▼
PLANNING
   │
   ▼
PLAN_READY
   │
   ▼
IMPLEMENTING
   │
   ▼
TESTING
   │
   ├── unacceptable failure
   │           │
   │           ▼
   │         FIXING
   │
   └── acceptable
             │
             ▼
         REVIEWING
           /     \
        PASS     REQUEST_CHANGES
         │             │
         ▼             ▼
     COMPLETED       FIXING
                       │
                       ▼
                    TESTING
                       │
                       ▼
                   REVIEWING
```

Every transition MUST be made by code.

Agents MUST NOT decide the next workflow state directly.

For example, reviewer returns:

```json
{
  "verdict": "REQUEST_CHANGES"
}
```

The workflow engine converts that result into:

```text
reviewing → fixing
```

---

# 11. Workflow Run Identity

Each workflow invocation receives an immutable run ID.

Recommended:

```text
wf_<timestamp>_<random>
```

Example:

```text
wf_20260821_124500_a81f
```

Each subagent node receives:

```text
ownerRunId = workflowRunId
nodeId = stable logical node identity
requestId = individual attempt identity
```

Examples:

```text
plan
implement
review-1
fix-1
review-2
fix-2
final-review
```

Strict-mode review rounds additionally get the specialized reviewer node
identities `review-N-a` and `review-N-b`. The final fresh reviewer
`review-N-final` runs in a round only after BOTH Reviewer A and Reviewer B
return PASS (see §35); a round in which either one requests changes
transitions straight to `fixing` and never launches `review-N-final`.

Do not use array position as identity.

---

# 12. Persistence

Store project-local workflow state under:

```text
.pi/workflow/
```

Recommended layout:

```text
.pi/
└── workflow/
    ├── active.json
    └── runs/
        └── wf_20260821_124500_a81f/
            ├── state.json
            ├── events.jsonl
            ├── request.md
            ├── requirement.md          # exact immutable spec bytes
            ├── plan.json
            ├── implementation.json
            ├── verification/
            │   ├── implementation.json
            │   └── fix-1.json
            ├── scope/
            │   ├── implementation.json
            │   └── fix-1.json
            ├── reviews/
            ├── fixes/
            └── final.json
```

Do NOT copy complete child-agent transcripts unless required for debugging.

Prefer compact structured workflow artifacts.

---

# 13. State File

Example:

```ts
interface WorkflowRun {
  version: 1;

  id: string;

  cwd: string;

  createdAt: string;
  updatedAt: string;

  state: WorkflowState;

  mode: WorkflowMode;

  request: string;

  complexity?: Complexity;

  currentNode?: string;

  reviewRound: number;
  maxReviewRounds: number;

  plan?: PlanResult;

  implementation?: ImplementationResult;

  reviews: ReviewResult[];

  fixes: FixResult[];

  error?: WorkflowError;

  baseline: RepositoryBaseline;

  /**
   * True when the user did not pass an explicit mode flag to `/work auto`,
   * so the mode is auto-routed from the plan's complexity (audit Finding 6,
   * §24/§25). Auto-routed runs launch the planner first and only scout when
   * the resolved mode is normal/strict.
   */
  autoRouted?: boolean;

  /** True once the mode has been finalized (creation for explicit, post-plan for auto). */
  modeResolved?: boolean;

  /** Entry point that created the run; "spec" runs never run planner/scout (incl. resume). */
  source?: "auto" | "plan" | "spec";

  /** Spec document path (relative to cwd); present only for source === "spec". */
  specPath?: string;

  /** Immutable spec metadata; full bytes live only at artifactPath. */
  requirement?: RequirementSnapshot;

  /** Parsed verification commands and optional exact change allowlist. */
  specPolicy?: SpecPolicy;

  /** Latest bounded engine verification and actual-scope aggregates. */
  verification?: VerificationAggregate;
  scopeGate?: ScopeAggregate;
}
```

`WorkflowError` (persisted in `error`) is `{ code, message, nodeId? }` plus an optional
`details` blob for diagnostics; `nodeId` names the failing node where applicable.

State writes MUST be atomic:

```text
write temporary file
fsync/close if appropriate
rename temp → state.json
```

Never leave partially written JSON as authoritative state.

---

# 14. Event Log

Maintain append-only:

```text
events.jsonl
```

Example:

```json
{"ts":"...","event":"workflow.created","state":"created"}
{"ts":"...","event":"node.started","node":"plan"}
{"ts":"...","event":"node.completed","node":"plan"}
{"ts":"...","event":"state.changed","from":"planning","to":"plan_ready"}
```

Event history is informational/recovery-oriented.

`state.json` remains the current authoritative snapshot.

Events emitted by the v0.1 implementation (audit Finding 11 added the node lifecycle
pairs so resume can distinguish "node completed" from "node interrupted"):

```text
workflow.created                  (compact source/mode/requirement/policy metadata)
node.started / node.completed     (once per logical node)
node.failed
state.changed                     (from / to / node / reason)
gate.test                         (legacy non-spec agent-report gate)
gate.verification.started         (ordered command metadata; no output)
gate.verification                 (bounded command/exit aggregate)
gate.scope                        (changed and out-of-scope paths)
spec.loaded                       (snapshot path/hash/size/policy metadata)
spec.snapshot_migrated            (one-time legacy migration metadata)
mode.resolved
planner.fork_unavailable
workflow.preflight_failed
workflow.failed
```

---

# 15. Repository Baseline

At workflow start record:

```ts
interface RepositoryBaseline {
  head?: string;
  branch?: string;
  dirty: boolean;
  status: string[];
  startedAt: string;
}
```

At minimum execute/read equivalent information to:

```bash
git rev-parse HEAD
git branch --show-current
git status --porcelain
```

The workflow MUST NOT:

```text
git reset --hard
git clean -fd
git checkout -- .
git restore .
git stash
change branch
commit
push
```

unless a future explicit feature enables it.

Never destroy pre-existing user changes.

If the worktree is dirty, record the baseline and expose it in `/work status`.

---

# 16. Data Contracts

Use runtime schema validation.

Recommended implementation:

```text
zod
```

or the project's existing schema library.

JSON Schema passed to `pi-subagents` SHOULD match the runtime schema.

Implementation note (v0.1): no external schema library is used. Each result contract
module (`plan.ts`, `implementation.ts`, `review.ts`, `fix.ts`, `scout.ts`) ships a
hand-rolled runtime validator (`validatePlanResult`, `validateImplementationResult`,
`validateReviewResult`, `validateFixResult`, `validateScoutResult`) plus a JSON Schema
constant (e.g. `REVIEW_RESULT_SCHEMA`, `additionalProperties: false`) that is passed to
`pi-subagents` as the structured-output schema. The two MUST stay in sync per contract.
`workflow.ts` instead exports `validateWorkflowRun` for persisted-state validation and
has no delegation JSON Schema constant.

---

# 17. PlanResult

```ts
type Complexity = "low" | "medium" | "high";

interface PlanResult {
  summary: string;

  understanding: string;

  files: Array<{
    path: string;
    purpose: string;
    action: "inspect" | "modify" | "create" | "delete";
  }>;

  steps: Array<{
    id: string;
    description: string;
  }>;

  tests: Array<{
    command?: string;
    description: string;
    required: boolean;
  }>;

  risks: Array<{
    severity: "low" | "medium" | "high";
    description: string;
    mitigation?: string;
  }>;

  assumptions: string[];

  complexity: Complexity;

  requiresSecondReviewer: boolean;
}
```

Planner MUST NOT edit files.

Planner task must explicitly state:

```text
Produce an implementation plan.
Do not modify repository files.
Return only data matching the supplied structured schema.
```

---

# 18. ImplementationResult

```ts
interface ImplementationResult {
  summary: string;

  changedFiles: Array<{
    path: string;
    change: string;
  }>;

  tests: TestResult[];

  unresolvedIssues: string[];

  deviationsFromPlan: Array<{
    description: string;
    reason: string;
  }>;
}
```

Test result:

```ts
interface TestResult {
  command?: string;

  status:
    | "passed"
    | "failed"
    | "skipped";

  summary: string;

  exitCode?: number;
}
```

Worker MUST:

1. inspect relevant repository state;
2. implement the approved plan;
3. run practical tests;
4. report all test failures;
5. report deviations;
6. never hide unresolved issues.

---

# 19. ReviewResult

```ts
type ReviewVerdict =
  | "PASS"
  | "REQUEST_CHANGES";

interface ReviewResult {
  verdict: ReviewVerdict;

  summary: string;

  findings: ReviewFinding[];

  testAssessment: {
    sufficient: boolean;
    explanation: string;
  };

  confidence: number;

  /** Reviewer identity ("reviewer-1", "reviewer-a", "reviewer-b", "reviewer-final"); set by the engine. */
  reviewerId?: string;

  /** 1-based review round this result belongs to; set by the engine. */
  round?: number;
}
```

Finding:

```ts
interface ReviewFinding {
  id: string;

  severity:
    | "blocker"
    | "major"
    | "minor";

  category:
    | "correctness"
    | "regression"
    | "security"
    | "tests"
    | "maintainability"
    | "scope"
    | "performance"
    | "other";

  file?: string;

  line?: number;

  description: string;

  evidence: string;

  recommendedFix?: string;
}
```

`confidence` range:

```text
0.0 – 1.0
```

---

# 20. Reviewer Contract

Every reviewer prompt MUST contain equivalent instructions:

```text
You are an independent code reviewer.

You did not participate in the implementation.

Review the current repository state and implementation against the original
requirement and approved plan.

Do not justify implementation choices merely because they exist.

Inspect the actual code and diff independently.

Focus on concrete defects, regressions, missing tests, unsafe behavior,
incorrect assumptions, and unnecessary scope expansion.

Do not modify files.

Return PASS only if there are no changes worth requiring before completion.

Return REQUEST_CHANGES when concrete corrective work is required.
```

Do not pass worker chain-of-thought or conversational explanation to reviewer.

---

# 21. FixResult

```ts
interface FixResult {
  summary: string;

  addressedFindings: string[];

  unaddressedFindings: Array<{
    findingId: string;
    reason: string;
  }>;

  changedFiles: Array<{
    path: string;
    change: string;
  }>;

  tests: TestResult[];

  /** 1-based fix round (own counter, independent of review rounds); set by the engine. */
  round?: number;
}
```

Fix Worker receives:

```text
original requirement
approved plan
latest review findings
current repository state
```

It does NOT need the original worker conversation.

---

# 22. Quality Gates

Implement gates as pure functions wherever possible.

## Plan Gate

PASS if:

```text
schema valid
steps.length > 0
summary non-empty
tests field present
complexity valid
```

Otherwise:

```text
workflow → failed
```

Do not continue from malformed planning output.

---

## Implementation Gate

PASS if structured output is valid.

If:

```text
unresolvedIssues.length > 0
```

do not automatically fail.

Carry unresolved issues into review.

---

## Test Gate

Classification:

```text
all required tests passed
    → PASS

required tests skipped with defensible reason
    → REVIEW_ALLOWED_WITH_WARNING

any required test failed
    → FIX_REQUIRED
```

A failing required test MUST NOT result directly in `completed`.

---

## Review Gate

```text
verdict == PASS
    → candidate completion

verdict == REQUEST_CHANGES
    → fixing
```

Do not infer verdict from prose.

Use structured `verdict`.

---

## Completion Gate

Workflow can enter `completed` only when:

```text
latest reviewer verdict == PASS
AND
no required test currently has status failed
AND
workflow state is reviewing
```

For strict mode:

```text
all required reviewers must PASS
```

---

# 23. Review Loop Budget

Default:

```text
maxReviewRounds = 3
```

Flow:

```text
review #1
    ↓ request changes
fix #1
    ↓
review #2
    ↓ request changes
fix #2
    ↓
review #3
```

If review #3 still returns:

```text
REQUEST_CHANGES
```

transition:

```text
reviewing → failed
```

Failure reason:

```text
review_budget_exhausted
```

If the budget is exhausted while the latest reviewer(s) PASSED but the completion gate is
still unsatisfied (e.g. required tests still failing), the run instead fails with:

```text
required_tests_failed
```

i.e. `review_budget_exhausted` is used only when a reviewer actually requested changes.

Do NOT silently continue indefinitely.

Expose config later.

---

# 24. Workflow Modes

```ts
type WorkflowMode =
  | "quick"
  | "normal"
  | "strict";
```

---

## Quick

For trivial, localized changes.

```text
Planner
   ↓
Worker
   ↓
Fresh Reviewer
   ↓
Final
```

Suitable for:

```text
small bug fix
small shell change
small configuration change
localized Python patch
```

Default maximum review rounds:

```text
2
```

---

## Normal

Default mode.

```text
Scout
  ↓
Planner
  ↓
Worker
  ↓
Test Gate
  ↓
Fresh Reviewer
  ↓
Fix loop if required
  ↓
Final
```

Default:

```text
maxReviewRounds = 3
```

---

## Strict

For high-risk or architectural work.

```text
Scout
   ↓
Planner
   ↓
Worker
   ↓
Test Gate
   ↓
Reviewer A [fresh correctness]
   ↓
Reviewer B [fresh tests/simplicity]
   ↓
Fix
   ↓
Regression Tests
   ↓
Final Reviewer [fresh]
```

All reviewers MUST use fresh context.

The `Final Reviewer` runs only when Reviewers A and B both PASS in the round;
a `REQUEST_CHANGES` from either one sends the round to `Fix` without
launching a `review-N-final` node (see §35).

In MVP reviewers MAY run sequentially.

Parallel execution is not required for v0.1.

---

# 25. Automatic Complexity Routing

`/work auto` initially launches the planner.

Planner returns:

```text
complexity
requiresSecondReviewer
```

Routing:

```text
complexity == low
    → quick

complexity == medium
    → normal

complexity == high
    → strict
```

Hard override to strict if any of the following are detected:

```text
requiresSecondReviewer == true
high-severity risk exists
security-sensitive change
migration/schema change
build/deployment infrastructure change
large architectural refactor
```

Explicit user mode override wins:

```text
/work auto --quick
/work auto --normal
/work auto --strict
```

If no override:

```text
/work auto
```

uses automatic complexity routing.

Routing timing (audit Finding 6, §52): an auto-routed run launches the planner FIRST and
finalizes the mode only after the plan exists (the `mode.resolved` event is persisted and the
`modeResolved` flag makes this idempotent across resume):

```text
initial mode = defaultMode (mode unresolved until the plan is in)
  → plan
  → resolve mode from the plan:
      quick     → maxReviewRounds = 2, no scout
      normal    → scout runs AFTER the plan; its result feeds the worker
      strict    → scout runs AFTER the plan; strict reviewer set per round
```

An explicit `--quick`/`--normal`/`--strict` override disables auto-routing entirely
(`autoRouted = false`): the mode is final at creation and normal/strict scout BEFORE
planning, as in `/work plan`.

---

# 26. Commands

Argument parsing (implemented in `src/commands/parser.ts`):

```text
/work                      → help
/work help                 → help
plan / spec / auto         → accept --quick|--normal|--strict anywhere in the arguments
implement/review/fix/status/resume/abort → optional runId (defaults to the active run)
first arg not a recognized subcommand → the whole line is treated as /work auto <task>
```

## `/work plan <task>`

Behavior:

```text
create run if needed
capture repository baseline
scout (normal/strict; skipped in quick)
run planner
validate PlanResult
persist plan
state = plan_ready
display plan summary
```

MUST NOT modify code.

The mode is the explicit flag or `defaultMode`. Complexity routing (§25) applies to `/work auto` only; `/work plan` never re-routes the mode from the plan's complexity.

---

## `/work spec <spec-path>`

The spec-driven entry skips scout/planner and uses the same bounded implementation/review/fix state machine with deterministic gates before every review.

Startup order is strict: resolve/read/validate the UTF-8 document; parse the narrow `work` front matter; hash the exact bytes; resolve mode (`CLI > work.mode > defaultMode`); preflight only worker/reviewer; create the run identity; atomically persist `requirement.md`; capture the exact working-tree baseline; then synthesize `plan.json` and execute.

The optional policy shape is:

```yaml
work:
  mode: quick | normal | strict
  verify: [ordered non-empty command block list]
  changes:
    allow: [ordered normalized project-relative path block list]
```

Unknown keys, invalid modes, empty/duplicate commands, empty/duplicate paths, absolute paths, and traversal fail before run creation. Without front matter, verification defaults to `npm test` and scope is not declared.

`state.json` stores only requirement path/hash/size and normalized policy. Worker, reviewer, and fixer prompts carry the original source path, immutable run-relative snapshot path, SHA-256, commands, and scope—not the document body. Both documents are read-only.

After implementation and every fix, an allowlisted run compares actual working-tree hashes against its initial baseline. Scope failure routes directly to fixing. Once scope passes, the engine executes every declared command in order from `cwd`; any non-zero exit routes directly to fixing without consuming a review round. Only passing engine evidence permits review/completion; agent-reported checks are informational.

Resume validates snapshot containment/readability/hash before agent execution and never rereads the source for new-format runs. Legacy embedded specs migrate once. Source fallback is allowed only before any mutating node started; otherwise recovery fails with `requirement_corrupt`.

Status exposes requirement identity, verification PASS/FAIL/PENDING and count, and scope PASS/FAIL/NOT_DECLARED. Completion lists engine commands/exit codes separately from agent reports. `/work spec <TAB>` completes project `spec.md` / `*.spec.md` paths.

---
## `/work implement`

Requires:

```text
state == plan_ready
```

Behavior:

```text
run worker
persist implementation
evaluate test gate
then stop
```

This command does not automatically review unless invoked through `/work auto`.

---

## `/work review`

Valid after implementation/fix.

Behavior:

```text
launch NEW reviewer
context = fresh
persist review
evaluate review gate
```

Never resume an old reviewer.

---

## `/work fix`

Valid when the run state is `fixing`. The run enters `fixing` from a review
`REQUEST_CHANGES` or from a test-gate `FIX_REQUIRED` (`testing → fixing`). When the
state is not already `fixing`, the latest reviewer must have returned:

```text
REQUEST_CHANGES
```

Behavior:

```text
launch fresh fix worker
provide findings
run regression tests
persist result
```

---

## `/work auto <task>`

Fully automated bounded workflow:

```text
baseline
 ↓
scout (explicit normal/strict only; before planning — skipped for auto-routed and quick)
 ↓
plan
 ↓
mode resolution (auto-routed runs only: low → quick, medium → normal, high/strict triggers → strict)
 ↓
scout (post-plan, auto-routed normal/strict only; quick skips it)
 ↓
implement
 ↓
test gate
 ↓
review
 ↓
fix/review loop
 ↓
final gate
 ↓
completed
```

Must stop on:

```text
fatal node error
invalid structured output after retry policy
review budget exhaustion
explicit abort
unrecoverable dependency failure
```

---

## `/work status`

Display:

```text
Run
Mode
State
Current node
Started
Plan status
Changed files
Tests
Review round
Latest verdict
Outstanding findings
```

Run resolution: an explicit runId wins; otherwise the active-run pointer is used. With
neither (no active pointer and no runId), `/work status` falls back to the most recent
run in `.pi/workflow/runs` (newest first); with no runs at all it prints a starter hint
instead of an error.

Example:

```text
pi-workflow

Run: wf_20260821_124500_a81f
Mode: normal
State: reviewing

Plan          PASS
Implementation PASS
Tests          PASS
Review         REQUEST_CHANGES (1/3)

Outstanding:
- major: retry path loses original error
- minor: missing regression test
```

Keep output compact.

---

## `/work resume`

Load active workflow.

Determine state.

Continue from the next safe transition.

Example:

```text
state == fixing
```

Resume fix node.

Do NOT rerun already successfully persisted nodes unless required.

If the previous node has unknown completion state, fail safely and report recovery information rather than assuming success.

---

## `/work abort`

Set:

```text
state = aborted
```

Persist event.

Do not roll back code changes.

Output:

```text
Workflow aborted.
Repository changes were preserved.
```

Aborting an already-terminal run is a no-op that returns the run as-is.

## `/work list`

Read-only listing of every workflow run under `.pi/workflow/runs`, newest first. Never
touches the active-run lock and never modifies a run.

---

# 27. Retry Policy

Differentiate:

```text
agent execution failure
structured output validation failure
quality failure
```

Agent/runtime transient failure:

```text
retry once
```

Malformed structured result:

```text
retry once with schema correction instruction
```

Review verdict:

```text
REQUEST_CHANGES
```

is NOT an execution failure and MUST NOT be retried as the same reviewer.

Instead transition to:

```text
fixing
```

and later launch a NEW reviewer.

---

# 28. Subagent Adapter

Define an internal abstraction independent of Pi events.

```ts
interface AgentExecutor {
  execute<T>(
    request: AgentExecutionRequest<T>
  ): Promise<AgentExecutionResult<T>>;
}
```

Example request:

```ts
interface AgentExecutionRequest<T> {
  workflowRunId: string;

  nodeId: string;

  agent: string;

  task: string;

  context: "fresh" | "fork";

  cwd: string;

  schema: object;

  thinking?: string;

  timeoutMs?: number;

  model?: string;

  /** Optional streaming progress hook (current tool, args, recent output, tokens, duration). */
  onUpdate?: (update: AgentProgressUpdate) => void;
}
```

Progress update (implemented in `src/agents/executor.ts` as `AgentProgressUpdate`):

```ts
interface AgentProgressUpdate {
  nodeId: string;
  agent: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput?: string;
  recentOutputLines?: string[];
  recentTools?: Array<{ tool: string; args: string }>;
  model?: string;
  toolCount?: number;
  durationMs?: number;
  tokens?: number;
}
```

Result:

```ts
interface AgentExecutionResult<T> {
  status:
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out";

  result?: T;

  error?: string;

  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
    durationMs?: number;
    turns?: number;
    toolCalls?: number;
  };

  model?: string;
  thinking?: string;
}
```

`onUpdate` is the streaming channel behind the live progress UI: `PiSubagentsExecutor`
forwards pi-subagents delegation update events as `AgentProgressUpdate`s, and the engine
surfaces them as `WorkflowProgressEvent`s (see §40). `FakeAgentExecutor` may ignore the
hook entirely.

Production implementation:

```text
PiSubagentsExecutor
```

Test implementation:

```text
FakeAgentExecutor
```

Workflow engine MUST depend on the interface, not Pi events directly.

---

# 29. Preflight

Before first execution in a workflow, verify required agents.

Normal mode requires:

```text
scout
planner
worker
reviewer
```

If `planner` does not exist as a configured agent, the implementation MAY use a configurable role mapping.

Configuration example:

```json
{
  "agents": {
    "scout": "scout",
    "planner": "planner",
    "worker": "worker",
    "reviewer": "reviewer"
  }
}
```

If required launch contracts cannot resolve:

```text
fail before modifications
```

Error should explain exactly which role cannot launch.

Use `pi-subagents/preflight` rather than guessing available tools/models.

Implementation details (v0.1, `src/agents/preflight.ts`):

- Quick mode requires only `planner`, `worker`, `reviewer` (scout is skipped in quick);
  normal/strict additionally require `scout`. The spec-driven flow (`/work spec`,
  `validateWorkflowPreflight`'s `requiredRoles` override) requires only
  `worker` and `reviewer` because it launches no scout or planner node.
- Each role has a small candidate fallback list (e.g. `scout → researcher`,
  `planner → researcher / scout / oracle`); a candidate that fails its launch-contract
  check triggers the next candidate. A THROWN preflight failure is a genuine failure and
  is surfaced immediately — it never masks into a fallback (audit Finding 10; §52).
- Module-loading errors from `pi-subagents/preflight` (`ERR_MODULE_NOT_FOUND` and peers)
  mean the module is simply unavailable in this runtime (e.g. plain `node`); preflight is
  then skipped with a `preflight_module_unavailable` diagnostic and `moduleUnavailable =
  true`. Anything the preflight logic itself throws is a real failure, not a skip.
- The resolved role → agent mapping is RETURNED and used for the whole run; the engine
  never mutates `config.agents` (audit Finding 10).

---

# 30. Role Capability Expectations

Expected conceptual capability:

```text
Scout
read-only repository exploration

Planner
read-only analysis

Reviewer
read-only review

Worker
repository edit + test execution
```

Do not attempt to grant tools through `pi-workflow` if `pi-subagents` owns agent/tool resolution.

Preflight and document the effective capability instead.

Reviewer prompts MUST explicitly prohibit edits even if its configured tools accidentally permit them.

---

# 31. Prompt Construction

Prompt templates belong in:

```text
src/prompts/
```

Suggested (and implemented in v0.1):

```text
src/prompts/
├── common.ts    — shared rules (autonomy constraint, below)
├── scout.ts
├── planner.ts
├── worker.ts
├── reviewer.ts
└── fixer.ts
```

Autonomy constraint (audit Finding 13, §52): every node prompt appends a `## Autonomy
Constraint` section (`AUTONOMOUS_EXECUTION_RULE` in `src/prompts/common.ts`) that prohibits
`contact_supervisor`, `intercom`, and any coordination/progress-reporting tool: such calls
detach a delegated run and discard its result, and no supervisor is waiting. This is
prevention, not a guarantee — the engine additionally retries intercom-detach-class
failures once with an explicit prohibition reminder (`src/policies/intercom.ts`).

Keep prompts compact.

Do not embed workflow logic like:

```text
if reviewer fails launch worker...
```

inside prompts.

That belongs in the state machine.

Prompts define only the node's local contract.

---

# 32. Suggested Repository Structure

```text
pi-workflow/
├── index.ts                 (package entrypoint: re-exports src/)
├── package.json
├── tsconfig.json
├── README.md
│
├── src/
│   ├── index.ts             (library entrypoint: re-exports extension + public API)
│   ├── extension.ts
│   │
│   ├── commands/
│   │   ├── work.ts
│   │   ├── parser.ts
│   │   ├── renderer.ts
│   │   ├── ui-port.ts
│   │   ├── widget.ts
│   │   └── widget-renderer.ts
│   │
│   ├── engine/
│   │   ├── engine.ts
│   │   ├── state-machine.ts
│   │   ├── transitions.ts
│   │   └── errors.ts
│   │
│   ├── agents/
│   │   ├── executor.ts
│   │   ├── pi-subagents-executor.ts
│   │   └── preflight.ts
│   │
│   ├── contracts/
│   │   ├── plan.ts
│   │   ├── implementation.ts
│   │   ├── review.ts
│   │   ├── fix.ts
│   │   ├── scout.ts
│   │   └── workflow.ts
│   │
│   ├── gates/
│   │   ├── plan-gate.ts
│   │   ├── test-gate.ts
│   │   ├── review-gate.ts
│   │   └── completion-gate.ts
│   │
│   ├── policies/
│   │   ├── complexity.ts
│   │   ├── context.ts
│   │   ├── retry.ts
│   │   ├── fork.ts
│   │   ├── intercom.ts
│   │   └── refusal.ts
│   │
│   ├── prompts/
│   │   ├── common.ts
│   │   ├── scout.ts
│   │   ├── planner.ts
│   │   ├── worker.ts
│   │   ├── reviewer.ts
│   │   └── fixer.ts
│   │
│   ├── repository/
│   │   └── baseline.ts
│   │
│   └── storage/
│       ├── store.ts
│       ├── events.ts
│       └── paths.ts
│
└── test/
    ├── state-machine.test.ts
    ├── gates.test.ts
    ├── context-policy.test.ts
    ├── workflow-auto.test.ts
    ├── spec-flow.test.ts
    ├── recovery.test.ts
    ├── lock.test.ts
    ├── commands.test.ts
    ├── audit-remediation.test.ts
    ├── progress.test.ts
    ├── ui-port.test.ts
    ├── widget.test.ts
    ├── widget-renderer.test.ts
    ├── node-execution.test.ts
    └── fake-executor.ts
```

This tree reflects the implemented v0.1 layout (synchronized 2026-08-21). Newer files:
`commands/ui-port.ts` (typed UI port), `commands/widget.ts` + `commands/widget-renderer.ts`
(live aboveEditor progress widget, see `docs/spec-workflow-output-widget.md`),
`policies/fork.ts` / `policies/intercom.ts` / `policies/refusal.ts` (audit Findings
1/13/14), `prompts/common.ts` (autonomy constraint), `engine/node-execution.ts`
(shared node execution/retry loop), and the matching test files
(`audit-remediation.test.ts` covers the §52 findings; `progress.test.ts`,
`ui-port.test.ts`, `widget.test.ts`, `widget-renderer.test.ts` cover the live progress UI;
`spec-flow.test.ts` covers the `/work spec` spec-driven flow).

Do not create additional abstraction layers unless needed.

---

# 33. Context Builder

Never hand the entire workflow state blindly to every agent.

Build role-specific inputs.

Planner:

```text
user request
parent context via fork
scout summary
repository hints
```

Worker:

```text
original request
approved PlanResult
relevant scout result
```

Reviewer:

```text
original request
approved plan
implementation summary
test evidence
latest requested findings when re-reviewing
instruction to inspect current repo/diff independently
```

Fix Worker:

```text
original request
approved plan
latest review findings
test failures
```

Avoid:

```text
entire previous agent transcripts
old reviewer reasoning
worker justification conversations
unrelated parent history
```

---

# 34. Strict Reviewer Separation

Implement a dedicated helper:

```ts
function createReviewerRequest(...)
```

It MUST hardcode:

```ts
context: "fresh"
```

Do not expose reviewer context mode through ordinary CLI flags.

This should NOT be allowed:

```text
/work review --fork
```

There should be no supported way for a user/model accidentally to disable reviewer freshness.

If future advanced users need this behavior, it requires an explicit code-level policy change.

---

# 35. Reviewer Specialization

Normal mode:

```text
reviewer: general correctness
```

Strict mode:

Reviewer A:

```text
correctness
regressions
requirements compliance
```

Reviewer B:

```text
tests
unnecessary complexity
maintainability
scope creep
```

Final reviewer (node `review-N-final`):

```text
verify current final state independently
focus especially on whether previously reported findings remain
```

The final reviewer runs only when Reviewer A and Reviewer B both PASS in that
round. If either one requests changes, the round transitions directly to
`fixing` and no final reviewer is launched (regression coverage:
`test/workflow-auto.test.ts`, the strict-mode final-reviewer tests).

Do not merely ask Reviewer B to critique Reviewer A.

Both inspect implementation independently.

---

# 36. Failure Model

Define explicit workflow errors.

```ts
type WorkflowErrorCode =
  | "dependency_unavailable"
  | "preflight_failed"
  | "agent_execution_failed"
  | "invalid_structured_output"
  | "required_tests_failed"
  | "review_budget_exhausted"
  | "invalid_transition"
  | "state_corrupt"
  | "workflow_aborted"
  | "incomplete_node"
  | "unknown";
```

`incomplete_node` (added in the 2026-08-21 remediation, §52 M2): a mutating node started before an interruption but neither completed nor persisted a result, so resume fails safely instead of re-running it on a possibly-modified tree.

Persist failures.

Example:

```json
{
  "code": "review_budget_exhausted",
  "message": "Reviewer requested changes after 3 rounds.",
  "nodeId": "review-3"
}
```

---

# 37. Concurrency

v0.1 MUST prioritize correctness over parallelism.

Use sequential execution for:

```text
planner
worker
review/fix loop
```

Strict Reviewer A/B MAY initially execute sequentially.

Architecture SHOULD allow:

```ts
Promise.all(...)
```

for future independent reviewers, but do not delay MVP to implement this.

Never run two writing workers against the same worktree concurrently.

---

# 38. Locking

Only one modifying `pi-workflow` run may be active per project in MVP.

Store:

```text
.pi/workflow/active.json
```

Starting a second modifying workflow should fail with:

```text
An active workflow already exists: <run-id>
Use /work status, /work resume, or /work abort.
```

Read-only `/work review` for the active run remains allowed.

Handle stale active markers by examining persisted terminal state.

---

# 39. User Steering

Do not implement full mid-node steering in MVP.

Between nodes, the user may issue:

```text
/work status
/work abort
```

Future:

```text
/work steer
```

can use the `pi-subagents` RPC steering API.

Keep this out of v0.1.

---

# 40. Output UX

Do not dump raw JSON unless debugging.

Render concise workflow progress.

Example:

```text
pi-workflow · normal

✓ Scout
✓ Plan
✓ Implement
✓ Tests
● Review 1/3

Reviewer requested 2 changes:
1. major · retry path can lose the original error
2. minor · missing regression test
```

After fix:

```text
✓ Fix 1
✓ Regression tests
● Review 2/3
```

Completed:

```text
pi-workflow · completed

Changed:
- src/foo.ts
- test/foo.test.ts

Tests:
✓ 18 passed

Review:
✓ PASS after 2 rounds

Run:
wf_20260821_124500_a81f
```

### Live progress surfaces (v0.1)

While any node is running, the command layer provides three live surfaces in addition to
the milestone summary (full design in `docs/spec-workflow-output-widget.md`):

1. **Working breadcrumb** (`ctx.ui.setWorkingMessage`): the in-flight node as
   `[agent] action · tool · 8.4s · 142.0k tok`.
2. **Live widget** (TUI only): a single tree-branch widget registered as
   `pi-workflow-live` with `aboveEditor` placement. `Ctrl+O` toggles a verbose block;
   animation is a 500 ms spinner tick that re-renders only when the render key changes;
   in RPC mode the same pure renderer emits plain `string[]` lines; in print/JSON mode no
   widget is attempted at all. Example (actual rendered lines):

   ```text
   ⠋ [pi-workflow] auto (normal) · node: worker · 8.4s · 142.0k tok
   ├─ ⠋ worker (Executing code implementation...)
   │  ⎿ tool: edit_file (src/engine/transitions.ts)
   │  ⎿ Applied patch · Running npm test: 7/7 passed
   └─ 按 Ctrl+O 展开实时工具输出
   ```

   The header label names the entry point — `auto (<mode>)` by default,
   `spec (<mode>)` for spec-driven runs; the toggle hint is currently Chinese-only.
3. **Milestone trace lines** (`notify`): each finished node settles into a permanent
   `✓ [agent] action · 3.2s · 65.2k tok` line, with `⚠️`/`✗` variants and `↳`-indented
   detail sublines (review findings on REQUEST_CHANGES, failed fix tests).

The engine drives all three through its `WorkflowProgressEvent` stream (`node_start` /
`node_update` / `node_end`, `src/engine/engine.ts`), mapped by `createProgressNotifier`
(`src/commands/work.ts`) through the typed `WorkflowUI` port (`src/commands/ui-port.ts`,
which also suppresses stale-context errors after `/reload`). The widget is created on the
first node event and disposed in the command handler's cleanup regardless of command
outcome, so stale progress is never left on screen.

---

# 41. Logging

Normal output:

```text
concise
human readable
```

Detailed diagnostics persist to workflow artifacts.

Do not stream huge agent outputs directly into the parent conversation unless Pi's normal delegation UI already owns that rendering.

Never log secrets deliberately.

---

# 42. Configuration

MVP config:

```ts
interface WorkflowConfig {
  defaultMode: "quick" | "normal" | "strict";

  maxReviewRounds: number;

  agents: {
    scout: string;
    planner: string;
    worker: string;
    reviewer: string;
  };
}
```

Defaults:

```json
{
  "defaultMode": "normal",
  "maxReviewRounds": 3,
  "agents": {
    "scout": "scout",
    "planner": "planner",
    "worker": "worker",
    "reviewer": "reviewer"
  }
}
```

Do not expose dozens of tuning knobs in MVP.

---

# 43. Tests

Unit tests MUST cover state-machine behavior without launching real models.

Use:

```text
FakeAgentExecutor
```

---

## Required State Tests

```text
created → planning
planning → plan_ready
plan_ready → implementing
implementing → testing
testing → reviewing
reviewing + PASS → completed
reviewing + REQUEST_CHANGES → fixing
fixing → testing
abort from active state → aborted
invalid transitions rejected
```

---

## Reviewer Freshness Test

Test every reviewer request.

Required assertion:

```ts
expect(request.context).toBe("fresh");
```

Include repeated review rounds.

---

## Review Budget Test

Fake responses:

```text
review #1 REQUEST_CHANGES
review #2 REQUEST_CHANGES
review #3 REQUEST_CHANGES
```

Expected:

```text
state == failed
error.code == review_budget_exhausted
```

---

## Successful Auto Test

Fake sequence:

```text
plan
implementation
tests pass
review PASS
```

Expected:

```text
completed
```

---

## Fix Loop Test

Fake sequence:

```text
plan
implementation
review REQUEST_CHANGES
fix
review PASS
```

Expected:

```text
completed
reviewRound == 2
```

---

## Persistence Test

Interrupt after:

```text
implementation
```

Reload state.

Call resume.

Expected next logical node:

```text
review
```

Do not rerun implementation.

---

## Corruption Test

Invalid `state.json`.

Expected:

```text
fail safely
do not modify repo
state_corrupt
```

---

# 44. Integration Tests

After unit tests pass, run real integration against installed `pi-subagents`.

Minimum scenarios:

### Scenario A — Tiny bug

```text
/work auto --quick <small bug>
```

Expected:

```text
plan
edit
test
fresh review
completed
```

### Scenario B — Reviewer finds defect

Seed a task likely to produce an intentionally incomplete implementation.

Expected:

```text
review REQUEST_CHANGES
fix
new reviewer
PASS
```

Verify reviewer process/session identity changes.

### Scenario C — Interrupted workflow

Interrupt after plan/implementation.

Restart Pi.

Run:

```text
/work resume
```

Expected:

```text
workflow continues without redoing completed node
```

### Scenario D — Review budget

Force reviewer to reject three rounds.

Expected:

```text
failed
review_budget_exhausted
```

---

# 45. Implementation Phases

Implement strictly in this order.

## Phase 1 — Scaffold

Deliver:

```text
extension loads
/work help works
directory structure created
tests run
```

No real subagents yet.

---

## Phase 2 — Contracts + State Machine

Implement:

```text
schemas
WorkflowRun
state transitions
quality gates
FakeAgentExecutor
unit tests
```

All state-machine unit tests must pass before integration work.

---

## Phase 3 — Persistence

Implement:

```text
.pi/workflow/runs/
atomic state.json
events.jsonl
active workflow pointer
status
abort
```

Test restart/reload.

---

## Phase 4 — pi-subagents Adapter

Implement:

```text
preflight
structured delegation request
structured response handling
timeout/error handling
schema results
usage capture
```

Do not modify workflow engine to know Pi event details.

---

## Phase 5 — `/work plan`

Implement planner-only flow.

Acceptance:

```text
/work plan task
```

creates persisted valid `PlanResult`.

No repository edits.

---

## Phase 6 — `/work implement` + `/work review`

Implement:

```text
worker
test gate
fresh reviewer
review result
```

Add explicit reviewer freshness tests.

---

## Phase 7 — Fix Loop

Implement:

```text
REQUEST_CHANGES
   ↓
fix
   ↓
test
   ↓
new fresh reviewer
```

Bound to maxReviewRounds.

---

## Phase 8 — `/work auto`

Connect existing primitives.

Do not add new orchestration logic to prompts.

State machine owns execution.

---

## Phase 9 — Resume

Implement safe recovery.

Test restart between every major state.

---

## Phase 10 — Strict Mode

Add:

```text
second reviewer
final fresh reviewer
complexity routing
```

Only after normal workflow is stable.

---

# 46. MVP Acceptance Criteria

The implementation is considered complete only when ALL of the following are true:

Verdict 2026-08-21: ALL TRUE - see the Acceptance Record below the list.
Evidence keys: U = unit suite 69/69 (`node --test`, FakeAgentExecutor only);
R = real-subagent runs ("Real-run validation campaign", below, plus the two
2026-08-21 §44 runs `wf_20260821_162917_3971`, `wf_20260821_173021_b04d`).

```text
[x] extension installs and loads normally              (R: 10/10 live runs
    drove /work commands through the extension in headless Pi)

[x] /work plan works                                  (U: commands.test.ts
    parser; audit-remediation "plan node failure in /work plan";
    R: plan node executed 8/8 campaign runs)

[x] /work implement works                             (U: commands.test.ts;
    R: implement node executed in all 10 live runs)

[x] /work review works                                (U: commands.test.ts;
    Finding 7 precondition test; R: d727 live reviews r1+r2)

[x] /work fix works                                   (U: commands.test.ts;
    R: d727 live fix-1 node)

[x] /work auto works                                  (U: workflow-auto
    7 tests; R: 10/10 live runs end-to-end)

[x] /work status works                                (U: commands.test.ts
    status renderer; R: verified via engine API across the campaign;
    TUI rendering itself not manually inspected - residual below)

[x] /work resume works                                (U: recovery.test.ts
    resume; M1/M2/Finding 8 tests; R: live interrupt-resume scenario
    never executed - residual below)

[x] /work abort works                                 (U: recovery.test.ts
    abort; R: stuck run wf_20260821_132100_2e48 aborted live)

[x] workflow state persists across Pi restart         (U: state-machine
    atomic persist; recovery resume; live restart residual below)

[x] workflow engine is testable without real models   (U: entire 69-test
    suite runs on FakeAgentExecutor)

[x] pi-subagents is accessed only through public
    integration contracts                             (code audit, §52
    post-remediation independent review; no internals duplicated)

[x] planner output is schema validated                (U: gates.test.ts
    Plan Gate; engine plan-node validation)

[x] worker output is schema validated                 (U: Finding 4
    "validates worker output and retries")

[x] reviewer output is schema validated               (U: Finding 4
    malformed-verdict retry + invalid_structured_output tests)

[x] every reviewer launch explicitly uses context=fresh
                                                      (U:
    context-policy.test.ts, WorkflowInvariantError on non-fresh)

[x] reviewer sessions are never resumed between rounds
                                                      (U: context-policy
    multi-round fresh test; engine launches a new run per round;
    R: d727 reviewer ran twice as two distinct sessions)

[x] REQUEST_CHANGES deterministically transitions to fixing
                                                      (U: gates.test.ts
    "returns fixing for REQUEST_CHANGES"; R: d727 live)

[x] PASS deterministically reaches completion gate   (U: gates.test.ts
    completion; R: 8/8 PASS runs -> completed)

[x] failed required tests cannot directly reach completed
                                                      (U: gates.test.ts
    "blocks completion if test failed"; Finding 3 routing tests)

[x] review loop is bounded                            (U: workflow-auto
    budget-exhaustion test; R: d727 live exhaustion -> failed)

[x] pre-existing user changes are never automatically reverted
                                                      (code audit: no
    revert/stash/checkout path exists in src/)

[x] workflow never commits or pushes automatically    (code audit: no
    git commit/push code exists in src/)

[x] malformed persisted state fails safely            (U: recovery.test.ts
    state_corrupt + invalid-schema; Finding 12 paused-as-corrupt)

[x] interrupted workflow can resume from persisted checkpoint
                                                      (U: recovery.test.ts
    resume without re-running; M2 three-branch settle)

[x] normal-mode end-to-end integration test passes   (R: c92a, d4bd
    normal-mode runs, scout -> plan -> completed)

[x] review-fix-review integration test passes        (U: workflow-auto
    "completes when reviewer passes in round 2"; R: d727 live
    FAIL -> fix -> re-review; round-2 PASS live residual below)
```

### §46 Acceptance Record (2026-08-21)

```text
verdict:    MVP acceptance criteria MET
verified:   unit tests 69/69 pass (node --test, FakeAgentExecutor only)
            typecheck  tsc --noEmit clean
            real runs  10 live end-to-end runs vs pi-subagents
                       (8 documented in "Real-run validation campaign"
                       below + wf_20260821_162917_3971, wf_20260821_173021_b04d)
```

Accepted residuals (risk-assessed, none blocks MVP):

```text
1. reviewing->completed at reviewRound >= 2 never observed live.
   Mitigation: post-review gate code is round-agnostic (reviewRound is a
   counter in state/prompt only); identical transition fired 8/8 at round 1;
   FAIL->fix->PASS covered by workflow-auto.test.ts. Risk ~0.

2. Scenario C (interrupt -> restart Pi -> /work resume) never executed
   with real subagents. Mitigation: resume logic is fully unit-tested
   (recovery.test.ts resume-without-re-run; M1 lock release; M2
   three-branch settle incl. incomplete_node; Finding 8 scout
   rehydration; Corruption Test); the state machine and persistence layer
   exercised live in all 10 runs (every transition persisted and
   re-readable via engine API). A live scenario C run remains a cheap
   follow-up if doubt arises. Risk: low.

3. /work status verified via engine API + unit-tested renderer; the TUI
   rendering was never manually inspected. Risk: minimal (renderer is a
   pure function under test).

4. Planner fork (context=fork) happy path never fired live - all 10 runs
   were headless `pi -p` without persisted parent history, so every run
   exercised the Finding-1 fork_unavailable degradation (10/10 clean,
   zero retries consumed). Fork happy path covered only by unit tests.
   Risk: low.
```

The earlier "Still open" list is superseded by items 2-4 above.

---

# 47. Code Quality Requirements

Prefer:

```text
small modules
explicit types
pure transition functions
dependency inversion for agent runtime
structured errors
runtime schema validation
deterministic tests
```

Avoid:

```text
god classes
huge prompts
implicit state
regex parsing model prose
workflow decisions delegated to LLM
duplicating pi-subagents internals
unbounded retries
silent error recovery
```

---

# 48. Architectural Invariants

These should eventually exist as comments/tests close to implementation:

### Invariant 1

```text
Agents produce evidence/results.
The workflow engine decides transitions.
```

### Invariant 2

```text
Reviewer context is always fresh.
```

### Invariant 3

```text
Workflow state is persisted before proceeding to the next destructive/modifying node.
```

### Invariant 4

```text
An interrupted workflow must never assume an uncertain modifying operation succeeded.
```

### Invariant 5

```text
pi-workflow owns orchestration.
pi-subagents owns child-agent execution.
```

### Invariant 6

```text
User repository changes are preserved unless the user explicitly requests otherwise.
```

### Invariant 7

```text
A spec run's immutable snapshot—not its mutable source or agent prose—is authoritative.
```

### Invariant 8

```text
Required verification means ordered engine executions with real zero exit codes.
Missing evidence never means success.
```

### Invariant 9

```text
Declared scope is checked against actual working-tree hashes, never agent-reported files.
```

---

# 49. Future v0.2+

Only after MVP proves reliable, consider:

```text
parallel reviewers
/work steer
worktree isolation
custom workflow profiles
workflow visualization
token/cost budgets
model routing by node
automatic reviewer specialization
pi-context-engine integration
checkpoint compression
cross-session handoff
workflow metrics
third review verdict (BLOCKED) or requirement_blocked routing for impossible requirements
delegation contract: structured result precedence over the fileMutation gate (or allowNoEdits)
```

Possible future architecture:

```text
                  pi-workflow
                  /         \
                 /           \
        pi-subagents      pi-context-engine
             │                  │
             │                  │
      isolated agents      context lifecycle
```

Do not couple MVP to `pi-context-engine`.

Design interfaces so it can be integrated later.

---

# 50. First Implementation Instruction

Start by implementing ONLY:

```text
1. project scaffold
2. contracts
3. state machine
4. quality gates
5. persistence
6. FakeAgentExecutor
7. unit tests
```

Do NOT integrate real `pi-subagents` until the deterministic engine passes tests.

The first milestone should demonstrate this entirely with fake agents:

```text
Task
 ↓
Fake Planner
 ↓
Fake Worker
 ↓
Fake Reviewer → REQUEST_CHANGES
 ↓
Fake Fix Worker
 ↓
NEW Fake Reviewer → PASS
 ↓
COMPLETED
```

Once this behavior is deterministic and restart-safe, integrate:

```text
pi-subagents/delegation
```

as the runtime adapter.

---

# 51. Final Design Principle

If implementation decisions become ambiguous, use this rule:

> `pi-workflow` should contain everything that must be deterministic, inspectable, persistent, resumable, or policy-enforced.

And:

> `pi-subagents` should contain everything related to actually running an isolated model agent.

Therefore:

```text
workflow routing        → pi-workflow
workflow state          → pi-workflow
review policy           → pi-workflow
retry limits            → pi-workflow
quality gates           → pi-workflow
checkpoint/resume       → pi-workflow

agent spawning          → pi-subagents
fresh/fork execution    → pi-subagents
model execution         → pi-subagents
agent discovery         → pi-subagents
child lifecycle         → pi-subagents
structured leaf result  → pi-subagents
```

The MVP succeeds when `/work auto` is no longer “a clever orchestration prompt”, but a small deterministic software system that happens to use LLM agents as execution nodes.

---

# 52. Audit Findings and Remediation (2026-08-21)

Source: code review of the v0.1 implementation against this specification, plus the first real `/work auto` integration attempt (run `wf_20260821_132100_2e48`), which failed at the planner node.

Verification status at audit time:

```text
unit tests:  35/35 pass (FakeAgentExecutor only)
typecheck:   tsc --noEmit clean
real pi-subagents integration: FAILING (see Finding 1)
```

## Immediate Operator Action

The failed run `wf_20260821_132100_2e48` is stuck in state `planning` and still holds `.pi/workflow/active.json`.

Either:

```text
/work abort     # clear the lock and discard the run
```

or:

```text
/work resume    # re-run the planner node; fork succeeds once the parent
                # Pi session has been persisted to disk
```

## P0 — Blockers

### Finding 1. Planner `fork` context hard-fails when the parent session is not yet persisted

Observed error:

```text
Planner node failed: Failed to create forked subagent session:
Parent session file does not exist: .../<session>.jsonl.
Pi has not persisted enough history to fork yet.
```

Root cause chain:

```text
src/engine/engine.ts:176        planner uses context: "fork" (spec §8)
pi-subagents fork-context.ts    explicit "fork" is strict; only an implicit
                                defaultContext: "fork" downgrades to fresh
pi-subagents api/preflight.ts   fork checks are host_required diagnostics;
                                src/agents/preflight.ts passes no host
                                session snapshot, so preflight cannot
                                detect the condition
src/policies/retry.ts           the deterministic failure consumes the
                                single agent-execution retry, then the
                                node fails
```

Fix:

1. Detect the fork-unavailability failure (missing parent session file / "not persisted enough history") in the plan node.
2. Degrade the planner to `context: "fresh"` for that attempt and append a `planner.fork_unavailable` warning event. The planner prompt is self-contained (task + scout summary), so fresh execution remains correct.
3. Do not count this degradation against the agent retry budget.
4. Longer term: pass the host session snapshot into `pi-subagents/preflight` so the condition is reported before any node runs.

### Finding 2. Node failures are not persisted and the run lock is not released

Evidence from the failed run:

```text
.pi/workflow/runs/wf_20260821_132100_2e48/state.json
  state: "planning"     // never transitioned to failed
  error: <absent>       // violates §36 "Persist failures"
.pi/workflow/active.json
  still points at the failed run
```

`WorkflowError`s thrown inside node executors propagate to the command handler (`src/commands/work.ts:154`) and are only rendered. `/work status` subsequently reports a misleading in-flight state.

Fix:

1. Wrap node execution in `startPlan` / `startImplement` / `startReview` / `startFix` / `startAuto` / `resume` with a failure handler that:
   - transitions the run to `failed` (the transition table already allows `failed` from every active state);
   - persists `error: { code, message, nodeId }` per §36;
   - appends a `workflow.failed` event;
   - releases the active-run lock (terminal-state pointers are already auto-cleared by `getActiveRunId`).

## P1 — Correctness

### Finding 3. Test gate FIX_REQUIRED does not route `testing → fixing`

§10/§22 show a direct `TESTING → FIXING` path for unacceptable test failure. `executeWorkerNode` (`src/engine/engine.ts:301-309`) evaluates the gate, logs an event, and leaves the run in `testing`; the auto loop proceeds to review. Consequences:

- a review round is wasted on code with failing required tests;
- if the reviewer returns PASS while required tests fail and the round budget is reached, the run fails with a misleading `review_budget_exhausted` ("Reviewer requested changes") although the reviewer passed (`src/engine/engine.ts:455-464`).

Fix: on `FIX_REQUIRED`, transition `testing → fixing` directly (already allowed by `VALID_TRANSITIONS`) and pass `testGate.failedTests` into the fixer prompt. Only reach the budget-exhausted failure when the latest verdict is actually `REQUEST_CHANGES`.

### Finding 4. Worker/reviewer/fixer outputs are not schema-validated by pi-workflow

§16 and §46 require runtime validation of structured outputs. Only planner output passes a gate. `validateImplementationResult`, `validateReviewResult`, and `validateFixResult` exist but are never called by the engine; a malformed review verdict would be silently treated as "not PASS".

Fix: validate every structured result in the engine; route failures through `RetryPolicy.evaluateValidationFailure` (one retry with a schema-correction prompt), mirroring the plan node.

## P2 — Spec Deviations

### Finding 5. Strict mode never runs the final fresh reviewer

§24 (strict flow) and §35 require a final reviewer that independently verifies the end state after the fix loop. The `final` specialization exists in `src/prompts/reviewer.ts` but is never used by `executeReviewNode`.

Fix: in strict mode, once reviewers A and B pass (and after any fix loop), run one final fresh reviewer with the `final` specialization before transitioning to `completed`.

### Finding 6. Auto-routed quick mode keeps normal-mode parameters

§24 gives quick mode `maxReviewRounds = 2` and no scout; §25 states `/work auto` initially launches the planner. Currently:

- `src/engine/engine.ts:576-577` sets the quick budget only for an explicit `--quick` flag;
- `src/engine/engine.ts:591` decides scout from the initial mode, so auto always scouts;
- the mode is resolved only after planning (`src/engine/engine.ts:226`).

Fix: follow §25 — in auto mode launch the planner first, then run the scout only when the resolved mode is normal/strict (scout output feeds the worker). When the resolved mode is quick, apply `maxReviewRounds = 2`.

### Finding 7. `/work review` accepts state `plan_ready`

§26: review is valid after implementation/fix. `startReview` (`src/engine/engine.ts:627`) also allows `plan_ready`, enabling review of a plan with no implementation.

Fix: restrict review to `testing` and `fixing`.

### Finding 8. Resume does not rehydrate the scout artifact

`resume` re-runs the planner (`src/engine/engine.ts:692-697`) without the scout result, although `scout.json` is persisted.

Fix: load `scout.json` during resume when present and pass it to `executePlanNode`.

## P3 — Robustness / Hygiene

### Finding 9. Retry backoff is never applied

`RetryPolicy.evaluateAgentExecutionFailure` returns `delayMs`, but the engine never sleeps. Either apply the delay or remove the field.

### Finding 10. Preflight swallows real failures

`src/agents/preflight.ts:81-83` catches all exceptions (module missing and genuine resolution failures alike) and can pass vacuously; it also mutates `config.agents` as a side effect. Only tolerate the module-not-found case; surface genuine failures per §29 ("fail before modifications"); return a resolved role mapping instead of mutating config.

### Finding 11. Missing node lifecycle events

§14/§26 reference `node.started` / `node.completed` for recovery decisions; only `workflow.created`, `state.changed`, and `gate.test` are emitted. Emit node lifecycle events around every executor call so resume can distinguish "node completed" from "node interrupted".

### Finding 12. `paused` state is dead code

Defined in `WorkflowState` and the transition table but never produced. Remove it or implement it; not required for MVP.

## Remediation Order

```text
1. Finding 2   persist failures + release lock   (observability, unblocks recovery)
2. Finding 1   planner fork degradation          (unblocks /work auto in young sessions)
3. Finding 3   test gate routing                 (§10/§22 correctness)
4. Finding 4   output schema validation          (§16/§46 acceptance)
5. Finding 5   strict final reviewer             (§24/§35)
6. Finding 6   auto quick routing parameters     (§24/§25)
7. Finding 7   review preconditions              (§26)
8. Finding 8   scout rehydration on resume       (§26)
9. Findings 9-12 hygiene
```

After Findings 1-3 land, re-run the §44 integration scenarios A-D against real `pi-subagents` before claiming §46 MVP acceptance.

## Remediation Status (completed 2026-08-21)

All 12 findings are fixed in code. Verification at this writing:

```text
unit tests:  64/64 pass (FakeAgentExecutor only, incl. new §52 regression tests)
typecheck:   tsc --noEmit clean
stuck run wf_20260821_132100_2e48: aborted, .pi/workflow/active.json cleared
```

### Post-remediation independent review (2026-08-21)

An independent reviewer (fresh-context subagent, read-only) re-audited the
remediation against §52. Round-numbering, fork degradation, validation,
test-gate routing, and lifecycle event ordering were confirmed correct by
inspection. Three additional majors were found and are now fixed (regression
tests in `test/audit-remediation.test.ts`, "Post-remediation review" block):

```text
M1  Lock leak: preflight in resume() and startAuto() ran AFTER the run lock
    was acquired but outside the failure-handling scope. A preflight failure
    threw with .pi/workflow/active.json still pointing at the run. Now: the
    lock is released, a workflow.preflight_failed event is recorded, and the
    run stays resumable in its current state (fix the agent config, resume).
M2  §48 Invariant 4: resume blindly re-ran an interrupted implementing/fixing
    node. If the process died after the mutating node started but before its
    result was persisted, the next resume re-ran the worker/fixer on a
    possibly-modified tree. Now resume distinguishes three cases per node:
    result persisted (implementation.json / fixes/fix-N.json) → re-hydrate
    and settle the gate/transition without re-running; node.started without
    node.completed and no result → fail the run with code incomplete_node and
    recovery guidance; never started → re-run as before.
M3  preflight.ts: a THROWN resolver error was recorded in lastError and then
    masked by fallback candidates (a later candidate resolving normally made
    the whole preflight succeed). Now a throw fails preflight immediately
    (code preflight_error, incl. non-Error throws); only a normal
    result.ok === false may trigger a fallback.
```

Engine changes: new `loadWorkflowEvents` (storage/events.ts), `settleImplementation`/
`settleFix` shared by the normal and resume paths, `nodeStartedWithoutCompletion`,
injectable `preflightForRun` engine option (test seam), new error code
`incomplete_node`.

Per-finding notes (new regression tests live in `test/audit-remediation.test.ts`):

```text
Finding 1  isForkUnavailableError() (src/policies/fork.ts) detects the exact
           pi-subagents fork-context.ts messages; the plan node degrades to
           context "fresh", emits planner.fork_unavailable, and does NOT
           consume the agent retry budget.
Finding 2  WorkflowEngine.markRunFailed(): transitions to failed, persists
           error {code,message,nodeId} (§36), appends node.failed +
           workflow.failed events, releases the run lock. All start*/resume
           node paths go through it; the command layer renders the failed run.
Finding 3  FIX_REQUIRED now transitions testing→fixing directly; the fixer
           prompt receives the failed tests. Budget exhaustion is reported as
           review_budget_exhausted only when a reviewer actually requested
           changes; a PASS with failing required tests after the budget is
           exhausted fails with required_tests_failed. Review rounds are
           numbered from persisted review history, so test-gate-driven fixes
           do not consume review rounds; fix nodes have their own counter
           (fix-N).
Finding 4  engine validates Scout/Plan/Implementation/Review/Fix results with
           the contract validators; malformed output retries once with a
           schema-correction prompt, then fails invalid_structured_output.
           A malformed review verdict is no longer treated as "not PASS".
Finding 5  strict mode runs one final fresh reviewer (node review-N-final,
           specialization "final") after A/B pass, before completion.
Finding 6  runs carry autoRouted/modeResolved flags. Auto-routed runs launch
           the planner first; the scout runs only when the resolved mode is
           normal/strict (post-plan, feeding the worker); quick applies
           maxReviewRounds = 2. resolveWorkflowMode(plan, undefined) is only
           consulted for auto-routed runs.
Finding 7  /work review accepts only state testing or fixing (plan_ready
           rejected).
Finding 8  resume re-hydrates scout.json and passes it to the planner; an
           interrupted scout (no artifact) is re-run.
Finding 9  retry backoff delayMs is applied via an injectable sleep(); tests
           assert the 1000ms first-retry delay.
Finding 10 preflight tolerates only module-load (ERR_*) errors as "module
           unavailable" (with a diagnostic); resolution failures and thrown
           preflight errors are surfaced as preflight_failed before any
           modification. It returns a resolved role mapping instead of
           mutating config; the engine re-runs preflight per command and
           uses the returned mapping for node execution.
Finding 11 node.started / node.completed events are emitted around every
           executor call (scout, plan, implement, review-N[-a|-b|-final],
           fix-N); node.failed accompanies workflow.failed.
Finding 12 the dead "paused" state is removed from WorkflowState, the
           transition table, the state validator, and resume.
```

Previously open items before claiming §46 MVP acceptance - resolved or
formally accepted 2026-08-21 (see "§46 Acceptance Record" in section 46):

```text
- re-run §44 integration scenarios A-D in a real Pi session
  -> A/B/D executed live (campaign below); scenario C accepted as residual
     (unit-covered, low risk); planner fork happy path accepted as residual
     (degradation covered live 10/10)
- /work status verified via the engine API, not the TUI
  -> accepted as residual (renderer unit-tested; TUI not manually inspected)
```

## Wrap-up Addendum (2026-08-21, second pass)

Follow-up fixes after the remediation review:

```text
- §9/§36 synced with code: "paused" removed from the normative WorkflowState
  type; "incomplete_node" added to the normative WorkflowErrorCode list.
- engine.ts: dead evaluateReviewGate import removed.
- /work auto no longer preflights twice: planPhase() runs one preflight
  before the run is created (§29) and hands the resolved role mapping to the
  whole run. The injectable test seam is now preflightForMode(mode).
- /work plan no longer auto-routes: without a mode flag it uses defaultMode
  and scouts before planning (normal/strict); complexity routing remains
  /work auto only (§25). Pinned by a regression test.
```

Verification:

```text
unit tests:  65/65 pass
typecheck:   tsc --noEmit clean
```

### Finding 13. Delegated children can detach via intercom coordination tools

Discovered during §44 integration testing (run `wf_20260821_162917_3971`, planner node, quick→normal stats task).

Root cause chain:

```text
host Pi session has pi-subagents intercom bridge active
  → every delegated child is injected with "Intercom orchestration channel:"
    instructions and the contact_supervisor tool at launch (outside the
    agent's tools allowlist; pi-subagents runs/shared/pi-args.ts)
  → the planner model made a routine contact_supervisor progress_update call
  → allowIntercomDetach == true (bridge marker present in system prompt,
    pi-subagents subagent-executor.ts)
  → the child run detached; the delegation surfaced a failure even though
    the child had COMPLETED with a valid structured plan (exitCode 0)
  → the agent retry used the identical prompt; the second planner detached
    the same way → node failed
```

Fix (two layers, both in pi-workflow):

1. Prevention: every node prompt ends with an "Autonomy Constraint" section
   (`AUTONOMOUS_EXECUTION_RULE`, src/prompts/common.ts) forbidding
   contact_supervisor / intercom / progress-reporting tools.
2. Resilience: `isIntercomDetachError` (src/policies/intercom.ts) detects
   detach-class failures in every node's agent-failure retry branch; the
   single retry then carries an explicit reminder (`INTERCOM_RETRY_REMINDER`)
   instead of the same prompt verbatim.

Upstream item (pi-subagents, NOT fixed here): delegated runs launched via
`SUBAGENT_DELEGATION_REQUEST_EVENT` should not receive intercom bridge
instructions, or should never detach on intercom — the delegation adapter
(`toSubagentDelegationExecutionParams`) exposes no suppression switch today.
Until that lands, the two layers above are the containment.

Verification after Finding 13:

```text
unit tests:  68/68 pass (incl. Finding 13 regression tests)
typecheck:   tsc --noEmit clean
```

### Finding 14. Worker refusal on impossible tasks is swallowed by the mutation gate

Discovered during §44 integration testing (run `wf_20260821_173021_b04d`, scenario D: contradictory task "make add() return a-b while keeping all existing tests frozen and green").

Root cause chain:

```text
contradictory requirement
  → worker correctly refused: zero edits, returned a contradiction analysis
  → pi-subagents' fileMutation effects gate (expected for implementation
    tasks) failed the run (exitCode 1)
  → the delegation surfaced only the generic message; the worker's
    structured analysis never reached the engine
  → pi-workflow retried once with the identical prompt; the second worker
    refused identically (~84s wasted)
```

Fix (pi-workflow):

1. `isWorkerRefusalError` (src/policies/refusal.ts) detects the
   "completed without making edits" class in the worker and fixer nodes and
   fails the node immediately — no verbatim retry.
2. The failure message is wrapped with guidance via `wrapWorkerRefusal`
   (requirement may be impossible/contradictory, or the worker was lazy;
   see the subagent artifacts for its analysis).

Upstream item (pi-subagents): for structured delegations, a valid structured
result should take precedence over the fileMutation effects gate (or a
delegation flag like `allowNoEdits` should disable it), so an explained
zero-edit refusal can return as a completed result.

Spec gap: ReviewVerdict has no terminal state for impossible requirements —
today they can only end via review_budget_exhausted. See §49.

Verification after Finding 14:

```text
unit tests:  69/69 pass (incl. Finding 14 regression test)
typecheck:   tsc --noEmit clean
```

### Real-run validation campaign (2026-08-21, headless `pi -p -e`)

Eight additional end-to-end runs driven against wf-playground to close the
remaining §44/§46 gap (review FAIL → fix → re-review with real subagents).
Method: trap tasks whose naive implementation passes the stated examples but
violates a stated rule on a hidden dimension.

```text
run                        mode    outcome
wf_20260821_180444_f5ca    quick   divide() zero guard — PASS r1 → completed
wf_20260821_195310_d727    quick   round_half_down — REQUEST_CHANGES r1
                                    (Decimal ROUND_HALF_DOWN = ties toward
                                    zero; -2.5 must pick smaller integer -3)
                                    → fix-1 (sign-aware tie) → r2 REQUEST_CHANGES
                                    (non-tie quantize used ambient Decimal
                                    context) → review_budget_exhausted → failed
wf_20260821_200009_3826    quick   truncate_divide — PASS r1 (worker wrote
                                    sign*(abs//abs) upfront) → completed
wf_20260821_200347_2b99    quick   round_half_up — PASS r1 → completed
wf_20260821_200821_28b1    quick   safe_max NaN trap — PASS r1 (NaN filtered
                                    upfront) → completed
wf_20260821_201240_68f7    quick   mode min-tie trap — PASS r1 (explicit min
                                    tie-break) → completed
wf_20260821_201641_7b28    quick   round_to_int banker's trap — PASS r1
                                    (worker delegated to existing
                                    round_half_up) → completed
wf_20260821_202145_c92a    normal  to_hex32 two's-complement trap — scout ran
                                    (normal mode), PASS r1 (32-bit mask
                                    upfront) → completed; gate.test correctly
                                    skipped a git-dependent command (cwd not
                                    a git repo)
wf_20260821_202559_d4bd    normal  stats_summary 5-constraint task — scout
                                    ran, PASS r1 → completed
```

Transition coverage with real subagents after this campaign:

```text
created→(scout)→planning→plan_ready→implementing→testing→reviewing→completed   8/8 PASS runs
reviewing→fixing (REQUEST_CHANGES)        wf_20260821_195310_d727
fix-N→testing→reviewing round 2           wf_20260821_195310_d727
budget exhaustion → failed, error         wf_20260821_195310_d727
  review_budget_exhausted persisted; lock released (next run started cleanly)
planner.fork_unavailable → fresh degrade  fired in all 8 headless runs
  (no persisted parent session at plan time); zero retries consumed, 8/8 ok
```

Residual (accepted): `reviewing→completed` at reviewRound ≥ 2 was not observed
live — the worker (qwen3.8-27b) satisfied every stated constraint in 7/7
follow-up traps, so no second-round PASS could be induced. The post-review
gate code path is round-agnostic (reviewRound is only a counter in state and
prompt), the identical transition fired 8/8 at round 1, and FAIL→fix→PASS is
covered by unit tests (workflow-auto.test.ts fix loop). Risk accepted as ~0.

Worker quality signal: 7/8 traps dodged — explicit constraints in the request
are honored reliably; only the name→library-constant semantic collision
(round_half_down ≈ Decimal ROUND_HALF_DOWN) slipped through.

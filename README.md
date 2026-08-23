# pi-workflow

📖 **Language:** English | [中文](README.zh-CN.md)

Deterministic coding-workflow orchestrator for [Pi Coding Agent](https://github.com/nicobailon/pi-subagents).

Coordinates isolated subagents through a persistent, inspectable, and resumable state machine.

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

---

## Installation

**Prerequisites**

- [Pi coding agent](https://github.com/nicobailon/pi-subagents)
- [pi-subagents](https://github.com/nicobailon/pi-subagents) ≥ 0.53.0 — the executor that launches every workflow subagent:

```bash
pi install npm:pi-subagents
```

> **Note:** the npm name `pi-workflow` is already taken by an unrelated VS Code extension. Install this project from git or a local path — not via `npm:pi-workflow`.

**Install**

```bash
# from git
pi install git:github.com/bioShaun/pi-workflow

# from a local checkout
pi install /absolute/path/to/pi-workflow
```

`pi install` writes to user settings (`~/.pi/agent/settings.json`) by default; add `-l` to install into project settings (`.pi/settings.json`) instead. Restart pi (or run `/reload` in a session) for the extension to load.

**Required agents**

The workflow's four roles resolve through the pi-subagents agent registry: `scout`, `worker`, and `reviewer` are builtins, and the `planner` role falls back automatically to `researcher` → `scout` → `oracle` when no `planner` agent is defined. This repository additionally ships a dedicated `planner` agent at `.agents/planner.md` (project scope).

**Verify**

```bash
pi list      # pi-workflow should be listed
```

Then run `/work help` inside a pi session — the command table from below should appear.

---

## Core Invariant

> **Reviewer context MUST always be fresh.**

Every review attempt is a new isolated agent invocation (`context: "fresh"`). Reviewer sessions are never resumed or polluted with implementation arguments or rationalizations.

---

## Features

- **State Machine Orchestration**: Code-driven state transitions with deterministic quality gates.
- **Autonomous & Step-by-Step Modes**: Run end-to-end with `/work auto`, or step-by-step with `/work plan`, `/work implement`, `/work review`, and `/work fix`. `/work auto` without a mode flag auto-routes the mode from the plan's complexity (low → quick, medium → normal, high/strict triggers → strict).
- **Quality Gates**: Explicit Plan Gate, Test Gate, Review Gate, and Completion Gate.
- **Live Progress UI**: A tree-branch live widget renders above the editor while any node is running (active node, in-flight tool call, one-line output preview, token/duration counters); each completed node settles into a compact milestone trace line (`✓` with duration and token usage; `⚠️` when a review requests changes; `✗` when a fix node reports failing tests). See [Live Progress](#live-progress) and [`docs/spec-workflow-output-widget.md`](docs/spec-workflow-output-widget.md).
- **Durable Persistence & Recovery**: Atomic state snapshots (`state.json`), append-only event log (`events.jsonl`), and resume from any interruption (including safe failure for mutating nodes that were interrupted mid-flight).
- **Review Loop Budget**: Configurable bounded review loops (3 rounds by default, 2 in quick mode) to prevent infinite repair loops; strict mode runs two specialized reviewers (correctness, then tests/quality) per round plus a final fresh reviewer that runs only after both have passed — if either requests changes the round goes straight to fixing with no final reviewer.
- **Single Active Run Lock**: Prevents conflicting concurrent runs while preserving full safety; terminal runs auto-release the lock.
- **Autonomy Constraint**: Every node prompt prohibits coordination/intercom tools that would detach a child run; detach-class failures are retried once with an explicit prohibition, and zero-edit worker "refusals" fail the node immediately instead of burning the retry budget.
- **Repository Safety**: Preserves user changes; never automatically resets, stashes, commits, or pushes without explicit user command.

---

## Commands

| Command | Description |
|---|---|
| `/work auto <task> [--quick\|--normal\|--strict]` | Run complete automated workflow end-to-end |
| `/work plan <task> [--quick\|--normal\|--strict]` | Produce and validate structured implementation plan |
| `/work spec <spec-path> [--quick\|--normal\|--strict]` | Spec-driven flow: implement → review → fix directly from a prepared spec document (no scout/planner agents) |
| `/work implement [runId]` | Execute implementation worker for approved plan |
| `/work review [runId]` | Launch fresh independent reviewer(s) |
| `/work fix [runId]` | Execute fix worker for review findings |
| `/work status [runId]` | Show structured status of active or specified run |
| `/work resume [runId]` | Resume workflow from last persisted checkpoint |
| `/work abort [runId]` | Abort active workflow (preserves all code changes) |
| `/work list` | List all historical workflow runs |
| `/work help` | Show usage information |

Bare `/work` shows help. A first argument that is not a recognized subcommand is treated as `/work auto <task>` (the whole line becomes the task).

### Spec-Driven Flow (`/work spec`)

For the common case where the requirement is already written down (for example `.scratch/<feature>/spec.md`), `/work spec <path>` skips the scout and planner agents entirely:

```text
spec document ──(deterministic plan synthesis, no LLM)──► implement → test gate → fresh review ↔ fix loop → completed
```

- The spec file is read from disk (relative to the project root or absolute; missing/empty → usage error, >100k characters → split guidance, since the spec is embedded in every node prompt) and embedded verbatim in the run request, so the worker, every fresh reviewer, and the fixer all see the same authoritative requirement.
- The `PlanResult` is synthesized deterministically by the engine (`synthesizeSpecPlan`); it passes the plan gate by construction and is persisted as `plan.json` like any other run.
- Preflight requires only the `worker` and `reviewer` agents — scout/planner need not be configured.
- Review budgets, fresh-reviewer isolation, the fix loop, persistence, and resume behave exactly like `/work auto` (state machine entry: `created → plan_ready`). A spec run records `source: "spec"` + `specPath`; on resume the deterministic plan is restored (state → persisted artifact → re-synthesized from `specPath`) and the automated flow runs to completion — a spec run never falls back to the planner/scout agents.
- `/work spec <TAB>` completes paths of `spec.md` / `*.spec.md` documents found in the project (`.scratch/<feature>/spec.md` convention).
- The run source is visible in `/work status` (`Source: spec (path)`), the live widget header (`spec (mode)`), and the completed summary (`Spec: path`); the completed summary renders the worker's verification commands one per line instead of a bare pass count.

---

## Live Progress

While a workflow command is running, three surfaces report progress:

1. **Working breadcrumb** — a bottom-of-screen `[agent] action · tool · 8.4s · 142.0k tok` line that follows the in-flight node and its current tool call.
2. **Live widget (TUI only)** — a single tree-branch widget anchored above the editor (`pi-workflow-live`, `aboveEditor` placement) showing a spinner, the run mode, the active node/agent/action, the in-flight tool with arguments, a one-line stdout preview, and token/duration counters. `Ctrl+O` expands a verbose block (fresh context, run id, and `status: in-flight I/O · mode` while a tool is in flight) and collapses back. The widget is created on the first node event and disposed when the command finishes (success, failure, or abort), so stale progress never lingers. It refreshes on a 500 ms spinner tick and only re-renders when its render key changes. In RPC mode the same pure renderer is installed once as a static plain-text snapshot at attach (subsequent progress then flows through the breadcrumb and milestone surfaces); in print/JSON mode no external UI calls are made and no visible widget is mounted (the notifier still instantiates a no-op internal widget and timer per run).
3. **Milestone trace lines** — each completed node emits a permanent transcript line, e.g. `✓ [planner] Plan approved (4 steps, low complexity) · 3.2s · 65.2k tok`; a review that requests changes renders as `⚠️` and a fix node with failing tests as `✗`, both with `↳`-indented detail sublines. A failed node execution emits no terminal line — the run failure is surfaced as a workflow error instead.

The engine drives all of this through a typed `WorkflowUI` port (`src/commands/ui-port.ts`) fed by `WorkflowProgressEvent`s (`node_start` / `node_update` / `node_end`); the port also guards every UI call against stale extension contexts after `/reload` or session replacement.

---

## Architecture

```text
pi-workflow/
├── index.ts
├── src/
│   ├── extension.ts
│   ├── commands/
│   │   ├── parser.ts
│   │   ├── renderer.ts
│   │   ├── work.ts
│   │   ├── ui-port.ts
│   │   ├── widget.ts
│   │   └── widget-renderer.ts
│   ├── engine/
│   │   ├── engine.ts
│   │   ├── state-machine.ts
│   │   ├── transitions.ts
│   │   ├── node-execution.ts
│   │   └── errors.ts
│   ├── agents/
│   │   ├── executor.ts
│   │   ├── pi-subagents-executor.ts
│   │   └── preflight.ts
│   ├── contracts/
│   │   ├── workflow.ts
│   │   ├── scout.ts
│   │   ├── plan.ts
│   │   ├── implementation.ts
│   │   ├── review.ts
│   │   └── fix.ts
│   ├── gates/
│   │   ├── plan-gate.ts
│   │   ├── test-gate.ts
│   │   ├── review-gate.ts
│   │   └── completion-gate.ts
│   ├── policies/
│   │   ├── complexity.ts
│   │   ├── context.ts
│   │   ├── retry.ts
│   │   ├── fork.ts
│   │   ├── intercom.ts
│   │   └── refusal.ts
│   ├── prompts/
│   │   ├── common.ts
│   │   ├── scout.ts
│   │   ├── planner.ts
│   │   ├── worker.ts
│   │   ├── reviewer.ts
│   │   └── fixer.ts
│   ├── repository/
│   │   └── baseline.ts
│   └── storage/
│       ├── paths.ts
│       ├── store.ts
│       └── events.ts
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

Module notes:

- `src/commands/ui-port.ts` — typed `WorkflowUI` port over `ctx.ui` (notify, working breadcrumb, widget, terminal input); suppresses stale-context errors after `/reload`.
- `src/commands/widget.ts` — `WorkflowLiveWidget` lifecycle: 500 ms spinner tick, render-key diffing, `Ctrl+O` expand/collapse, RPC `string[]` fallback, disposal.
- `src/commands/widget-renderer.ts` — pure `renderLiveWidget(state, width, theme)` tree-branch renderer (spinner frames, token/duration formatting, narrow-width truncation).
- `src/policies/fork.ts` — detects deterministic planner `fork`-unavailable failures; the engine degrades to `fresh` context (spec §52 Finding 1).
- `src/policies/intercom.ts` — detects intercom-detach child failures and supplies the retry reminder; the engine retries once with an explicit prohibition (§52 Finding 13).
- `src/policies/refusal.ts` — detects and wraps zero-edit worker completions; the engine fails the node immediately instead of burning the retry budget (§52 Finding 14).
- `src/prompts/common.ts` — the autonomy constraint appended to every node prompt (prevents coordination-tool detach, §52 Finding 13).

---

## License

MIT

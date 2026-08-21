# pi-workflow

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

## Core Invariant

> **Reviewer context MUST always be fresh.**

Every review attempt is a new isolated agent invocation (`context: "fresh"`). Reviewer sessions are never resumed or polluted with implementation arguments or rationalizations.

---

## Features

- **State Machine Orchestration**: Code-driven state transitions with deterministic quality gates.
- **Autonomous & Step-by-Step Modes**: Run end-to-end with `/work auto`, or step-by-step with `/work plan`, `/work implement`, `/work review`, and `/work fix`.
- **Quality Gates**: Explicit Plan Gate, Test Gate, Review Gate, and Completion Gate.
- **Durable Persistence & Recovery**: Atomic state snapshots (`state.json`), append-only event log (`events.jsonl`), and resume from any interruption.
- **Review Loop Budget**: Configurable bounded review loops (default 3 rounds) to prevent infinite repair loops.
- **Single Active Run Lock**: Prevents conflicting concurrent runs while preserving full safety.
- **Repository Safety**: Preserves user changes; never automatically resets, stashes, commits, or pushes without explicit user command.

---

## Commands

| Command | Description |
|---|---|
| `/work auto <task> [--quick\|--normal\|--strict]` | Run complete automated workflow end-to-end |
| `/work plan <task> [--quick\|--normal\|--strict]` | Produce and validate structured implementation plan |
| `/work implement [runId]` | Execute implementation worker for approved plan |
| `/work review [runId]` | Launch fresh independent reviewer(s) |
| `/work fix [runId]` | Execute fix worker for review findings |
| `/work status [runId]` | Show structured status of active or specified run |
| `/work resume [runId]` | Resume workflow from last persisted checkpoint |
| `/work abort [runId]` | Abort active workflow (preserves all code changes) |
| `/work list` | List all historical workflow runs |
| `/work help` | Show usage information |

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
│   │   └── work.ts
│   ├── engine/
│   │   ├── engine.ts
│   │   ├── state-machine.ts
│   │   ├── transitions.ts
│   │   └── errors.ts
│   ├── agents/
│   │   ├── executor.ts
│   │   ├── pi-subagents-executor.ts
│   │   └── preflight.ts
│   ├── contracts/
│   │   ├── workflow.ts
│   │   ├── plan.ts
│   │   ├── implementation.ts
│   │   ├── review.ts
│   │   ├── fix.ts
│   │   └── scout.ts
│   ├── gates/
│   │   ├── plan-gate.ts
│   │   ├── test-gate.ts
│   │   ├── review-gate.ts
│   │   └── completion-gate.ts
│   ├── policies/
│   │   ├── complexity.ts
│   │   ├── context.ts
│   │   └── retry.ts
│   ├── prompts/
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
    ├── recovery.test.ts
    ├── lock.test.ts
    ├── commands.test.ts
    └── fake-executor.ts
```

---

## License

MIT

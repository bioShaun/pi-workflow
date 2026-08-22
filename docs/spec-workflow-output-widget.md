# Spec: Workflow Live Output Widget (aboveEditor)

**Status:** ready-for-agent (local publication; no issue tracker configured)
**Date:** 2026-08-21
**Origin:** Conversation synthesizing `docs/prototype-subagent-output-ui.html` (Variant 1) with API verification against `pi-coding-agent@0.84.2` and `pi-subagents` (`fleet-status.ts`).

## Problem Statement

When a user runs `/work auto`, the only live progress signal is a bottom-of-screen
working breadcrumb (`setWorkingMessage`). It is:

- **Invisible in context** — it sits far from the conversation output the user is
  actually reading, and during long subagent executions (scout, implement, review)
  the user cannot tell which node is running, which tool it is currently calling,
  or what that tool is producing.
- **Ephemeral** — when a node completes, its breadcrumb is replaced; the only
  durable record is a compact `notify` trace line, so the user loses the sense of
  a live pipeline and must scroll to reconstruct what happened.
- **Untyped and fragile** — the command layer reaches UI methods through
  `(ctx as any).ui?.notify` casts, with no guard against stale extension contexts
  after `/reload` or session replacement.

The user wants the live workflow state (active node, current tool call, streaming
output preview, token/duration counters) rendered **in the output interface above
the editor**, the way `pi-subagents` already renders its fleet status, with each
completed node settling into a permanent, skimmable milestone trace.

## Solution

Adopt **Variant 1 (Tree-Branch Live Widget)** from
`docs/prototype-subagent-output-ui.html`, absorbing one behavior from Variant 2:

- While a workflow run is active, render a single live widget anchored above the
  editor (`ctx.ui.setWidget(..., "aboveEditor")`) showing: spinner frame, workflow
  identity and mode, the currently running node and its action, the in-flight tool
  call with arguments, a one-line stdout preview, and cumulative token count.
- When a node ends, the widget updates to the next node and a **permanent
  milestone trace** is emitted to the transcript (success / warning / error
  variants, with ⎿-indented detail sublines) — this already exists as the
  `notify` trace path and is preserved unchanged.
- When the run completes, fails, or is aborted, the widget is cleared and the
  existing completion summary is emitted.
- A keyboard toggle (`Ctrl+O`) expands the widget to show verbose detail
  (extended tool output, subagent context info); collapsed is the default.

The visual claim in the prototype header is corrected: the widget is anchored
**above the editor**, below the scrolling transcript — it is never interleaved
into chat history. Durability comes exclusively from milestone trace lines.

## User Stories

1. As a workflow user, I want to see which node (scout / planner / worker /
   reviewer / fixer) is currently executing, so that I know where the run is in
   the pipeline without scrolling.
2. As a workflow user, I want a spinner animation in the live widget, so that I
   can tell at a glance the run is alive and not hung.
3. As a workflow user, I want to see the tool the active subagent is currently
   calling (name and arguments), so that I can judge whether it is doing
   something sensible.
4. As a workflow user, I want a one-line preview of the subagent's latest
   output, so that I get signal about progress without opening any inspector.
5. As a workflow user, I want cumulative token usage visible in the widget, so
   that I can sense the cost of the run as it accrues.
6. As a workflow user, I want each completed node to leave a permanent,
   color-coded milestone trace in the transcript, so that I can reconstruct the
   run's history after it finishes.
7. As a workflow user, I want a review node that returns `REQUEST_CHANGES` to
   produce a warning-styled milestone with its findings listed, so that I can
   see why the run entered a fix round.
8. As a workflow user, I want a fix node whose tests did not all pass to produce
   a warning- or error-styled milestone, so that I am not misled by a green
   checkmark when the fix is incomplete.
9. As a workflow user, I want the live widget to disappear when the run
   completes, fails, or is aborted, so that stale progress is never left on
   screen.
10. As a workflow user, I want to press `Ctrl+O` to expand the widget into a
    verbose view, so that I can inspect extended tool output on demand.
11. As a workflow user, I want the expanded state to collapse back with the same
    shortcut, so that the default view stays compact.
12. As a workflow user, I want the widget to keep rendering while I type in the
    editor, so that monitoring progress never blocks my next instruction.
13. As a workflow user running `/work` subcommands other than `auto` (`plan`,
    `implement`, `review`, `fix`), I want the same live widget behavior, so that
    manual step-through runs are as observable as automated ones.
14. As a user in a narrow terminal, I want the widget to render sanely at small
    widths, so that the layout never breaks my editor.
15. As a user running pi in RPC mode, I want the widget to degrade to plain-text
    lines, so that progress is still visible where component factories are
    unsupported.
16. As a user running pi in print/JSON mode, I want no widget attempts at all,
    so that non-interactive output stays clean.
17. As a maintainer, I want UI access in the command layer to go through a typed
    port instead of `(ctx as any)` casts, so that the compiler catches UI drift.
18. As a maintainer, I want the widget's refresh timer and key subscription to
    be disposed when the run ends or the extension context goes stale, so that
    `/reload` and session switches never throw or leak intervals.
19. As a maintainer, I want the tree rendering to be a pure function of widget
    state, so that it is fully unit-testable without a TUI.
20. As a maintainer, I want the widget to reuse the existing
    `WorkflowProgressEvent` stream (node_start / node_update / node_end), so
    that no changes to the engine or executor are required.

## Implementation Decisions

- **Single UI port in the command layer.** The existing `createProgressNotifier`
  mapping (engine `WorkflowProgressEvent` → UI calls) is upgraded into a typed
  `WorkflowUI` port with `notify`, `setWorking`, `setWidget`, and key-toggle
  capabilities. All `(ctx as any).ui?.*` casts in the command layer are
  eliminated behind this port. `setWorkingMessage` is retained as a secondary
  breadcrumb for non-TUI contexts; the widget becomes the primary live surface.
- **Widget anatomy follows pi-subagents `fleet-status.ts`.** Register the widget
  once via the component-factory overload of `setWidget`; drive animation with a
  ~500 ms interval that recomputes a render key and only calls
  `tui.requestRender()` when the key changed; unsubscribe terminal input and
  clear the interval on dispose; guard all deferred UI calls against stale
  extension contexts (the `isStaleExtensionContextError` pattern).
- **Rendering is a pure function.** The widget's tree (spinner frame, workflow
  header, active node row, `⎿` tool row, `⎿` stdout row, optional expanded
  detail block, footer hint) is produced by a pure `state → string[]` renderer,
  sibling to the existing trace-line renderers. The component shell only adapts
  this to the TUI theme and width.
- **Widget state shape** (decision-rich, from the prototype — trimmed to the
  contract, not the demo):

  ```typescript
  type WidgetState = {
    runId: string;
    mode: "quick" | "normal" | "strict";
    node: string;          // e.g. "review-1"
    agent: string;         // e.g. "reviewer"
    action: string;        // e.g. "Independent review in progress..."
    tool?: { name: string; args?: string };
    stdout?: string;       // one-line preview
    tokens: number;
    expanded: boolean;     // Ctrl+O toggle
    spinnerFrame: number;
  };
  ```

- **Milestone traces stay on the existing path.** `node_end` events continue to
  emit the current success/warning/error trace lines (including review-finding
  and fix-test detail extraction). The widget never writes to the transcript.
- **Keyboard toggle via terminal-input subscription**, matching how pi-subagents
  implements its inspector keys; the toggle only flips `expanded` and re-renders.
- **Mode degradation.** TUI: component factory. RPC (`ctx.hasUI` true, no TUI):
  `string[]` fallback from the same pure renderer. Print/JSON: widget calls are
  skipped entirely; `setWorkingMessage` breadcrumb and trace `notify` lines
  remain the only surfaces.
- **Correction of the prototype's placement claim.** Documentation and any
  user-facing copy describe the widget as anchored above the editor, not
  "inside the main viewport / chat history".
- **No engine, executor, gate, or contract changes.** The feature consumes the
  existing `WorkflowProgressEvent` stream; `event.details.currentTool`,
  `durationMs`, and `tokens` on `node_update` already carry what the widget
  needs. If a field proves missing, the port is extended, not the engine.

## Testing Decisions

**What makes a good test here:** assert externally observable behavior at the
port boundary — given a sequence of `WorkflowProgressEvent`s, assert the exact
sequence of calls on a fake `WorkflowUI` (widget shown/updated/cleared, trace
lines emitted, breadcrumb set/cleared) and the exact `string[]` output of the
pure widget renderer for representative states. Never assert interval timing,
TUI internals, or render-key diffing.

- **Progress → port mapping:** extend the existing `commands.test.ts` suite,
  which already unit-tests `createProgressNotifier` with fake `notify` /
  `setWorking` functions. Add a fake widget sink and assert show/update/clear
  ordering, verdict-driven milestone styling, and fix-node test-failure
  surfacing. Prior art: `test/commands.test.ts`.
- **Pure widget renderer:** new table-driven tests over `WidgetState` inputs —
  running with tool, running without tool, expanded vs collapsed, token
  formatting, narrow-width wrapping, spinner frame selection. Prior art: the
  renderer tests in `test/commands.test.ts` (`renderTraceLine` et al.).
- **Engine-event coverage:** no new engine tests; the existing
  `test/progress.test.ts` (fake event bus + `FakeAgentExecutor`) already proves
  the engine emits the events the port consumes. If the port starts consuming a
  previously unused `details` field, add one case there.
- **Not tested:** the TUI shell (interval, `requestRender` diffing, key
  subscription, stale-context cleanup), consistent with the codebase's existing
  treatment of thin integration shells.

## Out of Scope

- **Variant 2 and Variant 3** from the prototype. The dual-pane inspector
  (Variant 3) is rejected: it requires a rendering paradigm the widget API does
  not support, breaks on narrow terminals, and lacks transcript durability.
  Progressive in-stream cards (Variant 2) contribute only its
  collapse-on-complete behavior, absorbed into the milestone trace design.
- Changes to the workflow engine, state machine, quality gates, retry/recovery
  policies, or `pi-subagents` delegation adapter.
- A settings UI or persistent user preference for the expanded state (the
  toggle is session-local).
- Mouse interaction, clickable widget regions, or overlay/modal inspectors.
- Publishing this spec to an external issue tracker (no tracker is configured;
  see Further Notes).

## Further Notes

- **API verification performed 2026-08-21** against `pi-coding-agent@0.84.2`:
  `setWidget` accepts `string[]` or a component factory; placement defaults to
  `"aboveEditor"`; the RPC protocol supports `string[]` widgets only; print/JSON
  modes have no UI (`ctx.hasUI === false`).
- **pi-subagents reference implementation:** `SubagentFleetStatus`
  (`fleet-status.ts`) is the authoritative pattern for registration, 500 ms
  refresh with render-key diffing, `onTerminalInput` key handling, and
  stale-context-safe cleanup. Copy the structure, not the fleet logic.
- **Tracker publication pending:** this spec is saved locally because the repo
  has no issue tracker configured. Run `/setup-matt-pocock-skills`, then
  re-publish with the `ready-for-agent` triage label.
- The prototype file `docs/prototype-subagent-output-ui.html` remains the
  visual reference for the tree-branch layout and milestone trace styling.

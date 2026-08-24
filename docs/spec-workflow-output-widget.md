# Spec: Workflow Live Output Widget (aboveEditor)

**Status:** implemented (2026-08-21; see the Implementation Record at the end of this doc)
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
  variants, with ↳-indented detail sublines) — this already exists as the
  `notify` trace path and is preserved unchanged.
- When the run completes, fails, or is aborted (i.e. when the command handler
  exits), the widget is disposed in the handler's `finally` block and the
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
    that no new event types are needed — the only engine/executor change is
    forwarding the subagent's `recentOutput` through `node_update.details`.

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
  clear the interval on dispose; guard all port-mediated UI calls against stale
  extension contexts (the `isStaleExtensionContextError` pattern — the widget's
  own `tui.requestRender()` call is unguarded, and disposal of the widget —
  timer plus key subscription — happens in the command handler's `finally`
  block, so a mid-run `/reload` settles when the command finishes).
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
    spinnerFrame?: number; // implementation: optional, ticks at 500 ms
    durationMs?: number;   // implementation: optional, shown in the header
  };
  ```

- **Milestone traces stay on the existing path.** `node_end` events continue to
  emit the current success/warning/error trace lines (including review-finding
  and fix-test detail extraction). The widget never writes to the transcript.
- **Keyboard toggle via terminal-input subscription**, matching how pi-subagents
  implements its inspector keys; the toggle only flips `expanded` and re-renders.
- **Mode degradation.** TUI: component factory. RPC (`ctx.hasUI` true, no TUI):
  `string[]` fallback from the same pure renderer. Print/JSON
  (`ctx.hasUI === false`): the port makes no UI calls at all — `notify`,
  `setWorking`, and `setWidget` are all no-ops, so in that mode there is no
  widget, no working breadcrumb, and no trace `notify` line through this
  port (exercised by `test/ui-port.test.ts`).
- **Correction of the prototype's placement claim.** Documentation and any
  user-facing copy describe the widget as anchored above the editor, not
  "inside the main viewport / chat history".
- **Engine/executor progress wiring is part of the implementation (revised
  2026-08-21).** The original estimate assumed the existing `WorkflowProgressEvent`
  stream already carried everything the widget needs (`event.details.currentTool`,
  `durationMs`, `tokens`). The one-line stdout preview turned out to need
  `recentOutput`, so the implementation adds:
  - `src/agents/pi-subagents-executor.ts` — the delegation-update callback
    forwards `recentOutput` (with its sibling streaming fields) into the
    `AgentProgressUpdate` passed to `onUpdate`;
  - `src/engine/engine.ts` — every node handler (scout, plan, implement,
    review, fix) maps `up.recentOutput` into `details.recentOutput` on the
    `node_update` events it emits.
  No state machine, gate, or contract changes. Regression coverage:
  `test/progress.test.ts` asserts the adapter forwards `recentOutput` for the
  active delegation and that every started node's `node_update` event carries
  it.

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
- **Engine-event coverage:** `test/progress.test.ts` (fake event bus +
  `FakeAgentExecutor`) proves the engine emits the events the port consumes,
  including the `recentOutput` regression coverage: the
  `PiSubagentsExecutor` delegation-update suite asserts the adapter forwards
  `recentOutput` (and its sibling fields) only for the active delegation, and
  the end-to-end engine suite asserts every started node's `node_update` event
  carries `details.recentOutput`.
- **Not tested:** the TUI shell (interval, `requestRender` diffing, key
  subscription, stale-context cleanup), consistent with the codebase's existing
  treatment of thin integration shells.

## Out of Scope

- **Variant 2 and Variant 3** from the prototype. The dual-pane inspector
  (Variant 3) is rejected: it requires a rendering paradigm the widget API does
  not support, breaks on narrow terminals, and lacks transcript durability.
  Progressive in-stream cards (Variant 2) contribute only its
  collapse-on-complete behavior, absorbed into the milestone trace design.
- Changes to the workflow engine, state machine, quality gates, or
  retry/recovery policies, beyond the `recentOutput` progress wiring in the
  engine and the `pi-subagents` delegation adapter described in the
  Implementation Decisions.
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

## Implementation Record (2026-08-21)

Implemented in `src/commands/` with the test coverage promised in the Testing
Decisions section; commits `1633999`, `eec7258`, `a7aca51`:

- **`src/commands/ui-port.ts`** — `WorkflowUI` typed port (`notify`, `setWorking`,
  `setWidget`, `onTerminalInput`, `hasUI`, `isRPC`, `getTheme`). `isStaleExtensionContextError`
  suppresses `context is no longer active` / `session has ended` / `disposed` throws so a
  `/reload` or session swap can never crash a running workflow. RPC detection: `ctx.mode === "rpc"`.
- **`src/commands/widget.ts`** — `WorkflowLiveWidget` (key `pi-workflow-live`).
  `attach()` registers the component factory (TUI) or a `string[]` snapshot (RPC),
  subscribes terminal input for `Ctrl+O` (`isCtrlO`, ASCII 15), and starts an unref'd
  500 ms spinner ticker; `dispose()` clears the interval, unsubscribes, and unmounts the
  widget. Re-renders only when the JSON render key of `{node, agent, action, tool,
  stdout, tokens, expanded, frame, dur (whole seconds)}` changes.
- **`src/commands/widget-renderer.ts`** — pure `renderLiveWidget(state, width, theme)`
  producing the tree-branch lines; 10 braille spinner frames; `formatTokens` / `formatDuration`;
  every line is truncated to `width` with a trailing `…`.
- **`src/commands/work.ts`** — `createProgressNotifier(ui, widgetHolder)` maps
  `WorkflowProgressEvent`s (`node_start` / `node_update` / `node_end`) to the port.
  The widget is created lazily on the first `node_start` (so all subcommands — `auto`,
  `plan`, `implement`, `review`, `fix` — get it) and disposed in the handler's `finally`.

Tests: `test/ui-port.test.ts` (port + stale-context guard), `test/widget.test.ts`
(`Ctrl+O`, render-key diffing, attach/dispose), `test/widget-renderer.test.ts` (pure
renderer, narrow-width truncation), and the “Work command progress wiring” suite in
`test/commands.test.ts` (show/update/clear ordering, verdict-driven milestone styling,
fix-test failure surfacing).

Deviations from this spec (accepted, documented for accuracy):

1. **Header label** — the widget header is fixed `⠋ [pi-workflow] auto (<mode>)`; the
   “auto” label is not per-subcommand, so a manual `/work implement` still shows `auto (mode)`.
   (Cosmetic; the node/agent rows carry the real identity.)
2. **Toggle hint language** — the footer hint is Chinese-only:
   `按 Ctrl+O 展开实时工具输出` (collapsed) / `按 Ctrl+O 折叠详情` (expanded); no i18n.
3. **Trace detail marker** — milestone trace detail sublines use `  ↳ ` indentation (not
   `⎿`); `⎿` appears only on the widget's tool/stdout rows.
4. **Expanded block (Activity Tape)** — the verbose block is upgraded to an Activity Tape: rolling history of recent tool activities (Read, Search, Edit, Run), latest output evidence (up to 2 lines), telemetry freshness (age of last update, warning on staleness), cumulative tool calls, next workflow route, and optional diagnostics when stale/failed. Full logs remain in underlying subagent/session artifacts.
5. **RPC/print degradation** — RPC mode mounts and updates via the UI port; print/JSON mode (`ctx.hasUI === false`) makes no external UI calls and mounts no visible widget.

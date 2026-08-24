import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  renderLiveWidget,
  formatTokens,
  formatDuration,
  truncateToVisibleWidth,
  getVisibleLength,
  type WidgetState,
} from "../src/commands/widget-renderer.ts";
import {
  formatStageLabel,
  formatAgentRole,
  normalizeToolCall,
  normalizeOutputLines,
  updateActivityTape,
  deriveWorkflowRoute,
  formatNextRoute,
} from "../src/commands/activity-normalizer.ts";

describe("Pure Widget Renderer & Activity Tape", () => {
  it("formats tokens and duration accurately", () => {
    assert.equal(formatTokens(0), "0 tok");
    assert.equal(formatTokens(450), "450 tok");
    assert.equal(formatTokens(18400), "18.4k tok");
    assert.equal(formatTokens(142050), "142.1k tok");
    assert.equal(formatTokens(232600), "232.6k tok");

    assert.equal(formatDuration(0), "0.0s");
    assert.equal(formatDuration(3200), "3.2s");
    assert.equal(formatDuration(12400), "12.4s");
    assert.equal(formatDuration(66000), "1:06");
  });

  it("renders collapsed widget state as a bounded 3-row heartbeat without diagnostics", () => {
    const state: WidgetState = {
      runId: "wf_20260823_120000_a1b2",
      source: "spec",
      mode: "strict",
      nodeId: "implement",
      agent: "worker",
      action: "Running verification tests",
      nodeTokens: 232600,
      expanded: false,
      spinnerFrame: 3,
      durationMs: 66000,
    };

    const lines = renderLiveWidget(state, 100);
    assert.equal(lines.length, 3, `Expected exactly 3 rows in collapsed mode, got ${lines.length}`);
    assert.match(lines[0], /⠸ pi-workflow · spec\/strict · Implement · 1:06 · node 232\.6k tok/);
    assert.match(lines[1], /└─ worker · Running verification tests/);
    assert.match(lines[2], /Ctrl\+O 查看最近活动/);
    assert.equal(lines.some((l) => l.includes("context:") || l.includes("runId:")), false);
  });

  it("renders expanded widget state with rolling activities, output evidence, freshness, and route", () => {
    const now = Date.now();
    const state: WidgetState = {
      runId: "wf_20260823_120000_a1b2",
      source: "spec",
      mode: "strict",
      nodeId: "implement",
      agent: "worker",
      action: "Verifying required-test behavior",
      nodeTokens: 232600,
      toolCount: 17,
      activities: [
        {
          key: "read:Read:src/gates/test-gate.ts",
          kind: "read",
          label: "Read",
          detail: "src/gates/test-gate.ts",
          status: "previous",
          output: [],
        },
        {
          key: "edit:Edit:test/gates.test.ts",
          kind: "edit",
          label: "Edited",
          detail: "test/gates.test.ts",
          status: "previous",
          output: [],
        },
        {
          key: "run:Run:node --test test/gates.test.ts",
          kind: "run",
          label: "Run",
          detail: "node --test test/gates.test.ts",
          status: "active",
          output: ["12 passed · 0 failed"],
        },
      ],
      route: [
        { label: "implement", status: "active" },
        { label: "verification", status: "pending" },
        { label: "review A/B", status: "pending" },
        { label: "final review", status: "pending" },
      ],
      expanded: true,
      spinnerFrame: 3,
      durationMs: 66000,
      lastProgressAt: now - 2000,
      now,
    };

    const lines = renderLiveWidget(state, 100);
    assert.ok(lines.length <= 12, `Expanded lines (${lines.length}) must not exceed 12 rows`);
    assert.match(lines[0], /⠸ pi-workflow · spec\/strict · Implement · 1:06 · node 232\.6k tok/);
    assert.match(lines[1], /├─ worker · Verifying required-test behavior/);
    assert.ok(lines.some((l) => l.includes("Recent activity")));
    assert.ok(lines.some((l) => l.includes("Read src/gates/test-gate.ts")));
    assert.ok(lines.some((l) => l.includes("Edited test/gates.test.ts")));
    assert.ok(lines.some((l) => l.includes("Run node --test test/gates.test.ts")));
    assert.ok(lines.some((l) => l.includes("12 passed · 0 failed")));
    assert.ok(lines.some((l) => l.includes("Last progress 2s ago · 17 tool calls")));
    assert.ok(lines.some((l) => l.includes("Next: verification → review A/B → final review")));
    assert.match(lines[lines.length - 1], /└─ Ctrl\+O 折叠/);

    // Expansion should not show runId or context: fresh in healthy state
    assert.equal(lines.some((l) => l.includes("context: fresh") || l.includes("runId:")), false);
  });

  it("renders waiting line when expanded before telemetry arrives", () => {
    const now = Date.now();
    const state: WidgetState = {
      runId: "wf_20260823_120000_a1b2",
      source: "spec",
      mode: "strict",
      nodeId: "implement",
      agent: "worker",
      action: "Starting implementation",
      nodeTokens: 0,
      activities: [],
      route: [
        { label: "implement", status: "active" },
        { label: "verification", status: "pending" },
        { label: "review A/B", status: "pending" },
        { label: "final review", status: "pending" },
      ],
      expanded: true,
      spinnerFrame: 0,
      durationMs: 3000,
      now,
    };

    const lines = renderLiveWidget(state, 100);
    assert.ok(lines.some((l) => l.includes("Waiting for first activity update · 3s")));
    assert.equal(lines.some((l) => l.includes("context: fresh")), false);
  });

  it("distinguishes fresh progress from stale telemetry", () => {
    const now = Date.now();
    const base: WidgetState = {
      runId: "wf_20260823_120000_a1b2",
      source: "auto",
      mode: "normal",
      nodeId: "implement",
      agent: "worker",
      action: "Working...",
      nodeTokens: 5000,
      expanded: true,
      now,
    };

    const freshLines = renderLiveWidget({ ...base, lastProgressAt: now - 8000 }, 100);
    assert.ok(freshLines.some((l) => l.includes("Last progress 8s ago")));

    const warnLines = renderLiveWidget({ ...base, lastProgressAt: now - 47000 }, 100);
    assert.ok(warnLines.some((l) => l.includes("No observable progress for 47s")));

    const severeLines = renderLiveWidget({ ...base, lastProgressAt: now - 192000 }, 100);
    assert.ok(severeLines.some((l) => l.includes("No observable progress for 3m 12s")));
    // Diagnostics line appears when stale
    assert.ok(severeLines.some((l) => l.includes("Diagnostics: wf_20260823_120000_a1b2 · implement")));
  });

  it("wraps or truncates safely on narrow terminal widths (40, 60, 80, 120)", () => {
    const state: WidgetState = {
      runId: "wf_20260823_120000_a1b2",
      source: "auto",
      mode: "normal",
      nodeId: "implement",
      agent: "worker",
      action: "A very long action description that could easily overflow any terminal line",
      activities: [
        {
          key: "read:Read:path/to/very/deep/nested/structure/file.ts",
          kind: "read",
          label: "Read",
          detail: "path/to/very/deep/nested/structure/file.ts",
          status: "previous",
          output: [],
        },
        {
          key: "run:Run:npm run very-long-command --arg1=val1 --arg2=val2",
          kind: "run",
          label: "Run",
          detail: "npm run very-long-command --arg1=val1 --arg2=val2",
          status: "active",
          output: ["A very long stdout log message that should truncate cleanly without error"],
        },
      ],
      nodeTokens: 142000,
      expanded: true,
    };

    for (const width of [40, 60, 80, 120]) {
      const lines = renderLiveWidget(state, width);
      for (const line of lines) {
        const visibleLen = getVisibleLength(line);
        assert.ok(
          visibleLen <= width,
          `Line exceeds width ${width} (len=${visibleLen}): "${line}"`
        );
      }
    }
  });

  it("formats stage labels and roles accurately across all workflow stages", () => {
    assert.equal(formatStageLabel("scout"), "Explore");
    assert.equal(formatStageLabel("plan"), "Plan");
    assert.equal(formatStageLabel("implement"), "Implement");
    assert.equal(formatStageLabel("spec"), "Load specification");
    assert.equal(formatStageLabel("review-1"), "Review round 1");
    assert.equal(formatStageLabel("review-2-a"), "Correctness review · round 2");
    assert.equal(formatStageLabel("review-2-b"), "Quality review · round 2");
    assert.equal(formatStageLabel("review-2-final"), "Final review · round 2");
    assert.equal(formatStageLabel("fix-1"), "Fix round 1");
    assert.equal(formatStageLabel("ticketizer"), "Plan tickets");
    assert.equal(formatStageLabel("unknown-stage"), "Unknown Stage");

    assert.equal(formatAgentRole("scout"), "scout");
    assert.equal(formatAgentRole("planner"), "planner");
    assert.equal(formatAgentRole("worker"), "worker");
    assert.equal(formatAgentRole("reviewer"), "reviewer");
    assert.equal(formatAgentRole("fixer"), "fixer");
  });
});

describe("Activity Normalization", () => {
  it("normalizes known file, search, edit, and command tools", () => {
    const read1 = normalizeToolCall("read_file", { path: "src/index.ts" });
    assert.deepEqual(read1, { kind: "read", label: "Read", detail: "src/index.ts" });

    const search1 = normalizeToolCall("grep_search", { Query: "foo", SearchPath: "src" });
    assert.deepEqual(search1, { kind: "search", label: "Search", detail: "foo" });

    const edit1 = normalizeToolCall("replace_file_content", { TargetFile: "src/foo.ts" });
    assert.deepEqual(edit1, { kind: "edit", label: "Edit", detail: "src/foo.ts" });

    const run1 = normalizeToolCall("run_command", { CommandLine: "NODE_ENV=test npm test" });
    assert.deepEqual(run1, { kind: "run", label: "Run", detail: "npm test" });
  });

  it("hides raw arguments for unknown tools and sensitive payloads", () => {
    const unknown1 = normalizeToolCall("custom_db_tool", { sql: "SELECT * FROM users" });
    assert.deepEqual(unknown1, { kind: "other", label: "custom_db_tool", detail: undefined });

    const sensitiveEdit = normalizeToolCall("edit_file", {
      path: "secret.env",
      password: "supersecretpassword",
      token: "secrettoken",
    });
    assert.equal(sensitiveEdit?.kind, "edit");
    assert.equal(sensitiveEdit?.detail, "secret.env");
    assert.equal(JSON.stringify(sensitiveEdit).includes("supersecretpassword"), false);
  });

  it("normalizes output lines, strips ANSI, and caps to newest 2 lines", () => {
    const raw = "\x1b[32mPASS\x1b[0m test/foo.test.ts\n\n\x1b[33mWARN\x1b[0m 1 deprecation\nFinal line";
    const out = normalizeOutputLines(undefined, raw);
    assert.deepEqual(out, ["WARN 1 deprecation", "Final line"]);
  });

  it("maintains bounded rolling activity tape with deduplication", () => {
    let tape = updateActivityTape([], { tool: "read_file", args: "src/a.ts" });
    assert.equal(tape.length, 1);
    assert.equal(tape[0].status, "active");

    tape = updateActivityTape(
      tape,
      { tool: "edit_file", args: "src/a.ts" },
      [{ tool: "read_file", args: "src/a.ts" }]
    );
    assert.equal(tape.length, 2);
    assert.equal(tape[0].status, "previous");
    assert.equal(tape[1].status, "active");

    // Add run tool
    tape = updateActivityTape(
      tape,
      { tool: "run_command", args: "npm test" },
      [
        { tool: "read_file", args: "src/a.ts" },
        { tool: "edit_file", args: "src/a.ts" },
      ],
      ["All tests passed"]
    );
    assert.equal(tape.length, 3);
    assert.equal(tape[0].status, "previous");
    assert.equal(tape[1].status, "previous");
    assert.equal(tape[2].status, "active");
    assert.deepEqual(tape[2].output, ["All tests passed"]);

    // Add fourth tool - should bound to 2 previous + 1 active
    tape = updateActivityTape(
      tape,
      { tool: "read_file", args: "src/b.ts" },
      [
        { tool: "read_file", args: "src/a.ts" },
        { tool: "edit_file", args: "src/a.ts" },
        { tool: "run_command", args: "npm test" },
      ]
    );
    assert.equal(tape.length, 3);
    assert.equal(tape[0].kind, "edit");
    assert.equal(tape[1].kind, "run");
    assert.equal(tape[2].kind, "read");
  });
});

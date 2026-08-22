import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  renderLiveWidget,
  formatTokens,
  formatDuration,
  type WidgetState,
} from "../src/commands/widget-renderer.ts";

describe("Pure Widget Renderer (Ticket 01)", () => {
  it("formats tokens and duration accurately", () => {
    assert.equal(formatTokens(0), "0 tok");
    assert.equal(formatTokens(450), "450 tok");
    assert.equal(formatTokens(18400), "18.4k tok");
    assert.equal(formatTokens(142050), "142.1k tok");

    assert.equal(formatDuration(0), "0.0s");
    assert.equal(formatDuration(3200), "3.2s");
    assert.equal(formatDuration(12400), "12.4s");
  });

  it("renders collapsed widget state with in-flight tool and stdout preview", () => {
    const state: WidgetState = {
      runId: "wf_20260821_120000_a1b2",
      mode: "normal",
      node: "worker",
      agent: "worker",
      action: "Executing code implementation and tests...",
      tool: { name: "edit_file", args: "src/engine/transitions.ts (+24 -4)" },
      stdout: "Applied patch · Running npm test: 7/7 tests passed",
      tokens: 142000,
      expanded: false,
      spinnerFrame: 2,
      durationMs: 8400,
    };

    const lines = renderLiveWidget(state, 100);
    assert.ok(lines.length >= 4, `Expected at least 4 lines, got ${lines.length}`);
    assert.match(lines[0], /⠹ \[pi-workflow\] auto \(normal\)/);
    assert.match(lines[0], /node: worker · 8\.4s · 142\.0k tok/);
    assert.match(lines[1], /├─ ⠹ worker \(Executing code implementation/);
    assert.match(lines[2], /│  ⎿ tool: edit_file \(src\/engine\/transitions\.ts/);
    assert.match(lines[3], /│  ⎿ Applied patch · Running npm test/);
    assert.match(lines[lines.length - 1], /└─ 按 Ctrl\+O 展开实时工具输出/);
  });

  it("renders expanded widget state with verbose diagnostics", () => {
    const state: WidgetState = {
      runId: "wf_20260821_120000_a1b2",
      mode: "strict",
      node: "review-1",
      agent: "reviewer",
      action: "Independent review in progress...",
      tool: { name: "read_file", args: "git diff" },
      stdout: "Analyzing diff against spec",
      tokens: 210000,
      expanded: true,
      spinnerFrame: 0,
      durationMs: 3900,
    };

    const lines = renderLiveWidget(state, 100);
    assert.ok(lines.some((l) => l.includes("context: fresh")));
    assert.match(lines[lines.length - 1], /└─ 按 Ctrl\+O 折叠详情/);
  });

  it("wraps or truncates safely on narrow terminal widths without breaking", () => {
    const state: WidgetState = {
      runId: "wf_20260821_120000_a1b2",
      mode: "normal",
      node: "worker",
      agent: "worker",
      action: "Very long action description that will exceed narrow widths easily",
      tool: { name: "edit_file", args: "path/to/very/deep/file/structure/that/is/very/long/and/exceeds.ts" },
      stdout: "A very long stdout log message that should be truncated cleanly without throwing errors",
      tokens: 142000,
      expanded: false,
      spinnerFrame: 1,
    };

    const lines = renderLiveWidget(state, 40);
    for (const line of lines) {
      assert.ok(line.length <= 40, `Line exceeds width 40: "${line}" (${line.length})`);
    }
  });
});

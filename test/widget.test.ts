import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { WorkflowLiveWidget, isCtrlO, WIDGET_KEY } from "../src/commands/widget.ts";
import type { WorkflowUI } from "../src/commands/ui-port.ts";

describe("Live Widget Component & Keybindings", () => {
  it("detects Ctrl+O key character", () => {
    assert.equal(isCtrlO("\x0f"), true);
    assert.equal(isCtrlO("\u000f"), true);
    assert.equal(isCtrlO("a"), false);
    assert.equal(isCtrlO("\n"), false);
  });

  it("detects Ctrl+O in kitty protocol and modifyOtherKeys encodings", () => {
    // kitty CSI-u press: codepoint 111 ('o'), modifier 5 (ctrl)
    assert.equal(isCtrlO("\x1b[111;5u"), true);
    // kitty CSI-u with alternate keys (flag 4)
    assert.equal(isCtrlO("\x1b[111;5:1u"), true);
    // xterm modifyOtherKeys: ESC 27;5;111~
    assert.equal(isCtrlO("\x1b[27;5;111~"), true);
    // release events must not toggle (input listeners run before the TUI release filter)
    assert.equal(isCtrlO("\x1b[111;5:3u"), false);
    // other ctrl combos and plain sequences must not match
    assert.equal(isCtrlO("\x1b[105;5u"), false); // ctrl+i
    assert.equal(isCtrlO("\x1b[111u"), false); // 'o' without ctrl
    assert.equal(isCtrlO("\x1b[111;1:3u"), false); // 'o' release, no ctrl
  });

  it("handles state updates and render-key diffing", () => {
    const widget = new WorkflowLiveWidget({
      runId: "wf_test",
      source: "auto",
      mode: "normal",
      nodeId: "worker",
      agent: "worker",
      action: "Working...",
      nodeTokens: 1000,
      expanded: false,
    });

    const key1 = widget.getRenderKey();
    assert.ok(key1.includes("worker"));

    widget.update({ nodeTokens: 5000, tool: { name: "edit_file", args: "foo.ts" } });
    const key2 = widget.getRenderKey();
    assert.notEqual(key1, key2);
    assert.ok(key2.includes("foo.ts"));

    // Duplicate telemetry does not change render key
    widget.update({ nodeTokens: 5000 });
    const key3 = widget.getRenderKey();
    assert.equal(key2, key3);
  });

  it("resets activities and stale state on node transition", () => {
    const widget = new WorkflowLiveWidget({
      runId: "wf_test",
      source: "auto",
      mode: "normal",
      nodeId: "scout",
      agent: "scout",
      action: "Exploring...",
      nodeTokens: 1000,
      activities: [
        {
          key: "read:Read:src/index.ts",
          kind: "read",
          label: "Read",
          detail: "src/index.ts",
          status: "previous",
          output: [],
        },
      ],
      toolCount: 5,
      expanded: false,
    });

    assert.equal(widget.state.activities?.length, 1);
    assert.equal(widget.state.toolCount, 5);

    // Transition to plan node
    widget.update({
      nodeId: "plan",
      agent: "planner",
      action: "Planning...",
    });

    assert.equal(widget.state.nodeId, "plan");
    assert.equal(widget.state.activities?.length, 0);
    assert.equal(widget.state.toolCount, 0);
    assert.equal(widget.state.nodeTokens, 0);
  });

  it("toggles expanded state on Ctrl+O input and consumes key event", () => {
    const widget = new WorkflowLiveWidget({
      runId: "wf_test",
      source: "auto",
      mode: "normal",
      nodeId: "worker",
      agent: "worker",
      action: "Working...",
      nodeTokens: 1000,
      expanded: false,
    });

    assert.equal(widget.state.expanded, false);

    const res1 = widget.handleTerminalInput("\x0f");
    assert.deepEqual(res1, { consume: true });
    assert.equal(widget.state.expanded, true);

    const res2 = widget.handleTerminalInput("\x0f");
    assert.deepEqual(res2, { consume: true });
    assert.equal(widget.state.expanded, false);

    const res3 = widget.handleTerminalInput("x");
    assert.equal(res3, undefined);
  });

  it("attaches to WorkflowUI port and cleanly disposes timer and widget", () => {
    let mountedKey = "";
    let mountedPlacement = "";
    let unsubscribedInput = false;

    const fakeUI: WorkflowUI = {
      hasUI: () => true,
      isRPC: () => false,
      notify: () => {},
      setWorking: () => {},
      setWidget: (key, content, opts) => {
        mountedKey = key;
        mountedPlacement = opts?.placement ?? "";
      },
      onTerminalInput: () => {
        return () => {
          unsubscribedInput = true;
        };
      },
    };

    const widget = new WorkflowLiveWidget({
      runId: "wf_test",
      source: "auto",
      mode: "normal",
      nodeId: "worker",
      agent: "worker",
      action: "Working...",
      nodeTokens: 1000,
      expanded: false,
    });

    widget.attach(fakeUI);
    assert.equal(mountedKey, WIDGET_KEY);
    assert.equal(mountedPlacement, "aboveEditor");

    widget.dispose(fakeUI);
    assert.equal(unsubscribedInput, true);
  });
});

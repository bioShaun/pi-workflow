import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { WorkflowLiveWidget, isCtrlO, WIDGET_KEY } from "../src/commands/widget.ts";
import type { WorkflowUI } from "../src/commands/ui-port.ts";

describe("Live Widget Component & Keybindings (Ticket 03)", () => {
  it("detects Ctrl+O key character", () => {
    assert.equal(isCtrlO("\x0f"), true);
    assert.equal(isCtrlO("\u000f"), true);
    assert.equal(isCtrlO("a"), false);
    assert.equal(isCtrlO("\n"), false);
  });

  it("handles state updates and render-key diffing", () => {
    const widget = new WorkflowLiveWidget({
      runId: "wf_test",
      mode: "normal",
      node: "worker",
      agent: "worker",
      action: "Working...",
      tokens: 1000,
      expanded: false,
    });

    const key1 = widget.getRenderKey();
    assert.ok(key1.includes("worker"));

    widget.update({ tokens: 5000, tool: { name: "edit_file", args: "foo.ts" } });
    const key2 = widget.getRenderKey();
    assert.notEqual(key1, key2);
    assert.ok(key2.includes("edit_file"));
  });

  it("toggles expanded state on Ctrl+O input and consumes key event", () => {
    const widget = new WorkflowLiveWidget({
      runId: "wf_test",
      mode: "normal",
      node: "worker",
      agent: "worker",
      action: "Working...",
      tokens: 1000,
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
      mode: "normal",
      node: "worker",
      agent: "worker",
      action: "Working...",
      tokens: 1000,
      expanded: false,
    });

    widget.attach(fakeUI);
    assert.equal(mountedKey, WIDGET_KEY);
    assert.equal(mountedPlacement, "aboveEditor");

    widget.dispose(fakeUI);
    assert.equal(unsubscribedInput, true);
  });
});

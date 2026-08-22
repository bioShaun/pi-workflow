import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  createWorkflowUI,
  isStaleExtensionContextError,
} from "../src/commands/ui-port.ts";

describe("WorkflowUI Port (Ticket 02)", () => {
  it("detects stale extension context errors", () => {
    assert.equal(isStaleExtensionContextError(new Error("context is no longer active")), true);
    assert.equal(isStaleExtensionContextError(new Error("session has ended")), true);
    assert.equal(isStaleExtensionContextError(new Error("component is disposed")), true);
    assert.equal(isStaleExtensionContextError(new Error("network error")), false);
    assert.equal(isStaleExtensionContextError(null), false);
  });

  it("delegates calls to underlying ctx.ui when UI is present", () => {
    let notifiedMessage = "";
    let notifiedType = "";
    let workingMessage: string | undefined = "";
    let widgetKey = "";
    let widgetContent: unknown = null;
    let widgetPlacement: string | undefined = "";

    const fakeCtx: any = {
      hasUI: true,
      cwd: "/test",
      ui: {
        notify: (msg: string, type: string) => {
          notifiedMessage = msg;
          notifiedType = type;
        },
        setWorkingMessage: (msg?: string) => {
          workingMessage = msg;
        },
        setWidget: (key: string, content: unknown, options?: any) => {
          widgetKey = key;
          widgetContent = content;
          widgetPlacement = options?.placement;
        },
        onTerminalInput: (handler: any) => {
          return () => {};
        },
      },
    };

    const ui = createWorkflowUI(fakeCtx);
    assert.equal(ui.hasUI(), true);
    assert.equal(ui.isRPC(), false);

    ui.notify("Workflow completed", "info");
    assert.equal(notifiedMessage, "Workflow completed");
    assert.equal(notifiedType, "info");

    ui.setWorking("Planning...");
    assert.equal(workingMessage, "Planning...");

    ui.setWidget("pi-workflow-live", ["line 1", "line 2"]);
    assert.equal(widgetKey, "pi-workflow-live");
    assert.deepEqual(widgetContent, ["line 1", "line 2"]);
    assert.equal(widgetPlacement, "aboveEditor");
  });

  it("safely ignores calls and guards against throws when hasUI is false", () => {
    const fakeCtx: any = {
      hasUI: false,
      cwd: "/test",
    };

    const ui = createWorkflowUI(fakeCtx);
    assert.equal(ui.hasUI(), false);

    // None of these should throw
    ui.notify("message");
    ui.setWorking("working");
    ui.setWidget("key", undefined);
    assert.doesNotThrow(() => {
      ui.onTerminalInput?.(() => undefined);
    });
  });

  it("suppresses stale context errors gracefully without crashing the workflow", () => {
    const fakeCtx: any = {
      hasUI: true,
      ui: {
        notify: () => {
          throw new Error("context is no longer active");
        },
        setWidget: () => {
          throw new Error("session has ended");
        },
      },
    };

    const ui = createWorkflowUI(fakeCtx);
    assert.doesNotThrow(() => {
      ui.notify("test");
      ui.setWidget("key", undefined);
    });
  });
});

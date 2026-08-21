import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorkflowEngine } from "../src/engine/engine.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";
import { WorkflowError } from "../src/engine/errors.ts";

describe("Single Active Workflow Locking", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wf-lock-test-"));
  });

  it("prevents starting a second workflow when one is currently active", async () => {
    const fakeExecutor = new FakeAgentExecutor();
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      executor: fakeExecutor,
    });

    const run1 = await engine.startPlan("Task 1", { mode: "normal" });
    assert.equal(run1.state, "plan_ready");

    // Attempt to start a second workflow
    await assert.rejects(
      async () => await engine.startPlan("Task 2", { mode: "normal" }),
      (err: any) =>
        err instanceof WorkflowError &&
        err.code === "invalid_transition" &&
        err.message.includes(`An active workflow already exists: ${run1.id}`)
    );
  });

  it("releases active lock when workflow completes", async () => {
    const fakeExecutor = new FakeAgentExecutor();
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      executor: fakeExecutor,
    });

    const run1 = await engine.startAuto("Task 1", { mode: "normal" });
    assert.equal(run1.state, "completed");

    const active = await engine.getActiveRun();
    assert.equal(active, null);

    // Now a new workflow can start cleanly
    const run2 = await engine.startPlan("Task 2", { mode: "normal" });
    assert.equal(run2.state, "plan_ready");
  });
});

import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorkflowEngine } from "../src/engine/engine.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";
import { loadWorkflowRun, saveWorkflowRun } from "../src/storage/store.ts";
import { WorkflowCorruptError } from "../src/engine/errors.ts";

describe("Recovery, Persistence, and Resilience", () => {
  let tmpDir: string;
  let baseDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wf-recovery-test-"));
    baseDir = path.join(tmpDir, ".pi", "workflow");
  });

  it("resumes interrupted workflow after implementation without re-running implementation", async () => {
    const fakeExecutor1 = new FakeAgentExecutor();
    const engine1 = new WorkflowEngine({
      cwd: tmpDir,
      executor: fakeExecutor1,
    });

    // 1. Plan
    const planRun = await engine1.startPlan("Add caching layer", { mode: "normal" });
    assert.equal(planRun.state, "plan_ready");

    // 2. Implement
    const implRun = await engine1.startImplement(planRun.id);
    assert.equal(implRun.state, "testing");

    // Simulate Pi restart: create fresh Engine instance with a new executor
    const fakeExecutor2 = new FakeAgentExecutor();
    const engine2 = new WorkflowEngine({
      cwd: tmpDir,
      executor: fakeExecutor2,
    });

    // Resume workflow
    const resumedRun = await engine2.resume(planRun.id);
    assert.equal(resumedRun.state, "completed");

    // Verify that the new engine ran review directly and did NOT re-run implementation
    const newWorkerCalls = fakeExecutor2.requests.filter((r) => r.nodeId === "implement");
    assert.equal(newWorkerCalls.length, 0);

    const reviewCalls = fakeExecutor2.requests.filter((r) => r.nodeId.startsWith("review"));
    assert.equal(reviewCalls.length, 1);
  });

  it("aborts active workflow safely and records abort state", async () => {
    const fakeExecutor = new FakeAgentExecutor();
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      executor: fakeExecutor,
    });

    const run = await engine.startPlan("Task to abort", { mode: "normal" });
    assert.equal(run.state, "plan_ready");

    const abortedRun = await engine.abort(run.id);
    assert.equal(abortedRun.state, "aborted");
    assert.equal(abortedRun.error?.code, "workflow_aborted");

    // Verify active pointer is cleared
    const active = await engine.getActiveRun();
    assert.equal(active, null);
  });

  it("fails safely with state_corrupt when state.json is corrupted", async () => {
    const runId = "wf_corrupt_test";
    const runDir = path.join(baseDir, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });

    const statePath = path.join(runDir, "state.json");
    await fs.writeFile(statePath, "{ broken json ...", "utf-8");

    await assert.rejects(
      async () => await loadWorkflowRun(baseDir, runId),
      (err: any) => err instanceof WorkflowCorruptError && err.code === "state_corrupt"
    );
  });

  it("fails safely when state.json has invalid schema", async () => {
    const runId = "wf_invalid_schema";
    const runDir = path.join(baseDir, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });

    const statePath = path.join(runDir, "state.json");
    await fs.writeFile(
      statePath,
      JSON.stringify({ version: 2, id: runId }), // invalid version
      "utf-8"
    );

    await assert.rejects(
      async () => await loadWorkflowRun(baseDir, runId),
      (err: any) => err instanceof WorkflowCorruptError && /Invalid workflow version/.test(err.message)
    );
  });
});

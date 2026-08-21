import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StateMachine } from "../src/engine/state-machine.ts";
import { canTransition, transitionState } from "../src/engine/transitions.ts";
import { InvalidTransitionError } from "../src/engine/errors.ts";
import type { WorkflowRun, WorkflowState } from "../src/contracts/workflow.ts";
import { loadWorkflowRun } from "../src/storage/store.ts";

describe("State Transitions and State Machine", () => {
  let tmpDir: string;
  let baseDir: string;
  let sampleRun: WorkflowRun;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wf-test-"));
    baseDir = path.join(tmpDir, ".pi", "workflow");
    sampleRun = {
      version: 1,
      id: "wf_test_123",
      cwd: tmpDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: "created",
      mode: "normal",
      request: "Test task",
      reviewRound: 1,
      maxReviewRounds: 3,
      reviews: [],
      fixes: [],
      baseline: { dirty: false, status: [], startedAt: new Date().toISOString() },
    };
  });

  it("allows valid transitions", () => {
    assert.equal(canTransition("created", "scouting"), true);
    assert.equal(canTransition("created", "planning"), true);
    assert.equal(canTransition("planning", "plan_ready"), true);
    assert.equal(canTransition("plan_ready", "implementing"), true);
    assert.equal(canTransition("implementing", "testing"), true);
    assert.equal(canTransition("testing", "reviewing"), true);
    assert.equal(canTransition("testing", "fixing"), true);
    assert.equal(canTransition("reviewing", "completed"), true);
    assert.equal(canTransition("reviewing", "fixing"), true);
    assert.equal(canTransition("fixing", "testing"), true);
    assert.equal(canTransition("fixing", "reviewing"), true);
  });

  it("rejects invalid transitions", () => {
    assert.equal(canTransition("created", "completed"), false);
    assert.equal(canTransition("planning", "completed"), false);
    assert.equal(canTransition("completed", "planning"), false);
    assert.equal(canTransition("failed", "implementing"), false);
    assert.equal(canTransition("aborted", "reviewing"), false);

    assert.throws(
      () => transitionState(sampleRun, "completed"),
      (err: any) => err instanceof InvalidTransitionError
    );
  });

  it("state machine persists state changes and logs events atomically", async () => {
    const sm = new StateMachine(baseDir);
    const updated = await sm.transition(sampleRun, "planning", {
      node: "plan",
      reason: "Started planning",
    });

    assert.equal(updated.state, "planning");
    assert.equal(updated.currentNode, "plan");

    // Check persisted state file
    const loaded = await loadWorkflowRun(baseDir, sampleRun.id);
    assert.equal(loaded.state, "planning");
    assert.equal(loaded.currentNode, "plan");

    // Check events log file
    const eventsPath = path.join(baseDir, "runs", sampleRun.id, "events.jsonl");
    const eventsContent = await fs.readFile(eventsPath, "utf-8");
    assert.match(eventsContent, /"event":"state.changed"/);
    assert.match(eventsContent, /"from":"created"/);
    assert.match(eventsContent, /"to":"planning"/);
  });
});

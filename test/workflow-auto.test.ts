import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorkflowEngine } from "../src/engine/engine.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";
import type { ReviewResult } from "../src/contracts/review.ts";

describe("Automated Workflow (/work auto)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wf-auto-test-"));
  });

  it("completes full workflow on first pass", async () => {
    const fakeExecutor = new FakeAgentExecutor();
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      executor: fakeExecutor,
    });

    const run = await engine.startAuto("Implement ping endpoint", { mode: "normal" });

    assert.equal(run.state, "completed");
    assert.equal(run.reviewRound, 1);
    assert.ok(run.plan);
    assert.ok(run.implementation);
    assert.equal(run.reviews.length, 1);
    assert.equal(run.reviews[0].verdict, "PASS");

    // Verify persisted final artifact
    const finalPath = path.join(tmpDir, ".pi", "workflow", "runs", run.id, "final.json");
    const finalContent = await fs.readFile(finalPath, "utf-8");
    assert.match(finalContent, /"status": "completed"/);
  });

  it("handles fix loop and completes when reviewer passes in round 2", async () => {
    const fakeExecutor = new FakeAgentExecutor({
      review: [
        {
          verdict: "REQUEST_CHANGES",
          summary: "Missing validation check",
          findings: [
            {
              id: "finding-1",
              severity: "major",
              category: "correctness",
              description: "Missing null check on input",
              evidence: "line 15",
            },
          ],
          testAssessment: { sufficient: true, explanation: "" },
          confidence: 0.9,
        },
        {
          verdict: "PASS",
          summary: "Null check fixed and tested",
          findings: [],
          testAssessment: { sufficient: true, explanation: "" },
          confidence: 0.95,
        },
      ],
    });

    const engine = new WorkflowEngine({
      cwd: tmpDir,
      executor: fakeExecutor,
    });

    const run = await engine.startAuto("Add user validation", { mode: "normal" });

    assert.equal(run.state, "completed");
    assert.equal(run.reviewRound, 2);
    assert.equal(run.reviews.length, 2);
    assert.equal(run.fixes.length, 1);
    assert.equal(run.fixes[0].addressedFindings.includes("finding-1"), true);
  });

  it("fails when review budget is exhausted (3 rounds of REQUEST_CHANGES)", async () => {
    const rejectedReview: ReviewResult = {
      verdict: "REQUEST_CHANGES",
      summary: "Defect persists",
      findings: [
        {
          id: "persistent-bug",
          severity: "blocker",
          category: "correctness",
          description: "Persistent blocker",
          evidence: "src/main.ts",
        },
      ],
      testAssessment: { sufficient: false, explanation: "Broken" },
      confidence: 0.9,
    };

    const fakeExecutor = new FakeAgentExecutor({
      review: [rejectedReview, rejectedReview, rejectedReview],
    });

    const engine = new WorkflowEngine({
      cwd: tmpDir,
      executor: fakeExecutor,
      config: { maxReviewRounds: 3 },
    });

    const run = await engine.startAuto("Complex refactor", { mode: "normal" });

    assert.equal(run.state, "failed");
    assert.ok(run.error);
    assert.equal(run.error?.code, "review_budget_exhausted");
  });

  it("supports strict mode with dual reviewers plus a final fresh reviewer", async () => {
    const fakeExecutor = new FakeAgentExecutor();
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      executor: fakeExecutor,
    });

    const run = await engine.startAuto("Core architectural overhaul", { mode: "strict" });

    assert.equal(run.state, "completed");
    assert.equal(run.mode, "strict");

    // Audit Finding 5 (§24/§35): Reviewer A, Reviewer B, then one final
    // fresh reviewer that independently verifies the end state.
    const reviewerRequests = fakeExecutor.requests.filter((r) => r.nodeId.startsWith("review"));
    assert.deepEqual(
      reviewerRequests.map((r) => r.nodeId),
      ["review-1-a", "review-1-b", "review-1-final"]
    );

    for (const req of reviewerRequests) {
      assert.equal(req.context, "fresh");
    }
  });

  it("runs the final reviewer after a fix loop in strict mode", async () => {
    const fakeExecutor = new FakeAgentExecutor({
      review: [
        {
          verdict: "REQUEST_CHANGES",
          summary: "Correctness issue in round 1",
          findings: [
            {
              id: "f1",
              severity: "major",
              category: "correctness",
              description: "Off-by-one in loop",
              evidence: "line 10",
            },
          ],
          testAssessment: { sufficient: true, explanation: "" },
          confidence: 0.9,
        },
        {
          verdict: "PASS",
          summary: "Round 1 Reviewer B passes",
          findings: [],
          testAssessment: { sufficient: true, explanation: "" },
          confidence: 0.95,
        },
      ],
    });
    // Round 1: Reviewer A rejects (index 0), Reviewer B passes (index 1),
    // no final reviewer (rejection present). After the fix, round 2 runs
    // A + B + final, all defaulting to PASS.
    const engine = new WorkflowEngine({
      cwd: tmpDir,
      executor: fakeExecutor,
    });

    const run = await engine.startAuto("Architectural change", { mode: "strict" });

    assert.equal(run.state, "completed");
    assert.equal(run.reviewRound, 2);
    const nodeIds = fakeExecutor.requests
      .filter((r) => r.nodeId.startsWith("review"))
      .map((r) => r.nodeId);
    assert.deepEqual(nodeIds, ["review-1-a", "review-1-b", "review-2-a", "review-2-b", "review-2-final"]);
  });
});

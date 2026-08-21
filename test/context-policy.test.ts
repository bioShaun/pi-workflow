import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorkflowEngine } from "../src/engine/engine.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";
import { assertReviewerFreshness, getDefaultContextForRole } from "../src/policies/context.ts";
import { WorkflowInvariantError } from "../src/engine/errors.ts";
import { createReviewerExecutionRequest } from "../src/agents/executor.ts";

describe("Reviewer Freshness & Context Policy Invariants", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wf-ctx-test-"));
  });

  it("default context for roles matches specification", () => {
    assert.equal(getDefaultContextForRole("scout"), "fresh");
    assert.equal(getDefaultContextForRole("planner"), "fork");
    assert.equal(getDefaultContextForRole("worker"), "fresh");
    assert.equal(getDefaultContextForRole("reviewer"), "fresh");
    assert.equal(getDefaultContextForRole("fixer"), "fresh");
  });

  it("throws WorkflowInvariantError if reviewer context is not fresh", () => {
    assert.throws(
      () => assertReviewerFreshness({ role: "reviewer", context: "fork" as any }),
      (err: any) => err instanceof WorkflowInvariantError && /fresh context/.test(err.message)
    );
  });

  it("createReviewerExecutionRequest enforces fresh context", () => {
    const req = createReviewerExecutionRequest({
      workflowRunId: "wf_test",
      nodeId: "review-1",
      agent: "reviewer",
      task: "Review code",
      cwd: "/tmp",
      schema: {},
    });

    assert.equal(req.context, "fresh");
  });

  it("every reviewer execution request in a multi-round workflow uses fresh context", async () => {
    const fakeExecutor = new FakeAgentExecutor({
      review: [
        {
          verdict: "REQUEST_CHANGES",
          summary: "Round 1 finding",
          findings: [
            {
              id: "f1",
              severity: "minor",
              category: "correctness",
              description: "Typo in comment",
              evidence: "",
            },
          ],
          testAssessment: { sufficient: true, explanation: "" },
          confidence: 0.9,
        },
        {
          verdict: "PASS",
          summary: "Round 2 pass",
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

    const run = await engine.startAuto("Implement auth feature", { mode: "normal" });
    assert.equal(run.state, "completed");
    assert.equal(run.reviewRound, 2);

    // Verify all requests received by the executor
    const reviewRequests = fakeExecutor.requests.filter((r) => r.nodeId.startsWith("review"));
    assert.equal(reviewRequests.length, 2);

    for (const req of reviewRequests) {
      assert.equal(req.context, "fresh", `Review request for ${req.nodeId} must have context='fresh'`);
    }

    // Verify distinct nodeIds and distinct attempt identities
    assert.equal(reviewRequests[0].nodeId, "review-1");
    assert.equal(reviewRequests[1].nodeId, "review-2");
  });
});

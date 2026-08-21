import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { evaluatePlanGate } from "../src/gates/plan-gate.ts";
import { evaluateTestGate } from "../src/gates/test-gate.ts";
import { evaluateReviewGate } from "../src/gates/review-gate.ts";
import { evaluateCompletionGate } from "../src/gates/completion-gate.ts";
import type { PlanResult } from "../src/contracts/plan.ts";
import type { ReviewResult } from "../src/contracts/review.ts";
import type { WorkflowRun } from "../src/contracts/workflow.ts";

describe("Quality Gates", () => {
  describe("Plan Gate", () => {
    it("passes valid plan", () => {
      const validPlan: PlanResult = {
        summary: "Clear summary",
        understanding: "Good understanding",
        files: [{ path: "src/a.ts", purpose: "Core logic", action: "modify" }],
        steps: [{ id: "step-1", description: "First step" }],
        tests: [{ description: "Unit tests", required: true }],
        risks: [{ severity: "low", description: "Low risk" }],
        assumptions: ["None"],
        complexity: "low",
        requiresSecondReviewer: false,
      };
      const result = evaluatePlanGate(validPlan);
      assert.equal(result.pass, true);
      assert.ok(result.plan);
    });

    it("rejects plan with empty steps", () => {
      const invalidPlan = {
        summary: "Summary",
        understanding: "Understanding",
        files: [],
        steps: [], // empty steps
        tests: [],
        risks: [],
        assumptions: [],
        complexity: "low",
        requiresSecondReviewer: false,
      };
      const result = evaluatePlanGate(invalidPlan);
      assert.equal(result.pass, false);
      assert.match(result.error ?? "", /steps must be a non-empty array/);
    });

    it("rejects plan with empty summary", () => {
      const invalidPlan = {
        summary: "  ", // empty
        understanding: "Understanding",
        files: [],
        steps: [{ id: "1", description: "do something" }],
        tests: [],
        risks: [],
        assumptions: [],
        complexity: "low",
        requiresSecondReviewer: false,
      };
      const result = evaluatePlanGate(invalidPlan);
      assert.equal(result.pass, false);
      assert.match(result.error ?? "", /summary must be a non-empty string/);
    });

    it("rejects plan with invalid complexity", () => {
      const invalidPlan = {
        summary: "Summary",
        understanding: "Understanding",
        files: [],
        steps: [{ id: "1", description: "do something" }],
        tests: [],
        risks: [],
        assumptions: [],
        complexity: "extreme", // invalid
        requiresSecondReviewer: false,
      };
      const result = evaluatePlanGate(invalidPlan);
      assert.equal(result.pass, false);
      assert.match(result.error ?? "", /complexity must be one of/);
    });
  });

  describe("Test Gate", () => {
    it("returns PASS when all tests passed", () => {
      const result = evaluateTestGate([
        { command: "npm test", status: "passed", summary: "5 tests passed" },
      ]);
      assert.equal(result.status, "PASS");
      assert.equal(result.failedTests.length, 0);
    });

    it("returns FIX_REQUIRED when a test failed", () => {
      const result = evaluateTestGate([
        { command: "npm test", status: "failed", summary: "1 test failed" },
        { command: "lint", status: "passed", summary: "Clean" },
      ]);
      assert.equal(result.status, "FIX_REQUIRED");
      assert.equal(result.failedTests.length, 1);
    });

    it("returns REVIEW_ALLOWED_WITH_WARNING when tests were skipped", () => {
      const result = evaluateTestGate([
        { command: "integration", status: "skipped", summary: "No docker daemon" },
        { command: "unit", status: "passed", summary: "All pass" },
      ]);
      assert.equal(result.status, "REVIEW_ALLOWED_WITH_WARNING");
    });
  });

  describe("Review Gate", () => {
    it("returns completed for PASS verdict", () => {
      const review: ReviewResult = {
        verdict: "PASS",
        summary: "Looks good",
        findings: [],
        testAssessment: { sufficient: true, explanation: "Adequate" },
        confidence: 0.9,
      };
      const gate = evaluateReviewGate(review);
      assert.equal(gate.verdict, "PASS");
      assert.equal(gate.nextState, "completed");
    });

    it("returns fixing for REQUEST_CHANGES verdict", () => {
      const review: ReviewResult = {
        verdict: "REQUEST_CHANGES",
        summary: "Bug found",
        findings: [
          {
            id: "f1",
            severity: "major",
            category: "correctness",
            description: "Off by one error",
            evidence: "line 42",
          },
        ],
        testAssessment: { sufficient: false, explanation: "Missing edge case" },
        confidence: 0.85,
      };
      const gate = evaluateReviewGate(review);
      assert.equal(gate.verdict, "REQUEST_CHANGES");
      assert.equal(gate.nextState, "fixing");
    });
  });

  describe("Completion Gate", () => {
    it("permits completion when all conditions are satisfied", () => {
      const run: WorkflowRun = {
        version: 1,
        id: "wf_1",
        cwd: "/tmp",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: "reviewing",
        mode: "normal",
        request: "Task",
        reviewRound: 1,
        maxReviewRounds: 3,
        implementation: {
          summary: "Done",
          changedFiles: [],
          tests: [{ status: "passed", summary: "Passed" }],
          unresolvedIssues: [],
          deviationsFromPlan: [],
        },
        reviews: [
          {
            verdict: "PASS",
            summary: "Good",
            findings: [],
            testAssessment: { sufficient: true, explanation: "Good" },
            confidence: 0.9,
          },
        ],
        fixes: [],
        baseline: { dirty: false, status: [], startedAt: new Date().toISOString() },
      };
      const gate = evaluateCompletionGate(run);
      assert.equal(gate.canComplete, true);
    });

    it("blocks completion if test failed", () => {
      const run: WorkflowRun = {
        version: 1,
        id: "wf_1",
        cwd: "/tmp",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: "reviewing",
        mode: "normal",
        request: "Task",
        reviewRound: 1,
        maxReviewRounds: 3,
        implementation: {
          summary: "Done",
          changedFiles: [],
          tests: [{ status: "failed", summary: "Failed" }],
          unresolvedIssues: [],
          deviationsFromPlan: [],
        },
        reviews: [
          {
            verdict: "PASS",
            summary: "Good",
            findings: [],
            testAssessment: { sufficient: true, explanation: "Good" },
            confidence: 0.9,
          },
        ],
        fixes: [],
        baseline: { dirty: false, status: [], startedAt: new Date().toISOString() },
      };
      const gate = evaluateCompletionGate(run);
      assert.equal(gate.canComplete, false);
      assert.match(gate.reasons[0], /failing tests/);
    });

    it("blocks completion in strict mode if not all reviewers passed", () => {
      const run: WorkflowRun = {
        version: 1,
        id: "wf_1",
        cwd: "/tmp",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: "reviewing",
        mode: "strict",
        request: "Task",
        reviewRound: 1,
        maxReviewRounds: 3,
        implementation: {
          summary: "Done",
          changedFiles: [],
          tests: [{ status: "passed", summary: "Passed" }],
          unresolvedIssues: [],
          deviationsFromPlan: [],
        },
        reviews: [
          {
            verdict: "PASS",
            summary: "Reviewer A passed",
            findings: [],
            testAssessment: { sufficient: true, explanation: "Good" },
            confidence: 0.9,
            round: 1,
            reviewerId: "reviewer-a",
          },
          {
            verdict: "REQUEST_CHANGES",
            summary: "Reviewer B requested changes",
            findings: [{ id: "1", severity: "minor", category: "tests", description: "test", evidence: "" }],
            testAssessment: { sufficient: false, explanation: "Needs test" },
            confidence: 0.8,
            round: 1,
            reviewerId: "reviewer-b",
          },
        ],
        fixes: [],
        baseline: { dirty: false, status: [], startedAt: new Date().toISOString() },
      };
      const gate = evaluateCompletionGate(run);
      assert.equal(gate.canComplete, false);
      assert.match(gate.reasons[0], /Not all required reviewers passed in strict mode/);
    });
  });
});

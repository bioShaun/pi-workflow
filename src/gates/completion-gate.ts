import type { PlanTest } from "../contracts/plan.ts";
import type { TestResult } from "../contracts/implementation.ts";
import { evaluateTestGate } from "./test-gate.ts";
import type { WorkflowRun } from "../contracts/workflow.ts";

export interface CompletionGateResult {
  canComplete: boolean;
  reasons: string[];
}

export function evaluateCompletionGate(run: WorkflowRun): CompletionGateResult {
  const reasons: string[] = [];

  if (run.state !== "reviewing") {
    reasons.push(`Workflow state is "${run.state}", expected "reviewing"`);
  }

  if (!run.reviews || run.reviews.length === 0) {
    reasons.push("No reviews exist for this workflow");
  } else {
    if (run.mode === "strict") {
      // In strict mode, verify that all required review verdicts for the current round passed
      const currentRound = run.reviewRound;
      const currentRoundReviews = run.reviews.filter((r) => (r.round ?? 1) === currentRound);
      if (currentRoundReviews.length === 0) {
        reasons.push(`No reviews found for current round ${currentRound}`);
      } else {
        const hasRejections = currentRoundReviews.some((r) => r.verdict !== "PASS");
        if (hasRejections) {
          reasons.push("Not all required reviewers passed in strict mode");
        }
      }
    } else {
      const latestReview = run.reviews[run.reviews.length - 1];
      if (latestReview.verdict !== "PASS") {
        reasons.push(`Latest review verdict is "${latestReview.verdict}", expected "PASS"`);
      }
    }
  }

  const latestTests: TestResult[] =
    run.fixes.length > 0
      ? run.fixes[run.fixes.length - 1].tests
      : run.implementation?.tests ?? [];

  let verificationTests = latestTests;
  let requiredTests: PlanTest[] = run.plan?.tests ?? [];
  if (run.source === "spec" && run.specPolicy) {
    if (!run.verification) {
      reasons.push("No engine verification aggregate exists for this spec workflow");
    } else {
      verificationTests = run.verification.commands.map((command) => ({
        command: command.command,
        status: command.status,
        summary: `${command.command} exited with status ${command.exitCode}`,
        exitCode: command.exitCode,
      }));
      requiredTests = (run.specPolicy?.verification ?? []).map((requirement) => ({
        command: requirement.command,
        description: requirement.command,
        required: requirement.required,
      }));
      if (
        run.verification.status !== "passed"
        || run.verification.total === 0
        || run.verification.passed !== run.verification.total
      ) {
        reasons.push("Latest engine verification aggregate did not pass");
      }
    }
  }

  if (run.source === "spec" && run.specPolicy?.allowedChanges) {
    if (!run.scopeGate || run.scopeGate.status !== "passed") {
      reasons.push("Latest repository scope gate did not pass");
    }
  }

  const testGate = evaluateTestGate(verificationTests, requiredTests);
  if (testGate.status === "FIX_REQUIRED") {
    reasons.push(`There are failing tests in the latest test run: ${testGate.reason}`);
  }

  return {
    canComplete: reasons.length === 0,
    reasons,
  };
}

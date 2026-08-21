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

  // Check tests
  const latestTests =
    run.fixes.length > 0
      ? run.fixes[run.fixes.length - 1].tests
      : run.implementation?.tests ?? [];

  const hasFailedTests = latestTests.some((t) => t.status === "failed");
  if (hasFailedTests) {
    reasons.push("There are failing tests in the latest test run");
  }

  return {
    canComplete: reasons.length === 0,
    reasons,
  };
}

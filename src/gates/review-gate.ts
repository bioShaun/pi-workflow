import type { ReviewResult, ReviewVerdict } from "../contracts/review.ts";
import type { WorkflowState } from "../contracts/workflow.ts";

export interface ReviewGateResult {
  verdict: ReviewVerdict;
  nextState: "completed" | "fixing";
  reason: string;
}

export function evaluateReviewGate(review: ReviewResult): ReviewGateResult {
  if (review.verdict === "PASS") {
    return {
      verdict: "PASS",
      nextState: "completed",
      reason: "Reviewer passed the changes",
    };
  }

  return {
    verdict: "REQUEST_CHANGES",
    nextState: "fixing",
    reason: `Reviewer requested changes with ${review.findings.length} finding(s)`,
  };
}

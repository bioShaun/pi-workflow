import type { TestResult } from "../contracts/implementation.ts";
import type { PlanTest } from "../contracts/plan.ts";

export type TestGateStatus =
  | "PASS"
  | "REVIEW_ALLOWED_WITH_WARNING"
  | "FIX_REQUIRED";

export interface TestGateResult {
  status: TestGateStatus;
  reason: string;
  failedTests: TestResult[];
  skippedTests: TestResult[];
  passedTests: TestResult[];
}

export function evaluateTestGate(
  testResults: TestResult[],
  planTests?: PlanTest[]
): TestGateResult {
  const failedTests = testResults.filter((t) => t.status === "failed");
  const skippedTests = testResults.filter((t) => t.status === "skipped");
  const passedTests = testResults.filter((t) => t.status === "passed");

  // If there are plan tests marked as required, check if any failed
  if (failedTests.length > 0) {
    return {
      status: "FIX_REQUIRED",
      reason: `${failedTests.length} test(s) failed: ${failedTests.map((t) => t.summary).join("; ")}`,
      failedTests,
      skippedTests,
      passedTests,
    };
  }

  // Check for required tests that might have been skipped
  if (skippedTests.length > 0) {
    return {
      status: "REVIEW_ALLOWED_WITH_WARNING",
      reason: `${skippedTests.length} test(s) were skipped: ${skippedTests.map((t) => t.summary).join("; ")}`,
      failedTests,
      skippedTests,
      passedTests,
    };
  }

  return {
    status: "PASS",
    reason: `All ${passedTests.length} test(s) passed successfully`,
    failedTests,
    skippedTests,
    passedTests,
  };
}

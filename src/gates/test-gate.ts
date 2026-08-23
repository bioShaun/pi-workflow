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
  planTests: PlanTest[] = []
): TestGateResult {
  const failedTests = testResults.filter((test) => test.status === "failed");
  const skippedTests = testResults.filter((test) => test.status === "skipped");
  const passedTests = testResults.filter((test) => test.status === "passed");

  if (failedTests.length > 0) {
    return {
      status: "FIX_REQUIRED",
      reason: `${failedTests.length} test(s) failed: ${failedTests.map((test) => test.summary).join("; ")}`,
      failedTests,
      skippedTests,
      passedTests,
    };
  }

  const missingRequired: string[] = [];
  for (const planned of planTests.filter((test) => test.required)) {
    const requiredCommand = planned.command?.trim();
    if (requiredCommand) {
      const matching = testResults.filter((result) => result.command?.trim() === requiredCommand);
      if (!matching.some((result) => result.status === "passed")) {
        const reported = matching[matching.length - 1];
        missingRequired.push(
          reported?.status === "skipped"
            ? `required verification skipped: ${requiredCommand}`
            : `required verification not reported: ${requiredCommand}`
        );
      }
    } else if (passedTests.length === 0) {
      missingRequired.push(`required verification not reported: ${planned.description}`);
    }
  }

  if (missingRequired.length > 0) {
    return {
      status: "FIX_REQUIRED",
      reason: missingRequired.join("; "),
      failedTests,
      skippedTests,
      passedTests,
    };
  }

  if (skippedTests.length > 0) {
    return {
      status: "REVIEW_ALLOWED_WITH_WARNING",
      reason: `${skippedTests.length} optional test(s) were skipped: ${skippedTests.map((test) => test.summary).join("; ")}`,
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

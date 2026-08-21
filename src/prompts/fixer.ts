import type { PlanResult } from "../contracts/plan.ts";
import type { ReviewFinding } from "../contracts/review.ts";
import type { TestResult } from "../contracts/implementation.ts";
import { AUTONOMOUS_EXECUTION_RULE } from "./common.ts";

export interface BuildFixerPromptInput {
  task: string;
  plan: PlanResult;
  findings: ReviewFinding[];
  failedTests?: TestResult[];
  round: number;
}

export function buildFixerPrompt(input: BuildFixerPromptInput): string {
  const sections: string[] = [
    "You are a fix worker responsible for addressing review findings and test failures.",
    "",
    "## Original Requirement",
    input.task.trim(),
    "",
    "## Approved Plan Summary",
    input.plan.summary,
    "",
    "## Review Findings to Fix (Round " + input.round + ")",
    ...input.findings.map(
      (f, idx) =>
        `${idx + 1}. [${f.severity.toUpperCase()}] ID: ${f.id} (${f.category})\n` +
        `   Description: ${f.description}\n` +
        `   Evidence: ${f.evidence}\n` +
        (f.file ? `   File: ${f.file}${f.line ? `:${f.line}` : ""}\n` : "") +
        (f.recommendedFix ? `   Recommended Fix: ${f.recommendedFix}\n` : "")
    ),
  ];

  if (input.failedTests && input.failedTests.length > 0) {
    sections.push(
      "",
      "## Failing Tests to Fix",
      ...input.failedTests.map(
        (t) => `- [FAILED] ${t.summary}${t.command ? ` (\`${t.command}\`)` : ""}`
      )
    );
  }

  sections.push(
    "",
    "## Instructions",
    "1. Inspect the reported files and review findings carefully.",
    "2. Implement corrective code changes to fix each finding.",
    "3. Run regression tests and verification commands to ensure all tests pass and no new regressions were created.",
    "4. Report all addressed findings and test results accurately in the structured output."
  );

  // Audit Finding 13: never detach via coordination tools.
  sections.push("", "## Autonomy Constraint", AUTONOMOUS_EXECUTION_RULE);

  return sections.join("\n");
}

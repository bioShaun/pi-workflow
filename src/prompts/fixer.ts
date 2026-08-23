import type { PlanResult } from "../contracts/plan.ts";
import type { ReviewFinding } from "../contracts/review.ts";
import type { TestResult } from "../contracts/implementation.ts";
import type { VerificationExecution } from "../contracts/requirement.ts";
import {
  AUTONOMOUS_EXECUTION_RULE,
  renderRequirementSection,
  type SpecRequirementPrompt,
} from "./common.ts";

export interface BuildFixerPromptInput {
  task: string;
  plan: PlanResult;
  findings: ReviewFinding[];
  failedTests?: TestResult[];
  verificationFailures?: VerificationExecution[];
  outOfScopePaths?: string[];
  round: number;
  requirement?: SpecRequirementPrompt;
}

export function buildFixerPrompt(input: BuildFixerPromptInput): string {
  const sections: string[] = [
    "You are a fix worker responsible for addressing review findings and test failures.",
    "",
    ...renderRequirementSection(input.task, input.requirement),
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

  if (input.verificationFailures && input.verificationFailures.length > 0) {
    sections.push(
      "",
      "## Engine Verification Failures",
      ...input.verificationFailures.map((result) => [
        `- \`${result.command}\` exited ${result.exitCode}`,
        result.stdout ? `  stdout: ${result.stdout}` : "",
        result.stderr ? `  stderr: ${result.stderr}` : "",
      ].filter(Boolean).join("\n"))
    );
  }

  if (input.outOfScopePaths && input.outOfScopePaths.length > 0) {
    sections.push(
      "",
      "## Out-of-Scope Repository Changes",
      ...input.outOfScopePaths.map((filePath) => `- \`${filePath}\``),
      "Restore or relocate these changes so the actual working tree matches the allowlist."
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

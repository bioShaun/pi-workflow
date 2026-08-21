import type { PlanResult } from "../contracts/plan.ts";
import type { ImplementationResult } from "../contracts/implementation.ts";
import type { ReviewFinding } from "../contracts/review.ts";
import type { FixResult } from "../contracts/fix.ts";
import { AUTONOMOUS_EXECUTION_RULE } from "./common.ts";

export type ReviewerSpecialization =
  | "general"
  | "correctness"
  | "quality_and_tests"
  | "final";

export interface BuildReviewerPromptInput {
  task: string;
  plan: PlanResult;
  implementation?: ImplementationResult;
  latestFix?: FixResult;
  previousFindings?: ReviewFinding[];
  specialization?: ReviewerSpecialization;
  round: number;
}

export function buildReviewerPrompt(input: BuildReviewerPromptInput): string {
  const sections: string[] = [
    "You are an independent code reviewer.",
    "",
    "You did not participate in the implementation.",
    "",
    "Review the current repository state and implementation against the original requirement and approved plan.",
    "",
    "Do not justify implementation choices merely because they exist.",
    "",
    "Inspect the actual code and diff independently.",
    "",
    "Focus on concrete defects, regressions, missing tests, unsafe behavior, incorrect assumptions, and unnecessary scope expansion.",
    "",
    "Do not modify files.",
    "",
    "Return PASS only if there are no changes worth requiring before completion.",
    "",
    "Return REQUEST_CHANGES when concrete corrective work is required.",
    "",
    "## Original Requirement",
    input.task.trim(),
    "",
    "## Approved Plan Summary",
    input.plan.summary,
  ];

  if (input.specialization === "correctness") {
    sections.push(
      "",
      "## Focus Area: Correctness & Compliance",
      "Pay special attention to functional correctness, edge cases, regression risks, and strict alignment with requirements."
    );
  } else if (input.specialization === "quality_and_tests") {
    sections.push(
      "",
      "## Focus Area: Tests & Simplicity",
      "Pay special attention to test coverage adequacy, test assertion strength, maintainability, and avoiding scope creep / unnecessary complexity."
    );
  } else if (input.specialization === "final") {
    sections.push(
      "",
      "## Focus Area: Final Verification",
      "Verify the overall final state independently, ensuring that all previously reported findings have been properly resolved and no new regressions were introduced."
    );
  }

  if (input.implementation) {
    sections.push(
      "",
      "## Implementation Summary from Worker",
      input.implementation.summary,
      "",
      "### Files Changed",
      ...input.implementation.changedFiles.map((f) => `- \`${f.path}\`: ${f.change}`),
      "",
      "### Test Evidence Reported",
      ...input.implementation.tests.map(
        (t) => `- [${t.status.toUpperCase()}] ${t.summary}${t.command ? ` (\`${t.command}\`)` : ""}`
      )
    );

    if (input.implementation.deviationsFromPlan.length > 0) {
      sections.push(
        "",
        "### Reported Deviations from Plan",
        ...input.implementation.deviationsFromPlan.map(
          (d) => `- ${d.description} (Reason: ${d.reason})`
        )
      );
    }

    if (input.implementation.unresolvedIssues.length > 0) {
      sections.push(
        "",
        "### Unresolved Issues Flagged by Worker",
        ...input.implementation.unresolvedIssues.map((i) => `- ${i}`)
      );
    }
  }

  if (input.latestFix) {
    sections.push(
      "",
      "## Latest Fix Summary",
      input.latestFix.summary,
      "",
      "### Addressed Findings",
      ...input.latestFix.addressedFindings.map((f) => `- ${f}`),
      "",
      "### Fix Test Results",
      ...input.latestFix.tests.map(
        (t) => `- [${t.status.toUpperCase()}] ${t.summary}${t.command ? ` (\`${t.command}\`)` : ""}`
      )
    );
  }

  if (input.previousFindings && input.previousFindings.length > 0) {
    sections.push(
      "",
      "## Previous Review Findings to Verify",
      ...input.previousFindings.map(
        (f) => `- [${f.severity.toUpperCase()}] (${f.category}) ${f.description} (File: ${f.file ?? "N/A"}:${f.line ?? "N/A"})`
      )
    );
  }

  sections.push(
    "",
    "## Review Instructions",
    "1. Inspect the codebase using your read tools to verify actual files and git diff.",
    "2. Evaluate whether the implementation satisfies the requirement and plan.",
    "3. Check for security vulnerabilities, logic bugs, regressions, or missing test assertions.",
    "4. Return structured output matching the schema with verdict PASS or REQUEST_CHANGES."
  );

  // Audit Finding 13: never detach via coordination tools.
  sections.push("", "## Autonomy Constraint", AUTONOMOUS_EXECUTION_RULE);

  return sections.join("\n");
}

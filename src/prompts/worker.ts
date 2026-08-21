import type { PlanResult } from "../contracts/plan.ts";
import type { ScoutResult } from "../contracts/scout.ts";
import { AUTONOMOUS_EXECUTION_RULE } from "./common.ts";

export interface BuildWorkerPromptInput {
  task: string;
  plan: PlanResult;
  scout?: ScoutResult;
}

export function buildWorkerPrompt(input: BuildWorkerPromptInput): string {
  const sections: string[] = [
    "You are an implementation worker responsible for executing the approved plan.",
    "",
    "## Original Requirement",
    input.task.trim(),
    "",
    "## Approved Plan Summary",
    input.plan.summary,
    "",
    "## Plan Understanding",
    input.plan.understanding,
    "",
    "## Planned File Changes",
    ...input.plan.files.map((f) => `- [${f.action}] \`${f.path}\`: ${f.purpose}`),
    "",
    "## Implementation Steps",
    ...input.plan.steps.map((s) => `${s.id}. ${s.description}`),
    "",
    "## Verification Tests to Run",
    ...input.plan.tests.map(
      (t) => `- ${t.required ? "[REQUIRED]" : "[OPTIONAL]"} ${t.description}${t.command ? ` (\`${t.command}\`)` : ""}`
    ),
  ];

  if (input.scout) {
    sections.push(
      "",
      "## Scout Exploration Summary",
      input.scout.summary,
      "",
      "### Relevant Files Identified by Scout",
      ...input.scout.relevantFiles.map((f) => `- \`${f.path}\`: ${f.relevance}`),
      "",
      "### Context Hints",
      ...input.scout.contextHints.map((h) => `- ${h}`)
    );
  }

  if (input.plan.assumptions.length > 0) {
    sections.push(
      "",
      "## Assumptions",
      ...input.plan.assumptions.map((a) => `- ${a}`)
    );
  }

  sections.push(
    "",
    "## Execution Instructions",
    "1. Inspect relevant repository state first.",
    "2. Implement the changes following the approved steps.",
    "3. Run all tests and verification commands.",
    "4. Report all changed files and test outcomes accurately.",
    "5. Report any deviations from the plan and unresolved issues honestly.",
    "6. Return structured data matching the schema."
  );

  // Audit Finding 13: never detach via coordination tools.
  sections.push("", "## Autonomy Constraint", AUTONOMOUS_EXECUTION_RULE);

  return sections.join("\n");
}

import type { ScoutResult } from "../contracts/scout.ts";
import { AUTONOMOUS_EXECUTION_RULE } from "./common.ts";

export interface BuildPlannerPromptInput {
  task: string;
  scout?: ScoutResult;
}

export function buildPlannerPrompt(input: BuildPlannerPromptInput): string {
  const sections: string[] = [
    "Produce an implementation plan.",
    "Do not modify repository files.",
    "Return only data matching the supplied structured schema.",
    "",
    "## User Requirement",
    input.task.trim(),
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

  sections.push(
    "",
    "## Planning Instructions",
    "1. Analyze the requirements thoroughly.",
    "2. Determine the concrete files to inspect, modify, create, or delete.",
    "3. Break the work down into clear, ordered implementation steps with unique IDs.",
    "4. Specify test commands and verification expectations (mark required tests as required=true).",
    "5. Identify potential risks and mitigations.",
    "6. Assess complexity (low, medium, high) and whether a second independent reviewer is required.",
    "7. Do NOT modify any files yourself."
  );

  // Audit Finding 13: never detach via coordination tools.
  sections.push("", "## Autonomy Constraint", AUTONOMOUS_EXECUTION_RULE);

  return sections.join("\n");
}

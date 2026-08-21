import { AUTONOMOUS_EXECUTION_RULE } from "./common.ts";

export interface BuildScoutPromptInput {
  task: string;
}

export function buildScoutPrompt(input: BuildScoutPromptInput): string {
  return [
    "You are a repository scout performing initial read-only codebase exploration.",
    "",
    "Goal:",
    `Explore the codebase to identify relevant files, architecture patterns, and context hints for the following task:`,
    `"""`,
    input.task.trim(),
    `"""`,
    "",
    "Instructions:",
    "1. Explore the directory structure and relevant files.",
    "2. Identify key files that may need inspection or modification.",
    "3. Note architectural conventions, testing patterns, and dependencies.",
    "4. Do NOT modify any files.",
    "5. Return structured data matching the schema.",
    "",
    "## Autonomy Constraint",
    AUTONOMOUS_EXECUTION_RULE,
  ].join("\n");
}

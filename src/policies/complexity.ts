import type { PlanResult } from "../contracts/plan.ts";
import type { WorkflowMode } from "../contracts/workflow.ts";

export function resolveWorkflowMode(
  plan: PlanResult,
  explicitMode?: WorkflowMode
): WorkflowMode {
  // Explicit user override always wins
  if (explicitMode) {
    return explicitMode;
  }

  // Hard overrides to strict
  if (plan.requiresSecondReviewer) {
    return "strict";
  }

  const hasHighRisk = plan.risks?.some((r) => r.severity === "high");
  if (hasHighRisk) {
    return "strict";
  }

  // Inspect files or plan for indicators of sensitive work
  const hasSecurityOrMigration = plan.files?.some((f) => {
    const p = f.path.toLowerCase();
    return (
      p.includes("security") ||
      p.includes("auth") ||
      p.includes("migration") ||
      p.includes("schema") ||
      p.includes("docker") ||
      p.includes(".github/workflows") ||
      p.includes("infra")
    );
  });
  if (hasSecurityOrMigration) {
    return "strict";
  }

  if (plan.complexity === "high") {
    return "strict";
  }
  if (plan.complexity === "medium") {
    return "normal";
  }
  return "quick";
}

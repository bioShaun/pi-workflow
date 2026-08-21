import { WorkflowInvariantError } from "../engine/errors.ts";

export type AgentRole = "scout" | "planner" | "worker" | "reviewer" | "fixer";

export function getDefaultContextForRole(role: AgentRole): "fresh" | "fork" {
  switch (role) {
    case "planner":
      return "fork";
    case "scout":
    case "worker":
    case "reviewer":
    case "fixer":
    default:
      return "fresh";
  }
}

export function assertReviewerFreshness(node: { role: string; context: string }): void {
  if ((node.role === "reviewer" || node.role.startsWith("reviewer")) && node.context !== "fresh") {
    throw new WorkflowInvariantError("Reviewer nodes must use fresh context");
  }
}

import type { PlanResult } from "./plan.ts";
import type { ImplementationResult } from "./implementation.ts";
import type { ReviewResult } from "./review.ts";
import type { FixResult } from "./fix.ts";

export type WorkflowState =
  | "created"
  | "scouting"
  | "planning"
  | "plan_ready"
  | "implementing"
  | "testing"
  | "reviewing"
  | "fixing"
  | "completed"
  | "failed"
  | "aborted";

/**
 * Audit Finding 12: "paused" was dead code (defined but never produced).
 * It has been removed; only the states above are valid.
 */

export const WORKFLOW_TERMINAL_STATES: WorkflowState[] = ["completed", "failed", "aborted"];

export type WorkflowMode = "quick" | "normal" | "strict";

export type Complexity = "low" | "medium" | "high";

export type WorkflowErrorCode =
  | "dependency_unavailable"
  | "preflight_failed"
  | "agent_execution_failed"
  | "invalid_structured_output"
  | "required_tests_failed"
  | "review_budget_exhausted"
  | "invalid_transition"
  | "state_corrupt"
  | "workflow_aborted"
  | "incomplete_node"
  | "unknown";

export interface WorkflowErrorDetails {
  code: WorkflowErrorCode;
  message: string;
  nodeId?: string;
  details?: unknown;
}

export interface RepositoryBaseline {
  head?: string;
  branch?: string;
  dirty: boolean;
  status: string[];
  startedAt: string;
}

export interface WorkflowRun {
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  state: WorkflowState;
  mode: WorkflowMode;
  request: string;
  complexity?: Complexity;
  currentNode?: string;
  reviewRound: number;
  maxReviewRounds: number;
  plan?: PlanResult;
  implementation?: ImplementationResult;
  reviews: ReviewResult[];
  fixes: FixResult[];
  error?: WorkflowErrorDetails;
  baseline: RepositoryBaseline;

  /**
   * Audit Finding 6 (§24/§25): true when the user did not pass an explicit
   * mode flag, so the mode is auto-routed from the plan's complexity.
   * Auto-routed runs launch the planner first and only scout when the
   * resolved mode is normal/strict.
   */
  autoRouted?: boolean;

  /** True once the mode has been finalized (creation for explicit, post-plan for auto). */
  modeResolved?: boolean;
}

export interface WorkflowConfig {
  defaultMode: WorkflowMode;
  maxReviewRounds: number;
  agents: {
    scout: string;
    planner: string;
    worker: string;
    reviewer: string;
  };
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  defaultMode: "normal",
  maxReviewRounds: 3,
  agents: {
    scout: "scout",
    planner: "planner",
    worker: "worker",
    reviewer: "reviewer",
  },
};

export function validateWorkflowRun(data: unknown): { ok: true; data: WorkflowRun } | { ok: false; error: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Workflow run state must be a non-null object" };
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) {
    return { ok: false, error: `Invalid workflow version: ${String(obj.version)}; expected 1` };
  }
  if (typeof obj.id !== "string" || !obj.id.trim()) {
    return { ok: false, error: "id must be a non-empty string" };
  }
  if (typeof obj.cwd !== "string" || !obj.cwd.trim()) {
    return { ok: false, error: "cwd must be a non-empty string" };
  }
  if (typeof obj.createdAt !== "string" || typeof obj.updatedAt !== "string") {
    return { ok: false, error: "createdAt and updatedAt must be strings" };
  }
  const validStates: WorkflowState[] = [
    "created",
    "scouting",
    "planning",
    "plan_ready",
    "implementing",
    "testing",
    "reviewing",
    "fixing",
    "completed",
    "failed",
    "aborted",
  ];
  if (!validStates.includes(obj.state as WorkflowState)) {
    return { ok: false, error: `Invalid state: ${String(obj.state)}` };
  }
  if (!["quick", "normal", "strict"].includes(obj.mode as string)) {
    return { ok: false, error: `Invalid mode: ${String(obj.mode)}` };
  }
  if (typeof obj.request !== "string") {
    return { ok: false, error: "request must be a string" };
  }
  if (typeof obj.reviewRound !== "number" || typeof obj.maxReviewRounds !== "number") {
    return { ok: false, error: "reviewRound and maxReviewRounds must be numbers" };
  }
  if (!Array.isArray(obj.reviews) || !Array.isArray(obj.fixes)) {
    return { ok: false, error: "reviews and fixes must be arrays" };
  }
  if (!obj.baseline || typeof obj.baseline !== "object") {
    return { ok: false, error: "baseline must be an object" };
  }
  return { ok: true, data: obj as unknown as WorkflowRun };
}

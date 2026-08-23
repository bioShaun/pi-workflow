import type { WorkflowRun, WorkflowState } from "../contracts/workflow.ts";
import { InvalidTransitionError } from "./errors.ts";

export const VALID_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  // created → plan_ready is the spec-driven entry (/work spec): the plan is
  // synthesized deterministically from the spec document, so no planner node runs.
  created: ["scouting", "planning", "plan_ready", "ticketing", "aborted", "failed"],
  scouting: ["planning", "failed", "aborted"],
  planning: ["plan_ready", "failed", "aborted"],
  plan_ready: ["implementing", "failed", "aborted"],
  implementing: ["testing", "failed", "aborted"],
  testing: ["reviewing", "fixing", "failed", "aborted"],
  reviewing: ["completed", "fixing", "failed", "aborted"],
  fixing: ["testing", "reviewing", "failed", "aborted"],
  ticketing: ["executing_tickets", "failed", "aborted"],
  executing_tickets: ["finalizing", "failed", "aborted"],
  finalizing: ["completed", "fixing", "failed", "aborted"],
  completed: [],
  failed: [],
  aborted: [],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (from === to) return true;
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function transitionState(
  run: WorkflowRun,
  to: WorkflowState,
  options?: { reason?: string; currentNode?: string }
): WorkflowRun {
  if (!canTransition(run.state, to)) {
    throw new InvalidTransitionError(run.state, to, options?.reason);
  }

  const now = new Date().toISOString();
  return {
    ...run,
    state: to,
    currentNode: options?.currentNode !== undefined ? options?.currentNode : run.currentNode,
    updatedAt: now,
  };
}

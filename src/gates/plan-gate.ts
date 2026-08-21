import { validatePlanResult, type PlanResult } from "../contracts/plan.ts";

export interface PlanGateResult {
  pass: boolean;
  error?: string;
  plan?: PlanResult;
}

export function evaluatePlanGate(raw: unknown): PlanGateResult {
  const validation = validatePlanResult(raw);
  if (!validation.ok) {
    return {
      pass: false,
      error: `Plan gate failed validation: ${validation.error}`,
    };
  }

  const plan = validation.data;
  if (!plan.summary || !plan.summary.trim()) {
    return {
      pass: false,
      error: "Plan gate failed: summary must be non-empty",
    };
  }

  if (!plan.steps || plan.steps.length === 0) {
    return {
      pass: false,
      error: "Plan gate failed: plan must contain at least one step",
    };
  }

  if (!Array.isArray(plan.tests)) {
    return {
      pass: false,
      error: "Plan gate failed: tests array must be present",
    };
  }

  if (!["low", "medium", "high"].includes(plan.complexity)) {
    return {
      pass: false,
      error: `Plan gate failed: invalid complexity "${String(plan.complexity)}"`,
    };
  }

  return {
    pass: true,
    plan,
  };
}

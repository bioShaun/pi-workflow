import type { Complexity } from "./workflow.ts";

export interface PlanFile {
  path: string;
  purpose: string;
  action: "inspect" | "modify" | "create" | "delete";
}

export interface PlanStep {
  id: string;
  description: string;
}

export interface PlanTest {
  command?: string;
  description: string;
  required: boolean;
}

export interface PlanRisk {
  severity: "low" | "medium" | "high";
  description: string;
  mitigation?: string;
}

export interface PlanResult {
  summary: string;
  understanding: string;
  files: PlanFile[];
  steps: PlanStep[];
  tests: PlanTest[];
  risks: PlanRisk[];
  assumptions: string[];
  complexity: Complexity;
  requiresSecondReviewer: boolean;
}

export const PLAN_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "summary",
    "understanding",
    "files",
    "steps",
    "tests",
    "risks",
    "assumptions",
    "complexity",
    "requiresSecondReviewer",
  ],
  properties: {
    summary: { type: "string" },
    understanding: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "purpose", "action"],
        properties: {
          path: { type: "string" },
          purpose: { type: "string" },
          action: {
            type: "string",
            enum: ["inspect", "modify", "create", "delete"],
          },
        },
      },
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "description"],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        required: ["description", "required"],
        properties: {
          command: { type: "string" },
          description: { type: "string" },
          required: { type: "boolean" },
        },
      },
    },
    risks: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "description"],
        properties: {
          severity: { type: "string", enum: ["low", "medium", "high"] },
          description: { type: "string" },
          mitigation: { type: "string" },
        },
      },
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
    },
    complexity: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
    requiresSecondReviewer: {
      type: "boolean",
    },
  },
  additionalProperties: false,
};

export function validatePlanResult(data: unknown): { ok: true; data: PlanResult } | { ok: false; error: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Plan result must be a non-null object" };
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    return { ok: false, error: "summary must be a non-empty string" };
  }
  if (typeof obj.understanding !== "string") {
    return { ok: false, error: "understanding must be a string" };
  }
  if (!Array.isArray(obj.files)) {
    return { ok: false, error: "files must be an array" };
  }
  for (let i = 0; i < obj.files.length; i++) {
    const f = obj.files[i];
    if (!f || typeof f !== "object") return { ok: false, error: `files[${i}] must be an object` };
    if (typeof f.path !== "string") return { ok: false, error: `files[${i}].path must be a string` };
    if (typeof f.purpose !== "string") return { ok: false, error: `files[${i}].purpose must be a string` };
    if (!["inspect", "modify", "create", "delete"].includes(f.action)) {
      return { ok: false, error: `files[${i}].action must be one of: inspect, modify, create, delete` };
    }
  }

  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    return { ok: false, error: "steps must be a non-empty array" };
  }
  for (let i = 0; i < obj.steps.length; i++) {
    const s = obj.steps[i];
    if (!s || typeof s !== "object") return { ok: false, error: `steps[${i}] must be an object` };
    if (typeof s.id !== "string" || !s.id.trim()) return { ok: false, error: `steps[${i}].id must be a string` };
    if (typeof s.description !== "string" || !s.description.trim()) return { ok: false, error: `steps[${i}].description must be a string` };
  }

  if (!Array.isArray(obj.tests)) {
    return { ok: false, error: "tests must be an array" };
  }
  for (let i = 0; i < obj.tests.length; i++) {
    const t = obj.tests[i];
    if (!t || typeof t !== "object") return { ok: false, error: `tests[${i}] must be an object` };
    if (typeof t.description !== "string") return { ok: false, error: `tests[${i}].description must be a string` };
    if (typeof t.required !== "boolean") return { ok: false, error: `tests[${i}].required must be a boolean` };
  }

  if (!Array.isArray(obj.risks)) {
    return { ok: false, error: "risks must be an array" };
  }
  for (let i = 0; i < obj.risks.length; i++) {
    const r = obj.risks[i];
    if (!r || typeof r !== "object") return { ok: false, error: `risks[${i}] must be an object` };
    if (!["low", "medium", "high"].includes(r.severity)) return { ok: false, error: `risks[${i}].severity must be low, medium, or high` };
    if (typeof r.description !== "string") return { ok: false, error: `risks[${i}].description must be a string` };
  }

  if (!Array.isArray(obj.assumptions)) {
    return { ok: false, error: "assumptions must be an array" };
  }
  for (let i = 0; i < obj.assumptions.length; i++) {
    if (typeof obj.assumptions[i] !== "string") return { ok: false, error: `assumptions[${i}] must be a string` };
  }

  if (!["low", "medium", "high"].includes(obj.complexity as string)) {
    return { ok: false, error: "complexity must be one of: low, medium, high" };
  }

  if (typeof obj.requiresSecondReviewer !== "boolean") {
    return { ok: false, error: "requiresSecondReviewer must be a boolean" };
  }

  return { ok: true, data: obj as unknown as PlanResult };
}

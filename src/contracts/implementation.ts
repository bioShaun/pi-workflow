export interface TestResult {
  command?: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  exitCode?: number;
}

export interface ImplementationResult {
  summary: string;
  changedFiles: Array<{
    path: string;
    change: string;
  }>;
  tests: TestResult[];
  unresolvedIssues: string[];
  deviationsFromPlan: Array<{
    description: string;
    reason: string;
  }>;
}

export const IMPLEMENTATION_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "summary",
    "changedFiles",
    "tests",
    "unresolvedIssues",
    "deviationsFromPlan",
  ],
  properties: {
    summary: { type: "string" },
    changedFiles: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "change"],
        properties: {
          path: { type: "string" },
          change: { type: "string" },
        },
      },
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        required: ["status", "summary"],
        properties: {
          command: { type: "string" },
          status: {
            type: "string",
            enum: ["passed", "failed", "skipped"],
          },
          summary: { type: "string" },
          exitCode: { type: "number" },
        },
      },
    },
    unresolvedIssues: {
      type: "array",
      items: { type: "string" },
    },
    deviationsFromPlan: {
      type: "array",
      items: {
        type: "object",
        required: ["description", "reason"],
        properties: {
          description: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
  additionalProperties: false,
};

export function validateImplementationResult(
  data: unknown
): { ok: true; data: ImplementationResult } | { ok: false; error: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Implementation result must be a non-null object" };
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    return { ok: false, error: "summary must be a non-empty string" };
  }
  if (!Array.isArray(obj.changedFiles)) {
    return { ok: false, error: "changedFiles must be an array" };
  }
  for (let i = 0; i < obj.changedFiles.length; i++) {
    const f = obj.changedFiles[i];
    if (!f || typeof f !== "object") return { ok: false, error: `changedFiles[${i}] must be an object` };
    if (typeof f.path !== "string") return { ok: false, error: `changedFiles[${i}].path must be a string` };
    if (typeof f.change !== "string") return { ok: false, error: `changedFiles[${i}].change must be a string` };
  }

  if (!Array.isArray(obj.tests)) {
    return { ok: false, error: "tests must be an array" };
  }
  for (let i = 0; i < obj.tests.length; i++) {
    const t = obj.tests[i];
    if (!t || typeof t !== "object") return { ok: false, error: `tests[${i}] must be an object` };
    if (!["passed", "failed", "skipped"].includes(t.status)) {
      return { ok: false, error: `tests[${i}].status must be passed, failed, or skipped` };
    }
    if (typeof t.summary !== "string") return { ok: false, error: `tests[${i}].summary must be a string` };
  }

  if (!Array.isArray(obj.unresolvedIssues)) {
    return { ok: false, error: "unresolvedIssues must be an array" };
  }
  for (let i = 0; i < obj.unresolvedIssues.length; i++) {
    if (typeof obj.unresolvedIssues[i] !== "string") {
      return { ok: false, error: `unresolvedIssues[${i}] must be a string` };
    }
  }

  if (!Array.isArray(obj.deviationsFromPlan)) {
    return { ok: false, error: "deviationsFromPlan must be an array" };
  }
  for (let i = 0; i < obj.deviationsFromPlan.length; i++) {
    const d = obj.deviationsFromPlan[i];
    if (!d || typeof d !== "object") return { ok: false, error: `deviationsFromPlan[${i}] must be an object` };
    if (typeof d.description !== "string") return { ok: false, error: `deviationsFromPlan[${i}].description must be a string` };
    if (typeof d.reason !== "string") return { ok: false, error: `deviationsFromPlan[${i}].reason must be a string` };
  }

  return { ok: true, data: obj as unknown as ImplementationResult };
}

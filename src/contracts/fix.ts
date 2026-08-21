import type { TestResult } from "./implementation.ts";

export interface UnaddressedFinding {
  findingId: string;
  reason: string;
}

export interface FixResult {
  summary: string;
  addressedFindings: string[];
  unaddressedFindings: UnaddressedFinding[];
  changedFiles: Array<{
    path: string;
    change: string;
  }>;
  tests: TestResult[];
  round?: number;
}

export const FIX_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "summary",
    "addressedFindings",
    "unaddressedFindings",
    "changedFiles",
    "tests",
  ],
  properties: {
    summary: { type: "string" },
    addressedFindings: {
      type: "array",
      items: { type: "string" },
    },
    unaddressedFindings: {
      type: "array",
      items: {
        type: "object",
        required: ["findingId", "reason"],
        properties: {
          findingId: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
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
    round: { type: "number" },
  },
  additionalProperties: false,
};

export function validateFixResult(
  data: unknown
): { ok: true; data: FixResult } | { ok: false; error: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Fix result must be a non-null object" };
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    return { ok: false, error: "summary must be a non-empty string" };
  }

  if (!Array.isArray(obj.addressedFindings)) {
    return { ok: false, error: "addressedFindings must be an array" };
  }
  for (let i = 0; i < obj.addressedFindings.length; i++) {
    if (typeof obj.addressedFindings[i] !== "string") {
      return { ok: false, error: `addressedFindings[${i}] must be a string` };
    }
  }

  if (!Array.isArray(obj.unaddressedFindings)) {
    return { ok: false, error: "unaddressedFindings must be an array" };
  }
  for (let i = 0; i < obj.unaddressedFindings.length; i++) {
    const u = obj.unaddressedFindings[i];
    if (!u || typeof u !== "object") return { ok: false, error: `unaddressedFindings[${i}] must be an object` };
    if (typeof u.findingId !== "string") return { ok: false, error: `unaddressedFindings[${i}].findingId must be a string` };
    if (typeof u.reason !== "string") return { ok: false, error: `unaddressedFindings[${i}].reason must be a string` };
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

  return { ok: true, data: obj as unknown as FixResult };
}

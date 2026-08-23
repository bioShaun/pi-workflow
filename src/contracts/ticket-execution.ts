export interface RedAuthoringResult {
  summary: string;
  expectedFailure: string;
  changedTestPaths: string[];
  existingReproduction: boolean;
}

export const RED_AUTHORING_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["summary", "expectedFailure", "changedTestPaths", "existingReproduction"],
  properties: {
    summary: { type: "string" },
    expectedFailure: { type: "string" },
    changedTestPaths: { type: "array", items: { type: "string" } },
    existingReproduction: { type: "boolean" },
  },
  additionalProperties: false,
};

export function validateRedAuthoringResult(
  value: unknown
): { ok: true; data: RedAuthoringResult } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "red result must be an object" };
  const object = value as Record<string, unknown>;
  if (typeof object.summary !== "string" || !object.summary.trim()) {
    return { ok: false, error: "red summary must be non-empty" };
  }
  if (
    typeof object.expectedFailure !== "string"
    || !object.expectedFailure.trim()
    || object.expectedFailure.length > 500
  ) {
    return { ok: false, error: "expectedFailure must contain 1-500 characters" };
  }
  if (!Array.isArray(object.changedTestPaths) || object.changedTestPaths.some((item) => typeof item !== "string" || !item.trim())) {
    return { ok: false, error: "changedTestPaths must be an array of paths" };
  }
  if (typeof object.existingReproduction !== "boolean") {
    return { ok: false, error: "existingReproduction must be boolean" };
  }
  if (!object.existingReproduction && object.changedTestPaths.length === 0) {
    return { ok: false, error: "a new red test must report at least one changed test path" };
  }
  return { ok: true, data: object as unknown as RedAuthoringResult };
}

export interface ScoutFile {
  path: string;
  relevance: string;
}

export interface ScoutResult {
  summary: string;
  relevantFiles: ScoutFile[];
  contextHints: string[];
}

export const SCOUT_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["summary", "relevantFiles", "contextHints"],
  properties: {
    summary: { type: "string" },
    relevantFiles: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "relevance"],
        properties: {
          path: { type: "string" },
          relevance: { type: "string" },
        },
      },
    },
    contextHints: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: false,
};

export function validateScoutResult(
  data: unknown
): { ok: true; data: ScoutResult } | { ok: false; error: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Scout result must be a non-null object" };
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    return { ok: false, error: "summary must be a non-empty string" };
  }

  if (!Array.isArray(obj.relevantFiles)) {
    return { ok: false, error: "relevantFiles must be an array" };
  }
  for (let i = 0; i < obj.relevantFiles.length; i++) {
    const f = obj.relevantFiles[i];
    if (!f || typeof f !== "object") return { ok: false, error: `relevantFiles[${i}] must be an object` };
    if (typeof f.path !== "string") return { ok: false, error: `relevantFiles[${i}].path must be a string` };
    if (typeof f.relevance !== "string") return { ok: false, error: `relevantFiles[${i}].relevance must be a string` };
  }

  if (!Array.isArray(obj.contextHints)) {
    return { ok: false, error: "contextHints must be an array" };
  }
  for (let i = 0; i < obj.contextHints.length; i++) {
    if (typeof obj.contextHints[i] !== "string") {
      return { ok: false, error: `contextHints[${i}] must be a string` };
    }
  }

  return { ok: true, data: obj as unknown as ScoutResult };
}

export type ReviewVerdict = "PASS" | "REQUEST_CHANGES";

export interface ReviewFinding {
  id: string;
  severity: "blocker" | "major" | "minor";
  category:
    | "correctness"
    | "regression"
    | "security"
    | "tests"
    | "maintainability"
    | "scope"
    | "performance"
    | "other";
  file?: string;
  line?: number;
  description: string;
  evidence: string;
  recommendedFix?: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  testAssessment: {
    sufficient: boolean;
    explanation: string;
  };
  confidence: number;
  reviewerId?: string;
  round?: number;
}

export const REVIEW_RESULT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "verdict",
    "summary",
    "findings",
    "testAssessment",
    "confidence",
  ],
  properties: {
    verdict: {
      type: "string",
      enum: ["PASS", "REQUEST_CHANGES"],
    },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "severity", "category", "description", "evidence"],
        properties: {
          id: { type: "string" },
          severity: {
            type: "string",
            enum: ["blocker", "major", "minor"],
          },
          category: {
            type: "string",
            enum: [
              "correctness",
              "regression",
              "security",
              "tests",
              "maintainability",
              "scope",
              "performance",
              "other",
            ],
          },
          file: { type: "string" },
          line: { type: "number" },
          description: { type: "string" },
          evidence: { type: "string" },
          recommendedFix: { type: "string" },
        },
      },
    },
    testAssessment: {
      type: "object",
      required: ["sufficient", "explanation"],
      properties: {
        sufficient: { type: "boolean" },
        explanation: { type: "string" },
      },
    },
    confidence: {
      type: "number",
      minimum: 0.0,
      maximum: 1.0,
    },
    reviewerId: { type: "string" },
    round: { type: "number" },
  },
  additionalProperties: false,
};

export function validateReviewResult(
  data: unknown
): { ok: true; data: ReviewResult } | { ok: false; error: string } {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Review result must be a non-null object" };
  }
  const obj = data as Record<string, unknown>;

  if (obj.verdict !== "PASS" && obj.verdict !== "REQUEST_CHANGES") {
    return { ok: false, error: 'verdict must be either "PASS" or "REQUEST_CHANGES"' };
  }
  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    return { ok: false, error: "summary must be a non-empty string" };
  }

  if (!Array.isArray(obj.findings)) {
    return { ok: false, error: "findings must be an array" };
  }
  for (let i = 0; i < obj.findings.length; i++) {
    const f = obj.findings[i];
    if (!f || typeof f !== "object") return { ok: false, error: `findings[${i}] must be an object` };
    if (typeof f.id !== "string" || !f.id.trim()) return { ok: false, error: `findings[${i}].id must be a string` };
    if (!["blocker", "major", "minor"].includes(f.severity)) {
      return { ok: false, error: `findings[${i}].severity must be blocker, major, or minor` };
    }
    const validCategories = [
      "correctness",
      "regression",
      "security",
      "tests",
      "maintainability",
      "scope",
      "performance",
      "other",
    ];
    if (!validCategories.includes(f.category)) {
      return { ok: false, error: `findings[${i}].category is invalid: ${String(f.category)}` };
    }
    if (typeof f.description !== "string" || !f.description.trim()) {
      return { ok: false, error: `findings[${i}].description must be a string` };
    }
    if (typeof f.evidence !== "string") {
      return { ok: false, error: `findings[${i}].evidence must be a string` };
    }
  }

  if (!obj.testAssessment || typeof obj.testAssessment !== "object") {
    return { ok: false, error: "testAssessment must be an object" };
  }
  const ta = obj.testAssessment as Record<string, unknown>;
  if (typeof ta.sufficient !== "boolean") {
    return { ok: false, error: "testAssessment.sufficient must be a boolean" };
  }
  if (typeof ta.explanation !== "string") {
    return { ok: false, error: "testAssessment.explanation must be a string" };
  }

  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
    return { ok: false, error: "confidence must be a number between 0.0 and 1.0" };
  }

  return { ok: true, data: obj as unknown as ReviewResult };
}

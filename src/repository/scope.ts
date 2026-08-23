import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RequirementSnapshot, ScopeArtifact } from "../contracts/requirement.ts";
import type { RepositoryBaseline } from "../contracts/workflow.ts";
import { captureWorkingTreeFiles } from "./baseline.ts";

const WORKFLOW_ARTIFACT_PREFIX = ".pi/workflow/";

export class ScopeComparisonError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScopeComparisonError";
  }
}

export async function compareRepositoryScope(input: {
  cwd: string;
  baseline: RepositoryBaseline;
  allowedChanges?: string[];
  requirement: RequirementSnapshot;
  label: string;
}): Promise<ScopeArtifact> {
  if (!input.baseline.files) {
    throw new ScopeComparisonError("Exact working-tree baseline is unavailable");
  }

  let current;
  try {
    current = await captureWorkingTreeFiles(input.cwd);
  } catch (error) {
    throw new ScopeComparisonError("Current working tree could not be indexed", { cause: error });
  }

  const before = new Map(input.baseline.files.map((entry) => [entry.path, entry.hash]));
  const after = new Map(current.map((entry) => [entry.path, entry.hash]));
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed = [...paths]
    .filter((filePath) => !filePath.startsWith(WORKFLOW_ARTIFACT_PREFIX))
    .filter((filePath) => before.get(filePath) !== after.get(filePath))
    .sort();

  const sourceAbsolute = path.resolve(input.cwd, input.requirement.sourcePath);
  let sourceChanged = false;
  try {
    const source = await fs.readFile(sourceAbsolute);
    const hash = crypto.createHash("sha256").update(source).digest("hex");
    sourceChanged = hash !== input.requirement.sha256;
  } catch {
    sourceChanged = true;
  }
  if (sourceChanged && !changed.includes(input.requirement.sourcePath)) {
    changed.push(input.requirement.sourcePath);
    changed.sort();
  }

  const allowed = input.allowedChanges ? new Set(input.allowedChanges) : undefined;
  const outOfScope = allowed
    ? changed.filter((filePath) => filePath === input.requirement.sourcePath || !allowed.has(filePath))
    : changed.filter((filePath) => filePath === input.requirement.sourcePath);
  return {
    label: input.label,
    status: outOfScope.length === 0 ? "passed" : "failed",
    changed,
    outOfScope,
    completedAt: new Date().toISOString(),
  };
}

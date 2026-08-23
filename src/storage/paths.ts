import * as path from "node:path";

export function getWorkflowBaseDir(cwd: string): string {
  return path.join(cwd, ".pi", "workflow");
}

export function getActiveRunPointerPath(baseDir: string): string {
  return path.join(baseDir, "active.json");
}

export function getRunsDir(baseDir: string): string {
  return path.join(baseDir, "runs");
}

export function getRunDir(baseDir: string, runId: string): string {
  return path.join(getRunsDir(baseDir), runId);
}

/** Resolve a run-relative artifact path and fail closed on path escape. */
export function resolveRunArtifactPath(
  baseDir: string,
  runId: string,
  artifactPath: string
): string {
  if (!artifactPath || path.isAbsolute(artifactPath)) {
    throw new Error("Run artifact path must be a non-empty relative path");
  }
  const runDir = path.resolve(getRunDir(baseDir, runId));
  const resolved = path.resolve(runDir, artifactPath);
  if (!resolved.startsWith(`${runDir}${path.sep}`)) {
    throw new Error(`Run artifact path escapes its owning run: ${artifactPath}`);
  }
  return resolved;
}

export function getStateFilePath(baseDir: string, runId: string): string {
  return path.join(getRunDir(baseDir, runId), "state.json");
}

export function getEventsFilePath(baseDir: string, runId: string): string {
  return path.join(getRunDir(baseDir, runId), "events.jsonl");
}

export function getRequestFilePath(baseDir: string, runId: string): string {
  return path.join(getRunDir(baseDir, runId), "request.md");
}

export function getPlanFilePath(baseDir: string, runId: string): string {
  return path.join(getRunDir(baseDir, runId), "plan.json");
}

export function getImplementationFilePath(baseDir: string, runId: string): string {
  return path.join(getRunDir(baseDir, runId), "implementation.json");
}

export function getReviewsDir(baseDir: string, runId: string): string {
  return path.join(getRunDir(baseDir, runId), "reviews");
}

export function getReviewFilePath(baseDir: string, runId: string, round: number | string): string {
  return path.join(getReviewsDir(baseDir, runId), `review-${round}.json`);
}

export function getFixesDir(baseDir: string, runId: string): string {
  return path.join(getRunDir(baseDir, runId), "fixes");
}

export function getFixFilePath(baseDir: string, runId: string, round: number | string): string {
  return path.join(getFixesDir(baseDir, runId), `fix-${round}.json`);
}

export function getFinalFilePath(baseDir: string, runId: string): string {
  return path.join(getRunDir(baseDir, runId), "final.json");
}

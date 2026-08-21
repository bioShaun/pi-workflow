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

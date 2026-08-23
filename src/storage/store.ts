import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  getWorkflowBaseDir,
  getActiveRunPointerPath,
  getRunsDir,
  getRunDir,
  getStateFilePath,
  resolveRunArtifactPath,
  getRequestFilePath,
  getPlanFilePath,
  getImplementationFilePath,
  getReviewsDir,
  getReviewFilePath,
  getFixesDir,
  getFixFilePath,
  getFinalFilePath,
} from "./paths.ts";
import {
  validateWorkflowRun,
  type WorkflowRun,
  type WorkflowState,
} from "../contracts/workflow.ts";
import { WorkflowCorruptError } from "../engine/errors.ts";

export async function writeAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempName = `${path.basename(filePath)}.tmp.${crypto.randomBytes(6).toString("hex")}`;
  const tempPath = path.join(dir, tempName);

  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
}

export async function saveWorkflowRun(baseDir: string, run: WorkflowRun): Promise<void> {
  const statePath = getStateFilePath(baseDir, run.id);
  const jsonContent = JSON.stringify(run, null, 2);
  await writeAtomic(statePath, jsonContent);
}

export async function loadWorkflowRun(baseDir: string, runId: string): Promise<WorkflowRun> {
  const statePath = getStateFilePath(baseDir, runId);
  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf-8");
  } catch (error) {
    throw new WorkflowCorruptError(`Cannot read workflow state file for run "${runId}"`, {
      details: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WorkflowCorruptError(`Malformed JSON in workflow state file for run "${runId}"`, {
      details: error,
    });
  }

  const validation = validateWorkflowRun(parsed);
  if (!validation.ok) {
    throw new WorkflowCorruptError(
      `Invalid workflow state schema for run "${runId}": ${validation.error}`
    );
  }

  return validation.data;
}

export async function getActiveRunId(baseDir: string): Promise<string | null> {
  const activePath = getActiveRunPointerPath(baseDir);
  try {
    const content = await fs.readFile(activePath, "utf-8");
    const parsed = JSON.parse(content) as { activeRunId?: string };
    if (!parsed.activeRunId) return null;

    // Check if the referenced run is terminal
    try {
      const run = await loadWorkflowRun(baseDir, parsed.activeRunId);
      const terminalStates: WorkflowState[] = ["completed", "failed", "aborted"];
      if (terminalStates.includes(run.state)) {
        // Stale pointer; clear it
        await clearActiveRunId(baseDir);
        return null;
      }
      return parsed.activeRunId;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export async function setActiveRunId(baseDir: string, runId: string): Promise<void> {
  const activePath = getActiveRunPointerPath(baseDir);
  const payload = JSON.stringify({ activeRunId: runId, updatedAt: new Date().toISOString() }, null, 2);
  await writeAtomic(activePath, payload);
}

export async function clearActiveRunId(baseDir: string): Promise<void> {
  const activePath = getActiveRunPointerPath(baseDir);
  try {
    await fs.unlink(activePath);
  } catch {
    // Ignore if not found
  }
}

export async function listWorkflowRuns(baseDir: string): Promise<string[]> {
  const runsDir = getRunsDir(baseDir);
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  } catch {
    return [];
  }
}

export async function saveArtifact(
  baseDir: string,
  runId: string,
  filename: string,
  content: string | object
): Promise<void> {
  const filePath = resolveRunArtifactPath(baseDir, runId, filename);
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  await writeAtomic(filePath, text);
}

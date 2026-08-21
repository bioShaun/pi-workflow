import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getEventsFilePath, getRunDir } from "./paths.ts";
import type { WorkflowState } from "../contracts/workflow.ts";

export interface WorkflowEvent {
  ts: string;
  event: string;
  state?: WorkflowState;
  node?: string;
  from?: WorkflowState;
  to?: WorkflowState;
  details?: Record<string, unknown>;
}

export async function appendWorkflowEvent(
  baseDir: string,
  runId: string,
  event: Omit<WorkflowEvent, "ts"> & { ts?: string }
): Promise<void> {
  const fullEvent: WorkflowEvent = {
    ts: event.ts ?? new Date().toISOString(),
    ...event,
  };

  const runDir = getRunDir(baseDir, runId);
  await fs.mkdir(runDir, { recursive: true });

  const eventsFile = getEventsFilePath(baseDir, runId);
  const line = JSON.stringify(fullEvent) + "\n";
  await fs.appendFile(eventsFile, line, "utf-8");
}

/**
 * Read all persisted events for a run. Returns [] when the file is absent
 * or a line is corrupt (best-effort, used for recovery decisions —
 * post-remediation review M2).
 */
export async function loadWorkflowEvents(baseDir: string, runId: string): Promise<WorkflowEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(getEventsFilePath(baseDir, runId), "utf-8");
  } catch {
    return [];
  }
  const events: WorkflowEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as WorkflowEvent);
    } catch {
      // skip corrupt line
    }
  }
  return events;
}

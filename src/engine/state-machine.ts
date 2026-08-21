import type {
  WorkflowRun,
  WorkflowState,
  WorkflowErrorDetails,
} from "../contracts/workflow.ts";
import { transitionState } from "./transitions.ts";
import { saveWorkflowRun } from "../storage/store.ts";
import { appendWorkflowEvent } from "../storage/events.ts";

export class StateMachine {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async transition(
    run: WorkflowRun,
    to: WorkflowState,
    options?: {
      reason?: string;
      node?: string;
      error?: WorkflowErrorDetails;
      details?: Record<string, unknown>;
    }
  ): Promise<WorkflowRun> {
    const from = run.state;
    const nextRun = transitionState(run, to, {
      reason: options?.reason,
      currentNode: options?.node,
    });

    if (options?.error) {
      nextRun.error = options.error;
    }

    // Persist event
    await appendWorkflowEvent(this.baseDir, nextRun.id, {
      event: "state.changed",
      from,
      to,
      node: options?.node,
      details: {
        ...(options?.reason ? { reason: options.reason } : {}),
        ...(options?.details ?? {}),
      },
    });

    // Persist authoritative state snapshot
    await saveWorkflowRun(this.baseDir, nextRun);

    return nextRun;
  }
}

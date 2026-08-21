import type { WorkflowErrorCode } from "../contracts/workflow.ts";

export class WorkflowError extends Error {
  public readonly code: WorkflowErrorCode;
  public readonly nodeId?: string;
  public readonly details?: unknown;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    options?: { nodeId?: string; details?: unknown; cause?: unknown }
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.nodeId = options?.nodeId;
    this.details = options?.details;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.nodeId ? { nodeId: this.nodeId } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export class WorkflowInvariantError extends WorkflowError {
  constructor(message: string, options?: { nodeId?: string; details?: unknown }) {
    super("invalid_transition", `Invariant violation: ${message}`, options);
    this.name = "WorkflowInvariantError";
  }
}

export class WorkflowCorruptError extends WorkflowError {
  constructor(message: string, options?: { details?: unknown }) {
    super("state_corrupt", `State corrupt: ${message}`, options);
    this.name = "WorkflowCorruptError";
  }
}

export class InvalidTransitionError extends WorkflowError {
  constructor(from: string, to: string, reason?: string) {
    const detail = reason ? ` (${reason})` : "";
    super("invalid_transition", `Invalid transition from "${from}" to "${to}"${detail}`);
    this.name = "InvalidTransitionError";
  }
}

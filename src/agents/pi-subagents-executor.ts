import * as crypto from "node:crypto";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationUpdate,
  type SubagentDelegationResponse,
  type SubagentDelegationCancel,
} from "pi-subagents/delegation";
import type {
  AgentExecutor,
  AgentExecutionRequest,
  AgentExecutionResult,
} from "./executor.ts";

export interface PiEventEmitter {
  events: {
    on(event: string, handler: (payload: unknown) => void): () => void;
    emit(event: string, payload: unknown): void;
  };
}

export class PiSubagentsExecutor implements AgentExecutor {
  private pi: PiEventEmitter;

  constructor(pi: PiEventEmitter) {
    this.pi = pi;
  }

  async execute<T>(request: AgentExecutionRequest<T>): Promise<AgentExecutionResult<T>> {
    const requestId = crypto.randomUUID();

    const delegationReq: SubagentDelegationRequest = {
      requestId,
      ownerRunId: request.workflowRunId,
      nodeId: request.nodeId,
      agent: request.agent,
      task: request.task,
      context: request.context,
      cwd: request.cwd,
      ...(request.model ? { model: request.model } : {}),
      ...(request.thinking ? { thinking: request.thinking } : {}),
      ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      result: {
        kind: "structured",
        schema: request.schema,
      },
    };

    return new Promise<AgentExecutionResult<T>>((resolve, reject) => {
      let timeoutTimer: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        unsubscribeResponse();
        unsubscribeUpdate();
      };

      const unsubscribeUpdate = this.pi.events.on(
        SUBAGENT_DELEGATION_UPDATE_EVENT,
        (payload: unknown) => {
          if (settled) return;
          const update = payload as SubagentDelegationUpdate;
          if (!update || update.requestId !== requestId) return;
          if (
            update.ownerRunId !== request.workflowRunId ||
            update.nodeId !== request.nodeId
          ) {
            return;
          }

          if (request.onUpdate) {
            request.onUpdate({
              runId: update.runId,
              nodeId: update.nodeId,
              agent: request.agent,
              currentTool: update.currentTool,
              currentToolArgs: update.currentToolArgs,
              recentOutput: update.recentOutput,
              recentOutputLines: update.recentOutputLines,
              recentTools: update.recentTools,
              model: update.model,
              toolCount: update.toolCount,
              durationMs: update.durationMs,
              tokens: update.tokens,
            });
          }
        }
      );

      const unsubscribeResponse = this.pi.events.on(
        SUBAGENT_DELEGATION_RESPONSE_EVENT,
        (payload: unknown) => {
          if (settled) return;
          const response = payload as SubagentDelegationResponse;
          if (!response || response.requestId !== requestId) return;
          if (
            response.ownerRunId !== request.workflowRunId ||
            response.nodeId !== request.nodeId
          ) {
            return;
          }

          settled = true;
          cleanup();

          if (response.status === "completed") {
            const terminal = response as any;
            let resultData: T | undefined;
            if (terminal.result?.kind === "structured") {
              resultData = terminal.result.value as T;
            } else if (terminal.result?.kind === "text" && typeof terminal.result.text === "string") {
              try {
                resultData = JSON.parse(terminal.result.text) as T;
              } catch {
                resultData = terminal.result.text as unknown as T;
              }
            }

            resolve({
              status: "completed",
              result: resultData,
              usage: terminal.usage,
              model: terminal.model,
              thinking: terminal.thinking,
            });
          } else if (response.status === "cancelled") {
            resolve({
              status: "cancelled",
              error: response.error ?? "Subagent delegation was cancelled",
            });
          } else {
            resolve({
              status: "failed",
              error:
                response.error ??
                `Subagent delegation ended with status: ${response.status}`,
            });
          }
        }
      );

      if (request.timeoutMs && request.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();

          const cancelPayload: SubagentDelegationCancel = {
            requestId,
            ownerRunId: request.workflowRunId,
            nodeId: request.nodeId,
          };
          try {
            this.pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, cancelPayload);
          } catch {
            // Ignore emit errors on timeout
          }

          resolve({
            status: "timed_out",
            error: `Delegation timed out after ${request.timeoutMs}ms`,
          });
        }, request.timeoutMs);
      }

      // If the bus rejects the request emit, the delegation can never
      // settle through a response: mark the operation settled, detach both
      // listeners (and any timeout), and surface the transport failure.
      try {
        this.pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, delegationReq);
      } catch (err) {
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

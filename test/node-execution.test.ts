/**
 * Unit tests for the shared node execution/retry helper
 * (src/engine/node-execution.ts): the loop previously duplicated across the
 * scout, plan, implement, review, and fix node executors.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type {
  AgentExecutor,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentProgressUpdate,
} from "../src/agents/executor.ts";
import { RetryPolicy } from "../src/policies/retry.ts";
import { INTERCOM_RETRY_REMINDER } from "../src/policies/intercom.ts";
import {
  executeNodeWithRetry,
  type NodeExecutionOptions,
  type NodeTokenTracker,
  type NodeValidationOutcome,
} from "../src/engine/node-execution.ts";
import { WorkflowError } from "../src/engine/errors.ts";

type ScriptStep = (req: AgentExecutionRequest) => AgentExecutionResult<unknown>;

class ScriptedExecutor implements AgentExecutor {
  public requests: AgentExecutionRequest[] = [];
  private script: ScriptStep[];

  constructor(script: ScriptStep[]) {
    this.script = script;
  }

  async execute<T>(request: AgentExecutionRequest<T>): Promise<AgentExecutionResult<T>> {
    this.requests.push(request);
    const step = this.script[Math.min(this.requests.length - 1, this.script.length - 1)];
    return step(request) as AgentExecutionResult<T>;
  }
}

const OK_RESULT = { ok: true };
const BAD_RESULT = { ok: false };

const completed = (result: unknown, usage?: { input: number; output: number }): ScriptStep => () => ({
  status: "completed" as const,
  result,
  ...(usage ? { usage } : {}),
});

const failed = (error?: string): ScriptStep => () =>
  error === undefined
    ? { status: "failed" as const }
    : { status: "failed" as const, error };

/**
 * Options factory mirroring the engine's node executors: fresh context,
 * default retry policy, and a request factory that forwards progress updates
 * into the shared token tracker.
 */
function baseOptions<T = unknown>(
  script: ScriptStep[],
  extra: Partial<NodeExecutionOptions<T>> = {}
): { options: NodeExecutionOptions<T>; executor: ScriptedExecutor; sleeps: number[]; tracker: NodeTokenTracker } {
  const executor = new ScriptedExecutor(script);
  const sleeps: number[] = [];
  const tracker: NodeTokenTracker = {};
  const options: NodeExecutionOptions<T> = {
    nodeId: "scout",
    nodeLabel: "Scout node",
    taskPrompt: "TASK",
    requestFactory: (prompt) => ({
      workflowRunId: "run-1",
      nodeId: "scout",
      agent: "scout",
      task: prompt,
      context: "fresh",
      cwd: "/work",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
      onUpdate: (up: AgentProgressUpdate) => {
        if (up.tokens) {
          tracker.tokens = up.tokens;
        }
      },
    }),
    executor,
    retryPolicy: new RetryPolicy(),
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    tokenTracker: tracker,
    validate: (result: T): NodeValidationOutcome<T> => {
      const r = result as { ok?: boolean };
      return r.ok
        ? { ok: true, data: result }
        : { ok: false, validationError: "ok must be true", terminalMessage: "Scout node returned an invalid result" };
    },
    fallbackMessage: "Scout node produced no valid result",
  };
  // Apply the test-specific overrides (same shape, narrower type; required
  // fields are left at their defaults by the tests).
  Object.assign(options, extra);
  return { options, executor, sleeps, tracker };
}

describe("executeNodeWithRetry", () => {
  it("returns validated data on first completion without sleeping", async () => {
    const { options, executor, sleeps } = baseOptions([completed(OK_RESULT)]);

    const data = await executeNodeWithRetry(options);

    assert.deepEqual(data, OK_RESULT);
    assert.equal(executor.requests.length, 1);
    assert.equal(executor.requests[0].task, "TASK");
    assert.deepEqual(sleeps, []);
  });

  it("retries a malformed result with the task prompt plus schema correction", async () => {
    const { options, executor, sleeps } = baseOptions(
      [completed(BAD_RESULT), completed(OK_RESULT)],
      { schemaDescription: "ScoutResult" }
    );

    const data = await executeNodeWithRetry(options);

    assert.deepEqual(data, OK_RESULT);
    assert.equal(executor.requests.length, 2);
    assert.deepEqual(sleeps, [], "validation retries do not back off");
    assert.equal(executor.requests[0].task, "TASK");
    const retryTask = executor.requests[1].task;
    assert.match(retryTask, /^TASK\n\n/);
    assert.match(retryTask, /failed structured output schema validation/);
    assert.match(retryTask, /ScoutResult/);
  });

  it("exhausts the validation budget and throws a node-scoped invalid_structured_output", async () => {
    const { options, executor, sleeps } = baseOptions([completed(BAD_RESULT), completed(BAD_RESULT)]);

    await assert.rejects(
      executeNodeWithRetry(options),
      (err: unknown) =>
        err instanceof WorkflowError &&
        err.code === "invalid_structured_output" &&
        err.nodeId === "scout" &&
        err.message === "Scout node returned an invalid result"
    );
    assert.equal(executor.requests.length, 2);
    assert.deepEqual(sleeps, []);
  });

  it("retries an execution failure with backoff and keeps the current prompt", async () => {
    const { options, executor, sleeps } = baseOptions([failed("boom"), completed(OK_RESULT)]);

    const data = await executeNodeWithRetry(options);

    assert.deepEqual(data, OK_RESULT);
    assert.equal(executor.requests.length, 2);
    assert.deepEqual(sleeps, [1000], "first agent retry backs off by 1000ms");
    assert.equal(executor.requests[1].task, "TASK", "a non-intercom retry repeats the current prompt");
  });

  it("exhausts the execution budget and throws agent_execution_failed with the node label", async () => {
    const { options, executor, sleeps } = baseOptions([failed("boom"), failed("boom")]);

    await assert.rejects(
      executeNodeWithRetry(options),
      (err: unknown) =>
        err instanceof WorkflowError &&
        err.code === "agent_execution_failed" &&
        err.nodeId === "scout" &&
        err.message === "Scout node failed: boom"
    );
    assert.equal(executor.requests.length, 2);
    assert.deepEqual(sleeps, [1000], "the second failure is terminal, no further backoff");
  });

  it("uses the configured detail string when the executor returns no error text", async () => {
    const { options } = baseOptions([failed(undefined), failed(undefined)], {
      executionErrorDefault: "Worker execution failed",
      terminalErrorDetail: "Unknown error",
      nodeLabel: "Worker node",
    });

    await assert.rejects(
      executeNodeWithRetry(options),
      (err: unknown) =>
        err instanceof WorkflowError &&
        err.code === "agent_execution_failed" &&
        err.message === "Worker node failed: Unknown error"
    );
  });

  it("appends the intercom retry reminder to the current prompt after a detach failure", async () => {
    const { options, executor } = baseOptions([
      failed("detached for intercom coordination before task completion"),
      completed(OK_RESULT),
    ]);

    await executeNodeWithRetry(options);

    assert.equal(executor.requests[0].task, "TASK");
    assert.equal(executor.requests[1].task, `TASK\n\n${INTERCOM_RETRY_REMINDER}`);
  });

  it("shares one attempt counter between validation and agent retries (budget is not additive)", async () => {
    const { options, executor } = baseOptions([
      failed("detached for intercom coordination before task completion"),
      completed(BAD_RESULT),
    ]);

    // Attempt 1 burns the retry on the intercom agent retry; the malformed
    // attempt 2 must be terminal even though validation retries would be
    // available in isolation.
    await assert.rejects(
      executeNodeWithRetry(options),
      (err: unknown) =>
        err instanceof WorkflowError &&
        err.code === "invalid_structured_output" &&
        err.message === "Scout node returned an invalid result"
    );
    assert.equal(executor.requests.length, 2);
  });

  it("lets an execution-failure hook re-execute without consuming the retry budget (planner fork → fresh)", async () => {
    const forkError =
      "Failed to create forked subagent session: Parent session file does not exist. " +
      "Pi has not persisted enough history to fork yet.";
    let context: "fresh" | "fork" = "fork";
    const { options, executor, sleeps } = baseOptions(
      [failed(forkError), failed("transient blip"), completed(OK_RESULT)],
      {
        requestFactory: (prompt) => ({
          workflowRunId: "run-1",
          nodeId: "plan",
          agent: "planner",
          task: prompt,
          context,
          cwd: "/work",
          schema: {},
        }),
        onExecutionFailure: (execError: string) => {
          if (context === "fork" && execError.includes("not persisted enough history")) {
            context = "fresh";
            return true;
          }
          return false;
        },
      }
    );

    const data = await executeNodeWithRetry(options);

    assert.deepEqual(data, OK_RESULT);
    assert.equal(executor.requests.length, 3, "fork degrade + degraded fresh failure (retried) + success");
    assert.deepEqual(
      executor.requests.map((r) => r.context),
      ["fork", "fresh", "fresh"]
    );
    assert.deepEqual(sleeps, [1000], "the fork degradation itself does not back off");
  });

  it("still exhausts the budget when a hook-handled degradation is followed by real failures", async () => {
    const forkError = "Pi has not persisted enough history to fork yet.";
    let context: "fresh" | "fork" = "fork";
    const { options, executor, sleeps } = baseOptions(
      [failed(forkError), failed("broken"), failed("broken")],
      {
        requestFactory: (prompt) => ({
          workflowRunId: "run-1",
          nodeId: "plan",
          agent: "planner",
          task: prompt,
          context,
          cwd: "/work",
          schema: {},
        }),
        onExecutionFailure: (execError: string) => {
          if (context === "fork" && execError.includes("not persisted enough history")) {
            context = "fresh";
            return true;
          }
          return false;
        },
      }
    );

    await assert.rejects(
      executeNodeWithRetry(options),
      (err: unknown) =>
        err instanceof WorkflowError && err.code === "agent_execution_failed" && err.message === "Scout node failed: broken"
    );
    assert.equal(executor.requests.length, 3);
    assert.deepEqual(sleeps, [1000]);
  });

  it("propagates a hook-thrown WorkflowError as an immediate terminal failure", async () => {
    const refusal = "Subagent completed without making edits for an implementation task.";
    const { options, executor, sleeps } = baseOptions(
      [failed(refusal)],
      {
        onExecutionFailure: (execError: string) => {
          if (execError.includes("completed without making edits")) {
            throw new WorkflowError("agent_execution_failed", "Worker declined to modify the repository", {
              nodeId: "implement",
            });
          }
          return false;
        },
      }
    );

    await assert.rejects(
      executeNodeWithRetry(options),
      (err: unknown) =>
        err instanceof WorkflowError &&
        err.nodeId === "implement" &&
        err.message === "Worker declined to modify the repository"
    );
    assert.equal(executor.requests.length, 1, "a refusal must not consume the retry budget");
    assert.deepEqual(sleeps, []);
  });

  it("invokes onValidated with the validated data before returning it", async () => {
    const validated: unknown[] = [];
    const { options } = baseOptions(
      [completed(OK_RESULT)],
      {
        nodeId: "review-1",
        nodeLabel: "Reviewer review-1",
        onValidated: (data: unknown) => {
          validated.push(data);
          (data as { stamp?: string }).stamp = "stamped";
        },
      }
    );

    const data = await executeNodeWithRetry(options);

    assert.equal(validated.length, 1);
    assert.equal(validated[0], data, "onValidated receives the exact returned object");
    assert.deepEqual(data, { ok: true, stamp: "stamped" });
  });

  it("tracks streaming token estimates and lets the usage total override them", async () => {
    const updates: AgentProgressUpdate[] = [];
    const { options, tracker } = baseOptions(
      [
        (req: AgentExecutionRequest) => {
          req.onUpdate?.({
            nodeId: "scout",
            agent: "scout",
            currentTool: "read",
            durationMs: 5,
            tokens: 1200,
          });
          return {
            status: "completed" as const,
            result: OK_RESULT,
            usage: { input: 100, output: 50 },
          };
        },
      ],
      {
        requestFactory: (prompt) => ({
          workflowRunId: "run-1",
          nodeId: "scout",
          agent: "scout",
          task: prompt,
          context: "fresh",
          cwd: "/work",
          schema: {},
          onUpdate: (up: AgentProgressUpdate) => {
            updates.push(up);
            if (up.tokens) {
              tracker.tokens = up.tokens;
            }
          },
        }),
      }
    );

    await executeNodeWithRetry(options);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].tokens, 1200);
    assert.equal(tracker.tokens, 150, "usage input + output overrides the streaming estimate");
  });

  it("keeps the streaming estimate when the executor reports no usage input", async () => {
    const { options, tracker } = baseOptions(
      [
        (req: AgentExecutionRequest) => {
          req.onUpdate?.({ nodeId: "scout", agent: "scout", tokens: 1200 });
          return { status: "completed" as const, result: OK_RESULT };
        },
      ],
      {
        requestFactory: (prompt) => ({
          workflowRunId: "run-1",
          nodeId: "scout",
          agent: "scout",
          task: prompt,
          context: "fresh",
          cwd: "/work",
          schema: {},
          onUpdate: (up: AgentProgressUpdate) => {
            if (up.tokens) {
              tracker.tokens = up.tokens;
            }
          },
        }),
      }
    );

    await executeNodeWithRetry(options);

    assert.equal(tracker.tokens, 1200);
  });
});

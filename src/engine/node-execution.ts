/**
 * Shared agent execution/retry loop for workflow nodes (scout, plan,
 * implement, review, fix).
 *
 * The five node executors in engine.ts used to each carry a copy of this
 * ~50-line loop. The differences between nodes are narrow and are expressed
 * as explicit hooks/options:
 *
 * - `requestFactory`        — how the execution request is built (the
 *   reviewer hardcodes a fresh context; the planner switches context on
 *   fork degradation).
 * - `validate`              — node-specific acceptance (plain schema
 *   validators, or the plan gate for the planner).
 * - `onExecutionFailure`    — node-specific failure classification before
 *   the retry budget is consulted (planner fork → fresh degradation, which
 *   does NOT consume an attempt; worker/fixer refusal, which throws).
 * - `onValidated`           — post-validation mutation (reviewer
 *   reviewerId/round + node.completed event).
 * - message strings         — per-node labels/details preserved verbatim.
 *
 * Invariants preserved from the original loops:
 * - at most 2 executions (validation retries and agent retries share the
 *   same attempt counter; a hook-handled failure re-executes without
 *   advancing the counter);
 * - a validation retry re-executes `taskPrompt + correction`; an agent
 *   retry keeps the current prompt and appends INTERCOM_RETRY_REMINDER only
 *   for intercom-detach failures;
 * - sleep (backoff) happens only for agent retries;
 * - the usage total (input + output) overrides the streaming token estimate
 *   only when the executor reported a usage input.
 */
import type {
  AgentExecutor,
  AgentExecutionRequest,
} from "../agents/executor.ts";
import { RetryPolicy } from "../policies/retry.ts";
import { isIntercomDetachError, INTERCOM_RETRY_REMINDER } from "../policies/intercom.ts";
import { WorkflowError } from "./errors.ts";

/**
 * Token accounting shared between the request's progress-update forwarding
 * (streaming estimate) and the completed execution's usage total. The
 * owning node executor reads `tokens` for its terminal progress event.
 */
export interface NodeTokenTracker {
  tokens?: number;
}

export type NodeValidationOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; validationError: string; terminalMessage: string };

export interface NodeExecutionOptions<T> {
  nodeId: string;
  /** Label used in the terminal execution-failure message, e.g. "Scout node". */
  nodeLabel: string;
  /** Original (task) prompt; a validation retry executes taskPrompt + correction. */
  taskPrompt: string;
  /** Builds the full execution request for the current prompt (the engine
   *  wires progress forwarding and token tracking in the request's
   *  `onUpdate` closure). */
  requestFactory: (prompt: string) => AgentExecutionRequest<T>;
  executor: AgentExecutor;
  retryPolicy: RetryPolicy;
  sleep: (ms: number) => Promise<void>;
  /** Shared token accounting for the node's terminal progress event. */
  tokenTracker: NodeTokenTracker;
  /** Node-specific acceptance of a completed result. `validationError` is
   *  fed to the retry policy (and the correction prompt); `terminalMessage`
   *  is the failure message when no validation retry remains. */
  validate: (result: T) => NodeValidationOutcome<T>;
  /** Optional schema name appended to the validation-correction prompt. */
  schemaDescription?: string;
  /** Detail string for the terminal failure message when the executor
   *  returned no error text. Defaults to `executionErrorDefault`. */
  terminalErrorDetail?: string;
  /** Error text used when the executor returned no error (refusal hook,
   *  retry policy, intercom detection, terminal message). */
  executionErrorDefault?: string;
  /** Invoked with the validated data before it is returned (e.g. reviewer
   *  metadata assignment + node.completed event). Awaited before the data
   *  is returned so persisted events keep their original ordering. */
  onValidated?: (data: T) => void | Promise<void>;
  /** Invoked on a non-completed execution before the retry policy is
   *  consulted. Returning true handles the failure and re-executes without
   *  consuming the retry budget (planner fork → fresh degradation).
   *  Throwing propagates as the node failure (worker/fixer refusal).
   *  Awaited before the next execution for the same reason. */
  onExecutionFailure?: (execError: string) => boolean | Promise<boolean>;
  /** Message used if the loop exits without a valid result. */
  fallbackMessage: string;
}

export async function executeNodeWithRetry<T>(options: NodeExecutionOptions<T>): Promise<T> {
  const {
    nodeId,
    nodeLabel,
    taskPrompt,
    requestFactory,
    executor,
    retryPolicy,
    sleep,
    tokenTracker,
    validate,
  } = options;
  const {
    schemaDescription,
    onValidated,
    onExecutionFailure,
    executionErrorDefault = "Execution failed",
    terminalErrorDetail = executionErrorDefault,
    fallbackMessage,
  } = options;

  // The original node loops all bounded at two executions; validation
  // retries and agent retries share this counter.
  let attempt = 1;
  let currentPrompt = taskPrompt;

  while (attempt <= 2) {
    const result = await executor.execute<T>(requestFactory(currentPrompt));

    if (result.status === "completed" && result.result) {
      if (result.usage?.input) {
        tokenTracker.tokens = (result.usage.input || 0) + (result.usage.output || 0);
      }
      const validation = validate(result.result);
      if (validation.ok) {
        await onValidated?.(validation.data);
        return validation.data;
      }
      const action = retryPolicy.evaluateValidationFailure(
        attempt,
        validation.validationError,
        schemaDescription
      );
      if (action.type === "retry_validation") {
        currentPrompt = `${taskPrompt}\n\n${action.correctionPrompt}`;
        attempt++;
        continue;
      }
      throw new WorkflowError("invalid_structured_output", validation.terminalMessage, { nodeId });
    }

    const execError = result.error ?? executionErrorDefault;

    if (await onExecutionFailure?.(execError)) {
      continue;
    }

    const action = retryPolicy.evaluateAgentExecutionFailure(attempt, execError);
    if (action.type === "retry_agent") {
      await sleep(action.delayMs); // audit Finding 9
      // Audit Finding 13: an intercom-detached child actually finished its
      // work but called a coordination tool; retry with a hard prohibition.
      if (isIntercomDetachError(execError)) {
        currentPrompt = `${currentPrompt}\n\n${INTERCOM_RETRY_REMINDER}`;
      }
      attempt++;
      continue;
    }
    throw new WorkflowError(
      "agent_execution_failed",
      `${nodeLabel} failed: ${result.error ?? terminalErrorDetail}`,
      { nodeId }
    );
  }

  throw new WorkflowError("invalid_structured_output", fallbackMessage, { nodeId });
}

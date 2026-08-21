export type RetryAction =
  | { type: "retry_agent"; delayMs: number; augmentedPrompt?: string }
  | { type: "retry_validation"; correctionPrompt: string }
  | { type: "fail_node"; reason: string };

export interface RetryPolicyOptions {
  maxAgentRetries?: number;
  maxValidationRetries?: number;
}

export class RetryPolicy {
  private maxAgentRetries: number;
  private maxValidationRetries: number;

  constructor(options?: RetryPolicyOptions) {
    this.maxAgentRetries = options?.maxAgentRetries ?? 1;
    this.maxValidationRetries = options?.maxValidationRetries ?? 1;
  }

  evaluateAgentExecutionFailure(attempt: number, error: string): RetryAction {
    if (attempt <= this.maxAgentRetries) {
      return {
        type: "retry_agent",
        delayMs: 1000 * attempt,
      };
    }
    return {
      type: "fail_node",
      reason: `Agent execution failed after ${attempt} attempt(s): ${error}`,
    };
  }

  evaluateValidationFailure(
    attempt: number,
    validationError: string,
    schemaDescription?: string
  ): RetryAction {
    if (attempt <= this.maxValidationRetries) {
      const correction = [
        "Your previous response failed structured output schema validation with error:",
        validationError,
        schemaDescription ? `Please ensure the output strictly matches this structure: ${schemaDescription}` : "",
        "Return only valid JSON matching the requested schema.",
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        type: "retry_validation",
        correctionPrompt: correction,
      };
    }
    return {
      type: "fail_node",
      reason: `Structured output validation failed after ${attempt} attempt(s): ${validationError}`,
    };
  }
}

import type { AgentExecutor } from "../agents/executor.ts";
import type { RequirementSnapshot } from "../contracts/requirement.ts";
import type { TicketDefinition, TicketFinalGate, TicketGraph } from "../contracts/tickets.ts";
import { AUTONOMOUS_EXECUTION_RULE } from "../prompts/common.ts";
import { validateTicketGraph } from "./graph.ts";

export interface TicketGraphAdapterInput {
  requirement: Pick<RequirementSnapshot, "artifactPath" | "sha256">;
  requirementPath: string;
  requirementCriteria: string[];
}

export interface TicketGraphAdapter {
  obtain(input: TicketGraphAdapterInput): Promise<TicketGraph>;
}

export class TicketGenerationError extends Error {
  public readonly code: "ticketizer_failed" | "ticketizer_timeout" | "ticketizer_malformed";

  constructor(
    code: "ticketizer_failed" | "ticketizer_timeout" | "ticketizer_malformed",
    message: string
  ) {
    super(message);
    this.name = "TicketGenerationError";
    this.code = code;
  }
}

const TICKETIZER_TIMEOUT_MS = 120_000;

const TICKETIZER_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["tickets", "finalGate"],
  properties: {
    tickets: { type: "array", minItems: 1, items: { type: "object" } },
    finalGate: { type: "object" },
  },
  additionalProperties: false,
};

function isGeneratedShape(value: unknown): value is {
  tickets: TicketDefinition[];
  finalGate: TicketFinalGate;
} {
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.tickets) || !object.finalGate || typeof object.finalGate !== "object") {
    return false;
  }
  return object.tickets.every((ticket) => {
    if (!ticket || typeof ticket !== "object") return false;
    const item = ticket as Record<string, unknown>;
    return typeof item.id === "string"
      && typeof item.title === "string"
      && typeof item.capability === "string"
      && Array.isArray(item.acceptanceCriteria)
      && Array.isArray(item.blockedBy)
      && typeof item.testingSeam === "string"
      && Array.isArray(item.verification)
      && item.tdd !== null
      && typeof item.tdd === "object"
      && Array.isArray(item.covers);
  });
}

function buildTicketizerPrompt(input: TicketGraphAdapterInput): string {
  return [
    "Decompose one immutable specification into narrow complete tracer-bullet tickets.",
    "Do not modify repository files. Do not read or invoke authoring skills.",
    `Immutable requirement: \`${input.requirementPath}\``,
    `Requirement SHA-256: \`${input.requirement.sha256}\``,
    "Read the requirement in full before decomposing it.",
    `Required criterion IDs: ${input.requirementCriteria.join(", ")}`,
    "Each ticket must include identity, title, complete capability, acceptance criteria, blockers, testing seam, ordered verification, optional allowed paths, TDD policy/reason, and coverage IDs.",
    "Avoid horizontal layers. Return only the structured ticket graph payload.",
    "",
    AUTONOMOUS_EXECUTION_RULE,
  ].join("\n");
}

export class GeneratedTicketGraphAdapter implements TicketGraphAdapter {
  private readonly executor: AgentExecutor;
  private readonly plannerAgent: string;
  private readonly cwd: string;
  private readonly runId: string;
  private readonly timeoutMs: number;

  constructor(
    executor: AgentExecutor,
    plannerAgent: string,
    cwd: string,
    runId: string,
    timeoutMs = TICKETIZER_TIMEOUT_MS
  ) {
    this.executor = executor;
    this.plannerAgent = plannerAgent;
    this.cwd = cwd;
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }

  async obtain(input: TicketGraphAdapterInput): Promise<TicketGraph> {
    const result = await this.executor.execute<{
      tickets: TicketDefinition[];
      finalGate: TicketFinalGate;
    }>({
      workflowRunId: this.runId,
      nodeId: "ticketizer",
      agent: this.plannerAgent,
      task: buildTicketizerPrompt(input),
      context: "fresh",
      cwd: this.cwd,
      schema: TICKETIZER_SCHEMA,
      timeoutMs: this.timeoutMs,
    });

    if (result.status === "timed_out") {
      throw new TicketGenerationError("ticketizer_timeout", "Ticketizer exceeded its bounded execution timeout");
    }
    if (result.status !== "completed") {
      throw new TicketGenerationError(
        "ticketizer_failed",
        result.error ?? `Ticketizer ended with status ${result.status}`
      );
    }
    if (!isGeneratedShape(result.result)) {
      throw new TicketGenerationError("ticketizer_malformed", "Ticketizer returned malformed structured output");
    }
    return validateTicketGraph({
      requirement: input.requirement,
      requirementCriteria: input.requirementCriteria,
      tickets: result.result.tickets,
      finalGate: result.result.finalGate,
    });
  }
}

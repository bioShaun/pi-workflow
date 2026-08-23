import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  WorkflowRun,
  WorkflowState,
  WorkflowMode,
  WorkflowConfig,
  Complexity,
  WorkflowErrorDetails,
} from "../contracts/workflow.ts";
import { DEFAULT_WORKFLOW_CONFIG, WORKFLOW_TERMINAL_STATES } from "../contracts/workflow.ts";
import { PLAN_RESULT_SCHEMA, type PlanResult } from "../contracts/plan.ts";
import {
  IMPLEMENTATION_RESULT_SCHEMA,
  validateImplementationResult,
  type ImplementationResult,
} from "../contracts/implementation.ts";
import {
  REVIEW_RESULT_SCHEMA,
  validateReviewResult,
  type ReviewResult,
  type ReviewFinding,
} from "../contracts/review.ts";
import { FIX_RESULT_SCHEMA, validateFixResult, type FixResult } from "../contracts/fix.ts";
import { SCOUT_RESULT_SCHEMA, validateScoutResult, type ScoutResult } from "../contracts/scout.ts";
import {
  RED_AUTHORING_RESULT_SCHEMA,
  validateRedAuthoringResult,
} from "../contracts/ticket-execution.ts";
import type {
  RequirementSnapshot,
  SpecPolicy,
  VerificationAggregate,
  VerificationArtifact,
  ScopeAggregate,
} from "../contracts/requirement.ts";
import type { TicketGraph } from "../contracts/tickets.ts";
import {
  extractRequirementCriteria,
  freezeTicketGraph,
  importTicketGraph,
  loadFrozenTicketGraph,
  TicketGraphValidationError,
} from "../tickets/graph.ts";
import { selectTicketFrontier, transitionTicket } from "../tickets/lifecycle.ts";
import { GeneratedTicketGraphAdapter, TicketGenerationError } from "../tickets/adapter.ts";
import { parseSpecDocument, resolveSpecMode, SpecFormatError } from "../specs/spec-parser.ts";
import { evaluatePlanGate } from "../gates/plan-gate.ts";
import { evaluateTestGate } from "../gates/test-gate.ts";
import { evaluateCompletionGate } from "../gates/completion-gate.ts";
import { resolveWorkflowMode } from "../policies/complexity.ts";
import { RetryPolicy } from "../policies/retry.ts";
import { isForkUnavailableError } from "../policies/fork.ts";
import { isWorkerRefusalError, wrapWorkerRefusal } from "../policies/refusal.ts";
import { buildScoutPrompt } from "../prompts/scout.ts";
import { buildPlannerPrompt } from "../prompts/planner.ts";
import { buildWorkerPrompt } from "../prompts/worker.ts";
import { buildReviewerPrompt, type ReviewerSpecialization } from "../prompts/reviewer.ts";
import { buildFixerPrompt } from "../prompts/fixer.ts";
import type { SpecRequirementPrompt } from "../prompts/common.ts";
import { captureRepositoryBaseline } from "../repository/baseline.ts";
import {
  compareRepositoryScope,
  ScopeComparisonError,
} from "../repository/scope.ts";
import {
  getRunDir,
  getWorkflowBaseDir,
  resolveRunArtifactPath,
} from "../storage/paths.ts";
import {
  saveWorkflowRun,
  loadWorkflowRun,
  getActiveRunId,
  setActiveRunId,
  clearActiveRunId,
  listWorkflowRuns,
  saveArtifact,
} from "../storage/store.ts";
import { appendWorkflowEvent, loadWorkflowEvents } from "../storage/events.ts";
import { StateMachine } from "./state-machine.ts";
import {
  WorkflowError,
  WorkflowInvariantError,
} from "./errors.ts";
import {
  type AgentExecutor,
  type AgentProgressUpdate,
  createReviewerExecutionRequest,
} from "../agents/executor.ts";
import { executeNodeWithRetry, type NodeTokenTracker } from "./node-execution.ts";
import {
  validateWorkflowPreflight,
  type WorkflowRole,
} from "../agents/preflight.ts";
import {
  ShellVerificationCommandRunner,
  type VerificationCommandRunner,
} from "./verification.ts";

/** Resolved role → agent-name mapping for a run (audit Finding 10). */
export type AgentRoles = Record<WorkflowRole, string>;

/** Agent roles a run can actually launch, shared by every entry and recovery path. */
export function requiredRolesForRun(
  run: Pick<WorkflowRun, "source" | "mode" | "ticketGraphSource">
): WorkflowRole[] {
  if (run.source === "spec") return ["worker", "reviewer"];
  if (run.source === "tickets") {
    return run.ticketGraphSource === "imported"
      ? ["worker", "reviewer"]
      : ["planner", "worker", "reviewer"];
  }
  return run.mode === "quick"
    ? ["planner", "worker", "reviewer"]
    : ["scout", "planner", "worker", "reviewer"];
}

function requirementPromptForRun(run: WorkflowRun): SpecRequirementPrompt | undefined {
  if ((run.source !== "spec" && run.source !== "tickets") || !run.requirement || !run.specPolicy) return undefined;
  return {
    snapshot: run.requirement,
    snapshotPath: path.join(
      ".pi",
      "workflow",
      "runs",
      run.id,
      run.requirement.artifactPath
    ),
    policy: run.specPolicy,
  };
}

interface PreparedSpecSource {
  content: string;
  relativePath: string;
  requirement: RequirementSnapshot;
  policy: SpecPolicy;
  mode: WorkflowMode;
}

async function prepareSpecSource(
  cwd: string,
  configuredMode: WorkflowMode,
  specPath: string,
  explicitMode?: WorkflowMode
): Promise<PreparedSpecSource> {
  const absolutePath = path.isAbsolute(specPath) ? specPath : path.join(cwd, specPath);
  let content: string;
  try {
    content = await fs.readFile(absolutePath, "utf-8");
  } catch (error) {
    throw new WorkflowError(
      "invalid_transition",
      `Cannot read spec file "${specPath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!content.trim()) {
    throw new WorkflowError("invalid_transition", `Spec file "${specPath}" is empty`);
  }
  const maxCharacters = 100_000;
  if (content.length > maxCharacters) {
    throw new WorkflowError(
      "invalid_transition",
      `Spec file "${specPath}" is too large (${content.length} characters > ${maxCharacters}). Split it into smaller spec documents.`
    );
  }
  let parsed;
  try {
    parsed = parseSpecDocument(content);
  } catch (error) {
    if (error instanceof SpecFormatError) throw new WorkflowError("invalid_spec", error.message);
    throw error;
  }
  const relativePath = path.relative(cwd, absolutePath) || specPath;
  return {
    content,
    relativePath,
    requirement: {
      kind: "spec",
      sourcePath: relativePath,
      artifactPath: "requirement.md",
      sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
      characters: content.length,
    },
    policy: parsed.policy,
    mode: resolveSpecMode(explicitMode, parsed.policy.mode, configuredMode),
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function generateWorkflowRunId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const rand = crypto.randomBytes(2).toString("hex");
  return `wf_${y}${m}${d}_${hh}${mm}${ss}_${rand}`;
}

/**
 * Deterministic PlanResult for the spec-driven flow (/work spec). No LLM is
 * involved: the specification itself — embedded verbatim in the run request
 * — is the authoritative plan, so every node prompt (worker, reviewer,
 * fixer) renders it through the "Original Requirement" section. The
 * synthesized plan only steers structure; the required test entry feeds the
 * worker's "Verification Tests to Run" section (the test gate itself
 * classifies the worker-reported tests).
 */
export function synthesizeSpecPlan(specPath: string, policy?: SpecPolicy): PlanResult {
  return {
    summary: `Implement the specification "${specPath}" faithfully and completely.`,
    understanding:
      "This run is spec-driven: the specification reproduced in the Original Requirement section " +
      "is the authoritative plan. Read it in full, implement everything it requires, and treat its " +
      "acceptance criteria as the definition of done.",
    files: [
      {
        path: specPath,
        purpose: "Specification document (authoritative requirements; read-only)",
        action: "inspect",
      },
    ],
    steps: [
      { id: "1", description: `Read the specification "${specPath}" in full (see Original Requirement)` },
      { id: "2", description: "Implement everything the specification requires, following repository conventions" },
      {
        id: "3",
        description: "Run the test suite and any verification the specification requires; report results honestly",
      },
    ],
    tests: policy
      ? policy.verification.map((requirement) => ({
          command: requirement.command,
          description: requirement.command,
          required: requirement.required,
        }))
      : [{ description: "The project's test suite passes after implementation", required: true }],
    risks: [],
    assumptions: ["The specification is complete, unambiguous, and authoritative for this run"],
    complexity: "medium",
    requiresSecondReviewer: false,
  };
}

export interface WorkflowProgressEvent {
  type: "node_start" | "node_update" | "node_end";
  run: WorkflowRun;
  nodeId: string;
  agent?: string;
  action?: string;
  durationMs?: number;
  tokens?: number;
  details?: Record<string, unknown>;
}

export type WorkflowProgressCallback = (event: WorkflowProgressEvent) => void;

export interface WorkflowEngineOptions {
  cwd: string;
  executor: AgentExecutor;
  config?: Partial<WorkflowConfig>;
  retryPolicy?: RetryPolicy;
  /** Injectable clock for retry backoff (audit Finding 9); tests pass a recorder. */
  sleep?: (ms: number) => Promise<void>;
  verificationRunner?: VerificationCommandRunner;
  /** Injectable preflight seam. Receives both mode and the effective roles
   *  selected from the run source, so tests can assert the launch contract. */
  preflightForMode?: (mode: WorkflowMode, requiredRoles: WorkflowRole[]) => Promise<AgentRoles>;
  /** Optional progress callback for real-time UI/UX feedback (Claude Code style streaming) */
  onProgress?: WorkflowProgressCallback;
}

export class WorkflowEngine {
  public readonly cwd: string;
  public readonly baseDir: string;
  public readonly config: WorkflowConfig;
  public readonly executor: AgentExecutor;
  public readonly stateMachine: StateMachine;
  public readonly retryPolicy: RetryPolicy;
  public readonly sleep: (ms: number) => Promise<void>;
  public readonly verificationRunner: VerificationCommandRunner;
  public readonly onProgress?: WorkflowProgressCallback;
  private readonly preflightOverride?: (mode: WorkflowMode, requiredRoles: WorkflowRole[]) => Promise<AgentRoles>;

  constructor(options: WorkflowEngineOptions) {
    this.cwd = options.cwd;
    this.baseDir = getWorkflowBaseDir(options.cwd);
    this.executor = options.executor;
    this.config = {
      ...DEFAULT_WORKFLOW_CONFIG,
      ...(options.config ?? {}),
      agents: {
        ...DEFAULT_WORKFLOW_CONFIG.agents,
        ...(options.config?.agents ?? {}),
      },
    };
    this.stateMachine = new StateMachine(this.baseDir);
    this.retryPolicy = options.retryPolicy ?? new RetryPolicy();
    this.sleep = options.sleep ?? defaultSleep;
    this.verificationRunner = options.verificationRunner ?? new ShellVerificationCommandRunner();
    this.preflightOverride = options.preflightForMode;
    this.onProgress = options.onProgress;
  }

  // --- Active Run & Lock Management ---

  private async acquireRunLock(runId: string): Promise<void> {
    const activeId = await getActiveRunId(this.baseDir);
    if (activeId && activeId !== runId) {
      throw new WorkflowError(
        "invalid_transition",
        `An active workflow already exists: ${activeId}\nUse /work status, /work resume, or /work abort.`
      );
    }
    await setActiveRunId(this.baseDir, runId);
  }

  private async releaseRunLock(runId: string): Promise<void> {
    const activeId = await getActiveRunId(this.baseDir);
    if (activeId === runId) {
      await clearActiveRunId(this.baseDir);
    }
  }

  /**
   * Audit Finding 2 (§36): persist the failure, release the run lock, and
   * emit recovery-oriented events. Best-effort at every step so the original
   * failure can never be masked by a failure of the failure handling.
   */
  private async markRunFailed(run: WorkflowRun, error: unknown, nodeId?: string): Promise<WorkflowRun> {
    const wfError =
      error instanceof WorkflowError
        ? error
        : new WorkflowError("unknown", error instanceof Error ? error.message : String(error), {
            details: error,
          });
    const node = nodeId ?? wfError.nodeId ?? run.currentNode ?? "unknown";
    const alreadyTerminal = WORKFLOW_TERMINAL_STATES.includes(run.state);

    if (!alreadyTerminal) {
      try {
        run = await this.stateMachine.transition(run, "failed", {
          node,
          reason: wfError.message,
          error: {
            code: wfError.code,
            message: wfError.message,
            nodeId: node,
            ...(wfError.details ? { details: wfError.details } : {}),
          },
        });
      } catch {
        // Even if the failure transition cannot be persisted (e.g. corrupt
        // state), fall through: release the lock and surface the error.
      }
      try {
        await appendWorkflowEvent(this.baseDir, run.id, {
          event: "node.failed",
          state: run.state,
          node,
          details: { code: wfError.code, message: wfError.message },
        });
      } catch {
        // best effort
      }
    }

    try {
      await appendWorkflowEvent(this.baseDir, run.id, {
        event: "workflow.failed",
        state: run.state,
        node,
        details: { code: wfError.code, message: wfError.message },
      });
    } catch {
      // best effort
    }

    // Always release the lock on failure so a failed run cannot lock the
    // project (terminal-state pointers are additionally auto-cleared by
    // getActiveRunId).
    await this.releaseRunLock(run.id);

    return run;
  }

  /** Run preflight for exactly the roles selected from the run source. */
  private async preflightForRun(
    run: Pick<WorkflowRun, "source" | "mode" | "ticketGraphSource">
  ): Promise<AgentRoles> {
    const requiredRoles = requiredRolesForRun(run);
    if (this.preflightOverride) {
      return this.preflightOverride(run.mode, requiredRoles);
    }
    const preflight = await validateWorkflowPreflight(
      this.config,
      this.cwd,
      run.mode,
      undefined,
      requiredRoles
    );
    if (!preflight.ok) {
      throw new WorkflowError("preflight_failed", preflight.error ?? "Preflight checks failed", {
        details: preflight.diagnostics,
      });
    }
    return preflight.agents ?? { ...this.config.agents };
  }

  private async createRun(
    request: string,
    initialMode: WorkflowMode,
    autoRouted: boolean,
    origin?: {
      source: "auto" | "plan" | "spec" | "tickets";
      specPath?: string;
      specPolicy?: SpecPolicy;
      requirement?: RequirementSnapshot;
      requirementContent?: string;
      ticketGraphSource?: "imported" | "generated";
    }
  ): Promise<WorkflowRun> {
    const runId = generateWorkflowRunId();
    await this.acquireRunLock(runId);

    if (origin?.requirement && origin.requirementContent !== undefined) {
      await saveArtifact(
        this.baseDir,
        runId,
        origin.requirement.artifactPath,
        origin.requirementContent
      );
    }
    const baseline = await captureRepositoryBaseline(this.cwd);
    const now = new Date().toISOString();

    const run: WorkflowRun = {
      version: 1,
      id: runId,
      cwd: this.cwd,
      createdAt: now,
      updatedAt: now,
      state: "created",
      mode: initialMode,
      request,
      reviewRound: 1,
      maxReviewRounds: initialMode === "quick" ? 2 : this.config.maxReviewRounds,
      reviews: [],
      fixes: [],
      baseline,
      autoRouted,
      modeResolved: !autoRouted,
      source: origin?.source,
      specPath: origin?.specPath,
      specPolicy: origin?.specPolicy,
      requirement: origin?.requirement,
      ticketGraphSource: origin?.ticketGraphSource,
    };

    await saveWorkflowRun(this.baseDir, run);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "workflow.created",
      state: "created",
      details: origin?.source === "spec" || origin?.source === "tickets"
        ? {
            mode: run.mode,
            autoRouted,
            maxReviewRounds: run.maxReviewRounds,
            source: origin.source,
            requirement: origin.requirement,
            policy: origin.specPolicy,
          }
        : {
            mode: run.mode,
            autoRouted,
            maxReviewRounds: run.maxReviewRounds,
            source: origin?.source,
            request,
          },
    });

    return run;
  }

  /**
   * Re-hydrate a persisted scout artifact (audit Finding 8). Returns
   * undefined when absent or invalid.
   */
  private async loadScoutArtifact(runId: string): Promise<ScoutResult | undefined> {
    try {
      const raw = await fs.readFile(path.join(getRunDir(this.baseDir, runId), "scout.json"), "utf-8");
      const validation = validateScoutResult(JSON.parse(raw));
      return validation.ok ? validation.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Re-hydrate a persisted plan artifact (spec-driven resume). Returns
   * undefined when absent or failing the plan gate.
   */
  private async loadPlanArtifact(runId: string): Promise<PlanResult | undefined> {
    try {
      const raw = await fs.readFile(path.join(getRunDir(this.baseDir, runId), "plan.json"), "utf-8");
      const gate = evaluatePlanGate(JSON.parse(raw));
      return gate.pass && gate.plan ? gate.plan : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Re-hydrate a persisted implementation artifact (post-remediation review
   * M2). Returns undefined when absent or invalid.
   */
  private async loadImplementationArtifact(runId: string): Promise<ImplementationResult | undefined> {
    try {
      const raw = await fs.readFile(path.join(getRunDir(this.baseDir, runId), "implementation.json"), "utf-8");
      const validation = validateImplementationResult(JSON.parse(raw));
      return validation.ok ? validation.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Re-hydrate a persisted fix artifact (post-remediation review M2).
   * Returns undefined when absent or invalid.
   */
  private async loadFixArtifact(runId: string, fixRound: number): Promise<FixResult | undefined> {
    try {
      const raw = await fs.readFile(
        path.join(getRunDir(this.baseDir, runId), "fixes", `fix-${fixRound}.json`),
        "utf-8"
      );
      const validation = validateFixResult(JSON.parse(raw));
      return validation.ok ? validation.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * True when `nodeId` has a node.started event with no node.completed after
   * it (post-remediation review M2): the node was in flight when the
   * process died. For mutating nodes that means the working tree may
   * already have been modified.
   */
  private async nodeStartedWithoutCompletion(runId: string, nodeId: string): Promise<boolean> {
    const events = await loadWorkflowEvents(this.baseDir, runId);
    let startedIndex = -1;
    for (let i = 0; i < events.length; i++) {
      if (events[i].event === "node.started" && events[i].node === nodeId) startedIndex = i;
    }

    if (startedIndex === -1) return false;
    for (let i = startedIndex + 1; i < events.length; i++) {
      if (events[i].event === "node.completed" && events[i].node === nodeId) return false;
    }
    return true;
  }
  private async ensureSpecRequirement(run: WorkflowRun): Promise<WorkflowRun> {
    if (run.source !== "spec" && run.source !== "tickets") return run;

    if (run.requirement) {
      let content: string;
      try {
        const snapshotPath = resolveRunArtifactPath(
          this.baseDir,
          run.id,
          run.requirement.artifactPath
        );
        content = await fs.readFile(snapshotPath, "utf-8");
      } catch (error) {
        throw new WorkflowError(
          "requirement_corrupt",
          `Cannot read immutable requirement snapshot for run ${run.id}`,
          { details: error }
        );
      }
      const actualHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
      if (actualHash !== run.requirement.sha256) {
        throw new WorkflowError(
          "requirement_corrupt",
          `Immutable requirement snapshot hash mismatch for run ${run.id}`,
          { details: { expected: run.requirement.sha256, actual: actualHash } }
        );
      }
      return run;
    }

    if (run.specPolicy) {
      throw new WorkflowError(
        "requirement_corrupt",
        `Spec run ${run.id} is missing its immutable requirement metadata`
      );
    }

    const embedded = run.request.match(
      /--- SPECIFICATION BEGIN ---\n([\s\S]*?)\n--- SPECIFICATION END ---/
    )?.[1];
    let content = embedded;
    if (content === undefined) {
      const events = await loadWorkflowEvents(this.baseDir, run.id);
      const mutationStarted = events.some(
        (event) => event.event === "node.started"
          && (event.node === "implement" || event.node?.startsWith("fix-") === true)
      );
      if (mutationStarted || !run.specPath) {
        throw new WorkflowError(
          "requirement_corrupt",
          `Legacy spec run ${run.id} has no recoverable authoritative requirement after repository mutation`
        );
      }
      try {
        content = await fs.readFile(path.resolve(this.cwd, run.specPath), "utf-8");
      } catch (error) {
        throw new WorkflowError(
          "requirement_corrupt",
          `Cannot recover the source requirement for legacy spec run ${run.id}`,
          { details: error }
        );
      }
    }

    const parsed = parseSpecDocument(content);
    const sourcePath = run.specPath ?? "legacy-embedded-spec.md";
    run.requirement = {
      kind: "spec",
      sourcePath,
      artifactPath: "requirement.md",
      sha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
      characters: content.length,
    };
    run.specPolicy = parsed.policy;
    run.request = `Spec-driven workflow from immutable requirement snapshot for "${sourcePath}".`;
    await saveArtifact(this.baseDir, run.id, run.requirement.artifactPath, content);
    await saveWorkflowRun(this.baseDir, run);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "spec.snapshot_migrated",
      state: run.state,
      node: "spec",
      details: { requirement: run.requirement, policy: run.specPolicy },
    });
    return run;
  }

  private async validateTicketResume(run: WorkflowRun): Promise<TicketGraph> {
    if (run.source !== "tickets" || !run.baseline.files || !run.tickets) {
      throw new WorkflowError("ticket_graph_corrupt", "Ticketed run lacks source, baseline, or runtime state");
    }
    await this.ensureSpecRequirement(run);
    let graph: TicketGraph;
    try {
      graph = await loadFrozenTicketGraph(this.baseDir, run);
    } catch (error) {
      throw new WorkflowError(
        "ticket_graph_corrupt",
        error instanceof Error ? error.message : String(error),
        { details: error }
      );
    }
    if (graph.tickets.length !== run.tickets.length) {
      throw new WorkflowError("ticket_graph_corrupt", "Ticket runtime count differs from immutable graph");
    }
    for (const state of run.tickets) {
      const definition = graph.tickets.find((ticket) => ticket.id === state.id);
      if (!definition) {
        throw new WorkflowError("ticket_graph_corrupt", `Unknown runtime ticket ${state.id}`);
      }
      if (!["pending", "ticket_completed"].includes(state.phase) && !state.checkpoint?.files) {
        throw new WorkflowError("ticket_graph_corrupt", `Ticket ${state.id} is missing its phase checkpoint`);
      }
      if (state.phase === "ticket_completed" && (
        state.verification?.status !== "passed"
        || state.scope?.status !== "passed"
        || state.review?.verdict !== "PASS"
        || (definition.tdd.policy === "required" && state.red?.status !== "passed")
      )) {
        throw new WorkflowError("ticket_graph_corrupt", `Completed ticket ${state.id} has invalid evidence`);
      }
      if (state.verification && (
        state.verification.total !== definition.verification.length
        || state.verification.commands.some(
          (result, index) => result.command !== definition.verification[index]?.command
        )
      )) {
        throw new WorkflowError("ticket_graph_corrupt", `Ticket ${state.id} verification identity is invalid`);
      }
    }
    return graph;
  }

  private async loadVerificationArtifact(
    run: WorkflowRun,
    label: string
  ): Promise<VerificationArtifact | undefined> {
    try {
      const raw = await fs.readFile(
        resolveRunArtifactPath(this.baseDir, run.id, `verification/${label}.json`),
        "utf-8"
      );
      const artifact = JSON.parse(raw) as VerificationArtifact;
      const expected = run.specPolicy?.verification.map((item) => item.command) ?? [];
      if (
        artifact.label !== label
        || !Array.isArray(artifact.commands)
        || artifact.commands.length !== expected.length
        || artifact.commands.some((result, index) => result.command !== expected[index])
        || artifact.commands.some((result) => result.status !== "passed" && result.status !== "failed")
      ) {
        return undefined;
      }
      return artifact;
    } catch {
      return undefined;
    }
  }

  private async runSpecVerification(
    run: WorkflowRun,
    label: string
  ): Promise<VerificationArtifact | undefined> {
    if (run.source !== "spec" || !run.specPolicy) return undefined;

    let artifact = await this.loadVerificationArtifact(run, label);
    if (!artifact) {
      await appendWorkflowEvent(this.baseDir, run.id, {
        event: "gate.verification.started",
        state: run.state,
        node: label,
        details: { label, commands: run.specPolicy.verification.map((item) => item.command) },
      });
      const commands: VerificationArtifact["commands"] = [];
      for (const requirement of run.specPolicy.verification) {
        try {
          commands.push(await this.verificationRunner.run({
            command: requirement.command,
            cwd: this.cwd,
          }));
        } catch (error) {
          throw new WorkflowError(
            "verification_failed",
            `Verification command could not produce a trustworthy result: ${requirement.command}`,
            { details: error }
          );
        }
      }
      const passed = commands.filter((result) => result.status === "passed").length;
      artifact = {
        label,
        status: passed === commands.length && commands.length > 0 ? "passed" : "failed",
        passed,
        total: commands.length,
        completedAt: new Date().toISOString(),
        commands,
      };
      await saveArtifact(this.baseDir, run.id, `verification/${label}.json`, artifact);
    }

    const aggregate: VerificationAggregate = {
      label: artifact.label,
      status: artifact.status,
      passed: artifact.passed,
      total: artifact.total,
      commands: artifact.commands.map((result) => ({
        command: result.command,
        status: result.status,
        exitCode: result.exitCode,
      })),
      completedAt: artifact.completedAt,
    };
    run.verification = aggregate;
    await saveWorkflowRun(this.baseDir, run);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "gate.verification",
      state: run.state,
      node: label,
      details: { ...aggregate },
    });
    return artifact;
  }

  private async runScopeGate(run: WorkflowRun, label: string): Promise<boolean> {
    const allowedChanges = run.specPolicy?.allowedChanges;
    if (run.source !== "spec" || !allowedChanges || !run.requirement) return true;

    await this.ensureSpecRequirement(run);
    let artifact;
    try {
      artifact = await compareRepositoryScope({
        cwd: this.cwd,
        baseline: run.baseline,
        allowedChanges,
        requirement: run.requirement,
        label,
      });
    } catch (error) {
      if (error instanceof ScopeComparisonError) {
        throw new WorkflowError("scope_check_failed", error.message, { details: error });
      }
      throw error;
    }
    await saveArtifact(this.baseDir, run.id, `scope/${label}.json`, artifact);
    const aggregate: ScopeAggregate = {
      label: artifact.label,
      status: artifact.status,
      changed: artifact.changed,
      outOfScope: artifact.outOfScope,
      completedAt: artifact.completedAt,
    };
    run.scopeGate = aggregate;
    await saveWorkflowRun(this.baseDir, run);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "gate.scope",
      state: run.state,
      node: label,
      details: { ...aggregate },
    });
    return artifact.status === "passed";
  }

  private async runTicketVerification(
    run: WorkflowRun,
    ticketId: string,
    commands: TicketGraph["tickets"][number]["verification"]
  ): Promise<VerificationAggregate> {
    const results: VerificationArtifact["commands"] = [];
    for (const requirement of commands) {
      try {
        results.push(await this.verificationRunner.run({
          command: requirement.command,
          cwd: this.cwd,
        }));
      } catch (error) {
        throw new WorkflowError(
          "verification_failed",
          `Ticket ${ticketId} verification could not execute ${requirement.command}`,
          { details: error }
        );
      }
    }
    const passed = results.filter((result) => result.status === "passed").length;
    const artifact: VerificationArtifact = {
      label: ticketId,
      status: passed === results.length && results.length > 0 ? "passed" : "failed",
      passed,
      total: results.length,
      completedAt: new Date().toISOString(),
      commands: results,
    };
    await saveArtifact(this.baseDir, run.id, `tickets/${ticketId}/green.json`, artifact);
    const aggregate: VerificationAggregate = {
      label: artifact.label,
      status: artifact.status,
      passed: artifact.passed,
      total: artifact.total,
      commands: artifact.commands.map((result) => ({
        command: result.command,
        status: result.status,
        exitCode: result.exitCode,
      })),
      completedAt: artifact.completedAt,
    };
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "ticket.green_completed",
      state: run.state,
      node: ticketId,
      details: { ticketId, ...aggregate },
    });
    return aggregate;
  }

  private async executeTicket(
    run: WorkflowRun,
    graph: TicketGraph,
    ticket: TicketGraph["tickets"][number],
    agents: AgentRoles
  ): Promise<WorkflowRun> {
    if (ticket.tdd.policy === "exempt" && ticket.kind === "behavioral") {
      throw new WorkflowError(
        "invalid_ticket_graph",
        `Behavioral ticket ${ticket.id} cannot use a TDD exemption`
      );
    }
    const index = run.tickets?.findIndex((state) => state.id === ticket.id) ?? -1;
    if (index < 0 || !run.tickets || !run.requirement) {
      throw new WorkflowError("ticket_graph_corrupt", `Missing runtime state for ticket ${ticket.id}`);
    }
    let state = run.tickets[index];
    const checkpoint = await captureRepositoryBaseline(this.cwd);
    state.checkpoint = checkpoint;
    run.activeTicketId = ticket.id;

    if (ticket.tdd.policy === "required") {
      state = transitionTicket(state, "red_authoring");
      run.tickets[index] = state;
      await saveWorkflowRun(this.baseDir, run);
      const redResult = await this.executor.execute({
        workflowRunId: run.id,
        nodeId: `ticket-${ticket.id}-red`,
        agent: agents.worker,
        task: [
          `Author the smallest failing behavioral test for immutable ticket ${ticket.id} in ticket-plan.json.`,
          `Requirement snapshot: ${requirementPromptForRun(run)?.snapshotPath}`,
          `Testing seam: ${ticket.testingSeam}`,
          `Red command: ${ticket.redCommand}`,
          "Do not implement production behavior. Return bounded expected failure evidence.",
        ].join("\n"),
        context: "fresh",
        cwd: this.cwd,
        schema: RED_AUTHORING_RESULT_SCHEMA,
        timeoutMs: 180_000,
      });
      if (redResult.status !== "completed") {
        throw new WorkflowError(
          redResult.status === "timed_out" ? "agent_budget_exhausted" : "invalid_red_evidence",
          redResult.error ?? `Red authoring failed for ${ticket.id}`
        );
      }
      const validatedRed = validateRedAuthoringResult(redResult.result);
      if (!validatedRed.ok) {
        throw new WorkflowError("invalid_red_evidence", validatedRed.error);
      }
      state = transitionTicket(state, "red_verification");
      const redScope = await compareRepositoryScope({
        cwd: this.cwd,
        baseline: checkpoint,
        allowedChanges: ticket.allowedChanges,
        requirement: run.requirement,
        label: `${ticket.id}-red`,
      });
      const changedTests = new Set(validatedRed.data.changedTestPaths);
      if (
        redScope.status !== "passed"
        || (!validatedRed.data.existingReproduction
          && (redScope.changed.length === 0 || redScope.changed.some((filePath) => !changedTests.has(filePath))))
      ) {
        throw new WorkflowError(
          "invalid_red_evidence",
          `Red phase for ${ticket.id} changed paths outside its declared test evidence`
        );
      }
      let execution;
      try {
        execution = await this.verificationRunner.run({
          command: ticket.redCommand!,
          cwd: this.cwd,
        });
      } catch (error) {
        throw new WorkflowError("invalid_red_evidence", `Red command infrastructure failed for ${ticket.id}`, {
          details: error,
        });
      }
      const output = `${execution.stdout}\n${execution.stderr}`;
      const invalidFailure = /syntax\s*error|cannot find module|module not found|missing dependenc|timed?\s*out/i.test(output);
      if (
        execution.status !== "failed"
        || execution.exitCode === 0
        || invalidFailure
        || !output.toLowerCase().includes(validatedRed.data.expectedFailure.toLowerCase())
      ) {
        throw new WorkflowError(
          "invalid_red_evidence",
          `Red command for ${ticket.id} did not fail for the bounded expected reason`
        );
      }
      state.red = {
        command: execution.command,
        exitCode: execution.exitCode,
        expectedFailure: validatedRed.data.expectedFailure,
        changedTestPaths: validatedRed.data.changedTestPaths,
        existingReproduction: validatedRed.data.existingReproduction,
        status: "passed",
      };
      await saveArtifact(this.baseDir, run.id, `tickets/${ticket.id}/red.json`, {
        ...state.red,
        execution,
      });
      await appendWorkflowEvent(this.baseDir, run.id, {
        event: "ticket.red_completed",
        state: run.state,
        node: ticket.id,
        details: { ticketId: ticket.id, ...state.red },
      });
    }

    state = transitionTicket(state, "implementing");
    run.tickets[index] = state;
    await saveWorkflowRun(this.baseDir, run);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "ticket.phase_changed",
      state: run.state,
      node: ticket.id,
      details: { ticketId: ticket.id, phase: state.phase, tdd: ticket.tdd.policy },
    });

    const plan: PlanResult = {
      summary: `${ticket.id}: ${ticket.title}`,
      understanding: `${ticket.capability}\nAcceptance: ${ticket.acceptanceCriteria.join("; ")}\nImmutable ticket: ticket-plan.json#${ticket.id}`,
      files: (ticket.allowedChanges ?? []).map((filePath) => ({
        path: filePath,
        purpose: `Allowed by ticket ${ticket.id}`,
        action: "modify" as const,
      })),
      steps: [{ id: "1", description: `Implement only ${ticket.id}: ${ticket.capability}` }],
      tests: ticket.verification.map((requirement) => ({
        command: requirement.command,
        description: requirement.command,
        required: true,
      })),
      risks: [],
      assumptions: ticket.tdd.policy === "exempt"
        ? [`TDD exemption: ${ticket.tdd.reason}`]
        : [`Engine-observed red evidence: ${state.red?.expectedFailure}`],
      complexity: "low",
      requiresSecondReviewer: false,
    };
    const implementationResult = await this.executor.execute<ImplementationResult>({
      workflowRunId: run.id,
      nodeId: `ticket-${ticket.id}-implement`,
      agent: agents.worker,
      task: buildWorkerPrompt({
        task: run.request,
        plan,
        requirement: requirementPromptForRun(run),
      }),
      context: "fresh",
      cwd: this.cwd,
      schema: IMPLEMENTATION_RESULT_SCHEMA,
      timeoutMs: 300_000,
    });
    if (implementationResult.status !== "completed") {
      throw new WorkflowError(
        implementationResult.status === "timed_out" ? "agent_budget_exhausted" : "agent_execution_failed",
        implementationResult.error ?? `Ticket ${ticket.id} implementation failed`
      );
    }
    const validatedImplementation = validateImplementationResult(implementationResult.result);
    if (!validatedImplementation.ok) {
      throw new WorkflowError("invalid_structured_output", validatedImplementation.error);
    }
    await saveArtifact(
      this.baseDir,
      run.id,
      `tickets/${ticket.id}/implementation.json`,
      validatedImplementation.data
    );

    state = transitionTicket(state, "green_verification");
    state.verification = await this.runTicketVerification(run, ticket.id, ticket.verification);
    if (state.verification.status !== "passed") {
      throw new WorkflowError(
        "ticket_verification_failed",
        `Ticket ${ticket.id} verification failed`
      );
    }
    const scopeArtifact = await compareRepositoryScope({
      cwd: this.cwd,
      baseline: checkpoint,
      allowedChanges: ticket.allowedChanges,
      requirement: run.requirement,
      label: ticket.id,
    });
    state.scope = {
      label: scopeArtifact.label,
      status: scopeArtifact.status,
      changed: scopeArtifact.changed,
      outOfScope: scopeArtifact.outOfScope,
      completedAt: scopeArtifact.completedAt,
    };
    await saveArtifact(this.baseDir, run.id, `tickets/${ticket.id}/scope.json`, scopeArtifact);
    if (scopeArtifact.status !== "passed") {
      throw new WorkflowError(
        "ticket_scope_violation",
        `Ticket ${ticket.id} changed out-of-scope paths: ${scopeArtifact.outOfScope.join(", ")}`
      );
    }

    state = transitionTicket(state, "ticket_review");
    run.tickets[index] = state;
    await saveWorkflowRun(this.baseDir, run);
    let reviewRound = 1;
    let latestFix: FixResult | undefined;
    let review = await this.runReviewer(
      run,
      agents,
      `ticket-${ticket.id}-review-${reviewRound}`,
      buildReviewerPrompt({
        task: run.request,
        plan,
        implementation: validatedImplementation.data,
        specialization: "general",
        round: reviewRound,
        requirement: requirementPromptForRun(run),
      }) + `\n\n## Deterministic Ticket Evidence\n${JSON.stringify({ red: state.red, green: state.verification, scope: state.scope })}`,
      `${ticket.id}-reviewer`,
      reviewRound
    );

    while (review.verdict !== "PASS") {
      state.review = review;
      state.reviewRound = reviewRound;
      if (reviewRound >= run.maxReviewRounds) {
        state = transitionTicket(state, "ticket_failed");
        run.tickets[index] = state;
        await saveWorkflowRun(this.baseDir, run);
        throw new WorkflowError(
          "ticket_review_budget_exhausted",
          `Ticket ${ticket.id} review still has findings after ${reviewRound} rounds`
        );
      }

      state = transitionTicket(state, "ticket_fix");
      state.fixRound++;
      run.tickets[index] = state;
      await saveWorkflowRun(this.baseDir, run);
      const fixResult = await this.executor.execute<FixResult>({
        workflowRunId: run.id,
        nodeId: `ticket-${ticket.id}-fix-${state.fixRound}`,
        agent: agents.worker,
        task: buildFixerPrompt({
          task: run.request,
          plan,
          findings: review.findings,
          round: state.fixRound,
          requirement: requirementPromptForRun(run),
        }),
        context: "fresh",
        cwd: this.cwd,
        schema: FIX_RESULT_SCHEMA,
        timeoutMs: 300_000,
      });
      if (fixResult.status !== "completed") {
        throw new WorkflowError(
          fixResult.status === "timed_out" ? "agent_budget_exhausted" : "agent_execution_failed",
          fixResult.error ?? `Ticket ${ticket.id} fixer failed`
        );
      }
      const validatedFix = validateFixResult(fixResult.result);
      if (!validatedFix.ok) {
        throw new WorkflowError("invalid_structured_output", validatedFix.error);
      }
      latestFix = validatedFix.data;
      await saveArtifact(
        this.baseDir,
        run.id,
        `tickets/${ticket.id}/fix-${state.fixRound}.json`,
        latestFix
      );

      state = transitionTicket(state, "green_verification");
      state.verification = await this.runTicketVerification(run, ticket.id, ticket.verification);
      if (state.verification.status !== "passed") {
        throw new WorkflowError("ticket_verification_failed", `Ticket ${ticket.id} verification failed after fix`);
      }
      const fixedScope = await compareRepositoryScope({
        cwd: this.cwd,
        baseline: checkpoint,
        allowedChanges: ticket.allowedChanges,
        requirement: run.requirement,
        label: `${ticket.id}-fix-${state.fixRound}`,
      });
      state.scope = {
        label: fixedScope.label,
        status: fixedScope.status,
        changed: fixedScope.changed,
        outOfScope: fixedScope.outOfScope,
        completedAt: fixedScope.completedAt,
      };
      await saveArtifact(this.baseDir, run.id, `tickets/${ticket.id}/scope-fix-${state.fixRound}.json`, fixedScope);
      if (fixedScope.status !== "passed") {
        throw new WorkflowError("ticket_scope_violation", `Ticket ${ticket.id} scope failed after fix`);
      }

      state = transitionTicket(state, "ticket_review");
      run.tickets[index] = state;
      await saveWorkflowRun(this.baseDir, run);
      reviewRound++;
      review = await this.runReviewer(
        run,
        agents,
        `ticket-${ticket.id}-review-${reviewRound}`,
        buildReviewerPrompt({
          task: run.request,
          plan,
          implementation: validatedImplementation.data,
          latestFix,
          previousFindings: state.review?.findings,
          specialization: "general",
          round: reviewRound,
          requirement: requirementPromptForRun(run),
        }) + `\n\n## Deterministic Ticket Evidence\n${JSON.stringify({ red: state.red, green: state.verification, scope: state.scope })}`,
        `${ticket.id}-reviewer`,
        reviewRound
      );
    }

    state.review = review;
    state.reviewRound = reviewRound;
    state = transitionTicket(state, "ticket_completed");
    state.completedCheckpoint = await captureRepositoryBaseline(this.cwd);
    run.tickets[index] = state;
    run.activeTicketId = undefined;
    await saveWorkflowRun(this.baseDir, run);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "ticket.completed",
      state: run.state,
      node: ticket.id,
      details: {
        ticketId: ticket.id,
        verification: state.verification,
        scope: state.scope,
        review: { verdict: review.verdict, confidence: review.confidence },
      },
    });
    return run;
  }

  private async executeTicketFrontier(run: WorkflowRun, agents: AgentRoles): Promise<WorkflowRun> {
    const graph = await loadFrozenTicketGraph(this.baseDir, run);
    while (run.state === "executing_tickets") {
      const frontier = selectTicketFrontier(graph, run.tickets ?? []);

      await appendWorkflowEvent(this.baseDir, run.id, {
        event: "ticket.frontier_computed",
        state: run.state,
        node: "ticket-frontier",
        details: { ready: frontier.map((ticket) => ticket.id) },
      });
      if (frontier.length === 0) {
        if (run.tickets?.every((ticket) => ticket.phase === "ticket_completed")) {
          run = await this.stateMachine.transition(run, "finalizing", {
            node: "final-gate",
            reason: "All tickets completed",
          });
          return await this.executeTicketFinalGate(run, graph, agents);
        }
        throw new WorkflowError("no_ready_frontier", "No ready ticket exists while work remains");
      }

      const ticket = frontier[0];
      await appendWorkflowEvent(this.baseDir, run.id, {
        event: "ticket.started",
        state: run.state,
        node: ticket.id,
        details: { ticketId: ticket.id },
      });
      try {
        run = await this.executeTicket(run, graph, ticket, agents);
      } catch (error) {
        const index = run.tickets?.findIndex((state) => state.id === ticket.id) ?? -1;
        if (index >= 0 && run.tickets) {
          run.tickets[index] = {
            ...run.tickets[index],
            phase: "ticket_failed",
          };
          run.activeTicketId = ticket.id;
          await saveWorkflowRun(this.baseDir, run);
          await appendWorkflowEvent(this.baseDir, run.id, {
            event: "ticket.failed",
            state: run.state,
            node: ticket.id,
            details: {
              ticketId: ticket.id,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        throw error;
      }
      const current = run.tickets?.find((state) => state.id === ticket.id);
      if (current?.phase !== "ticket_completed") return run;
    }
    return run;
  }
  private async executeTicketFinalGate(
    run: WorkflowRun,
    graph: TicketGraph,
    agents: AgentRoles
  ): Promise<WorkflowRun> {
    if (!run.requirement || !run.tickets) {
      throw new WorkflowError("ticket_graph_corrupt", "Final gate lacks requirement or ticket state");
    }
    const invalidTicket = run.tickets.find((ticket) =>
      ticket.phase !== "ticket_completed"
      || ticket.verification?.status !== "passed"
      || ticket.scope?.status !== "passed"
      || ticket.review?.verdict !== "PASS"
      || (graph.tickets.find((definition) => definition.id === ticket.id)?.tdd.policy === "required"
        && ticket.red?.status !== "passed")
    );
    const uncovered = Object.entries(graph.coverage).filter(([, owners]) => owners.length === 0);
    if (invalidTicket || uncovered.length > 0) {
      throw new WorkflowError(
        uncovered.length > 0 ? "requirement_coverage_gap" : "final_verification_failed",
        invalidTicket
          ? `Ticket ${invalidTicket.id} lacks complete deterministic evidence`
          : `Uncovered requirement criteria: ${uncovered.map(([criterion]) => criterion).join(", ")}`
      );
    }

    const commandByText = new Map<string, { command: string; required: true }>();
    for (const requirement of [
      ...graph.finalGate.verification,
      ...(run.specPolicy?.verification ?? []),
    ]) {
      commandByText.set(requirement.command, { command: requirement.command, required: true });
    }
    const finalCommands = [...commandByText.values()];
    const plan: PlanResult = {
      summary: "Final cross-ticket integration against the immutable specification",
      understanding: "Evaluate complete requirement coverage and cross-ticket behavior without reopening valid ticket history.",
      files: [],
      steps: [{ id: "1", description: "Verify the complete immutable specification" }],
      tests: finalCommands.map((requirement) => ({
        command: requirement.command,
        description: requirement.command,
        required: true,
      })),
      risks: [],
      assumptions: [],
      complexity: "high",
      requiresSecondReviewer: true,
    };

    for (let round = 1; round <= run.maxReviewRounds; round++) {
      const verification = await this.runTicketVerification(run, "final", finalCommands);
      run.verification = verification;
      const finalScope = await compareRepositoryScope({
        cwd: this.cwd,
        baseline: run.baseline,
        allowedChanges: run.specPolicy?.allowedChanges,
        requirement: run.requirement,
        label: `final-${round}`,
      });
      run.scopeGate = {
        label: finalScope.label,
        status: finalScope.status,
        changed: finalScope.changed,
        outOfScope: finalScope.outOfScope,
        completedAt: finalScope.completedAt,
      };
      await saveArtifact(this.baseDir, run.id, `final/scope-${round}.json`, finalScope);

      let review: ReviewResult | undefined;
      if (verification.status === "passed" && finalScope.status === "passed") {
        const coverageSummary = Object.entries(graph.coverage).map(
          ([criterion, owners]) => `${criterion}: ${owners.join(", ")}`
        );
        review = await this.runReviewer(
          run,
          agents,
          `ticket-final-review-${round}`,
          buildReviewerPrompt({
            task: run.request,
            plan,
            specialization: "final",
            round,
            requirement: requirementPromptForRun(run),
          }) + `\n\n## Coverage Matrix\n${coverageSummary.join("\n")}\n\n## Ticket Outcomes\n${JSON.stringify(run.tickets.map((ticket) => ({ id: ticket.id, verification: ticket.verification?.status, scope: ticket.scope?.status, review: ticket.review?.verdict })))}`,
          "ticket-final-reviewer",
          round
        );
      }

      if (verification.status === "passed" && finalScope.status === "passed" && review?.verdict === "PASS") {
        run.reviews.push(review);
        run.finalGateStatus = "passed";
        await saveArtifact(this.baseDir, run.id, "final/ticket-gate.json", {
          coverage: graph.coverage,
          verification,
          scope: run.scopeGate,
          review: { verdict: review.verdict, confidence: review.confidence },
        });
        await saveWorkflowRun(this.baseDir, run);
        await appendWorkflowEvent(this.baseDir, run.id, {
          event: "ticket.final_completed",
          state: run.state,
          node: "final-gate",
          details: {
            verification,
            scope: run.scopeGate,
            review: { verdict: review.verdict, confidence: review.confidence },
          },
        });
        const completed = await this.stateMachine.transition(run, "completed", {
          node: "final-gate",
          reason: "Ticket coverage, final verification, scope, and review passed",
        });
        await this.releaseRunLock(completed.id);
        return completed;
      }

      if (round === run.maxReviewRounds) {
        run.finalGateStatus = "failed";
        await saveWorkflowRun(this.baseDir, run);
        throw new WorkflowError(
          review?.verdict === "REQUEST_CHANGES"
            ? "final_review_budget_exhausted"
            : "final_verification_failed",
          `Final ticket gate did not pass after ${round} round(s)`
        );
      }

      const fixResult = await this.executor.execute<FixResult>({
        workflowRunId: run.id,
        nodeId: `ticket-final-fix-${round}`,
        agent: agents.worker,
        task: buildFixerPrompt({
          task: run.request,
          plan,
          findings: review?.findings ?? [],
          failedTests: verification.commands
            .filter((result) => result.status === "failed")
            .map((result) => ({
              command: result.command,
              status: "failed" as const,
              summary: `exit ${result.exitCode}`,
              exitCode: result.exitCode,
            })),
          outOfScopePaths: finalScope.outOfScope,
          round,
          requirement: requirementPromptForRun(run),
        }),
        context: "fresh",
        cwd: this.cwd,
        schema: FIX_RESULT_SCHEMA,
        timeoutMs: 300_000,
      });
      if (fixResult.status !== "completed") {
        throw new WorkflowError(
          fixResult.status === "timed_out" ? "agent_budget_exhausted" : "agent_execution_failed",
          fixResult.error ?? "Final integration fixer failed"
        );
      }
      const validated = validateFixResult(fixResult.result);
      if (!validated.ok) throw new WorkflowError("invalid_structured_output", validated.error);
      await saveArtifact(this.baseDir, run.id, `final/fix-${round}.json`, validated.data);
    }
    throw new WorkflowError("final_verification_failed", "Final ticket gate ended without evidence");
  }

  /**
   * Scout (when the mode requires it before planning and no artifact exists)
   * → plan → finalize auto routing. Shared by startPlan and resume.
   * Throws WorkflowError on node failure; the caller marks the run failed.
   */
  private async runPlanningPhase(run: WorkflowRun, agents: AgentRoles): Promise<WorkflowRun> {
    let scoutResult = await this.loadScoutArtifact(run.id);
    if (!scoutResult && !run.autoRouted && run.mode !== "quick") {
      const outcome = await this.executeScoutNode(run, agents);
      run = outcome.run;
      scoutResult = outcome.scoutResult;
    }

    run = await this.executePlanNode(run, { scout: scoutResult, agents });
    run = await this.finalizeAutoRouting(run, agents);
    return run;
  }

  /**
   * Audit Finding 6 (§24/§25): finalize auto-routed runs after planning.
   * - quick       → maxReviewRounds = 2, no scout
   * - normal/strict → run the (post-plan) scout now; its output feeds the worker
   *
   * Idempotent: guarded by the persisted modeResolved flag so resume never
   * re-resolves or re-scouts.
   */
  private async finalizeAutoRouting(run: WorkflowRun, agents: AgentRoles): Promise<WorkflowRun> {
    if (!run.autoRouted || run.modeResolved || !run.plan) {
      return run;
    }

    run.mode = resolveWorkflowMode(run.plan, undefined);

    if (run.mode === "quick") {
      run.maxReviewRounds = 2;
    } else {
      const outcome = await this.executeScoutNode(run, agents, { transition: false });
      run = outcome.run;
    }

    run.modeResolved = true;
    run.updatedAt = new Date().toISOString();
    await saveWorkflowRun(this.baseDir, run);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "mode.resolved",
      state: run.state,
      details: { mode: run.mode, maxReviewRounds: run.maxReviewRounds, autoRouted: true },
    });

    return run;
  }

  // --- Workflow Node Executors ---

  /**
   * Forwards one agent progress update as a node_update progress event and
   * records the streaming token estimate. Shared by every node executor's
   * request factory (previously repeated inline per node).
   */
  private forwardNodeProgress(
    run: WorkflowRun,
    nodeId: string,
    agent: string,
    action: string,
    startedAt: number,
    tokenTracker: NodeTokenTracker,
    update: AgentProgressUpdate
  ): void {
    if (update.tokens) {
      tokenTracker.tokens = update.tokens;
    }
    this.onProgress?.({
      type: "node_update",
      run,
      nodeId,
      agent,
      action,
      durationMs: update.durationMs ?? (Date.now() - startedAt),
      tokens: update.tokens,
      details: {
        currentTool: update.currentTool,
        currentToolArgs: update.currentToolArgs,
        recentOutput: update.recentOutput,
      },
    });
  }

  async executeScoutNode(
    run: WorkflowRun,
    agents: AgentRoles,
    options?: { transition?: boolean }
  ): Promise<{ run: WorkflowRun; scoutResult: ScoutResult }> {
    // The post-plan scout (auto-routed normal/strict, audit Finding 6) runs
    // between plan_ready and implementing; there is no "scouting" state for
    // it, so it executes without a state transition.
    if (options?.transition !== false) {
      run = await this.stateMachine.transition(run, "scouting", {
        node: "scout",
        reason: "Starting repository scouting",
      });
    }

    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "node.started",
      state: run.state,
      node: "scout",
    });

    const startTime = Date.now();
    const tokenTracker: NodeTokenTracker = {};

    this.onProgress?.({
      type: "node_start",
      run,
      nodeId: "scout",
      agent: agents.scout,
      action: "Exploring repository structure...",
    });

    const taskPrompt = buildScoutPrompt({ task: run.request });
    const scoutData = await executeNodeWithRetry<ScoutResult>({
      nodeId: "scout",
      nodeLabel: "Scout node",
      taskPrompt,
      requestFactory: (prompt) => ({
        workflowRunId: run.id,
        nodeId: "scout",
        agent: agents.scout,
        task: prompt,
        context: "fresh",
        cwd: this.cwd,
        schema: SCOUT_RESULT_SCHEMA,
        onUpdate: (up) =>
          this.forwardNodeProgress(
            run,
            "scout",
            agents.scout,
            "Exploring repository structure...",
            startTime,
            tokenTracker,
            up
          ),
      }),
      executor: this.executor,
      retryPolicy: this.retryPolicy,
      sleep: this.sleep,
      tokenTracker,
      schemaDescription: "ScoutResult",
      terminalErrorDetail: "No result returned",
      validate: (result) => {
        const validation = validateScoutResult(result);
        return validation.ok
          ? { ok: true, data: validation.data }
          : {
              ok: false,
              validationError: validation.error,
              terminalMessage: `Scout node returned an invalid result: ${validation.error}`,
            };
      },
      fallbackMessage: "Scout node produced no valid result",
    });

    await saveArtifact(this.baseDir, run.id, "scout.json", scoutData);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "node.completed",
      state: run.state,
      node: "scout",
    });

    this.onProgress?.({
      type: "node_end",
      run,
      nodeId: "scout",
      agent: agents.scout,
      action: `Scouted repository (${scoutData.relevantFiles.length} key file(s) identified)`,
      durationMs: Date.now() - startTime,
      tokens: tokenTracker.tokens,
      details: { relevantFiles: scoutData.relevantFiles },
    });

    return { run, scoutResult: scoutData };
  }

  async executePlanNode(
    run: WorkflowRun,
    options: { scout?: ScoutResult; agents: AgentRoles }
  ): Promise<WorkflowRun> {
    const { scout, agents } = options;

    run = await this.stateMachine.transition(run, "planning", {
      node: "plan",
      reason: "Starting workflow planning",
    });

    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "node.started",
      state: run.state,
      node: "plan",
    });

    const startTime = Date.now();
    const tokenTracker: NodeTokenTracker = {};

    this.onProgress?.({
      type: "node_start",
      run,
      nodeId: "plan",
      agent: agents.planner,
      action: "Formulating implementation plan...",
    });

    const taskPrompt = buildPlannerPrompt({ task: run.request, scout });
    // The planner uses "fork" (spec §8) and degrades to "fresh" when the
    // parent session is not yet persisted (audit Finding 1).
    let context: "fresh" | "fork" = "fork";

    const planData = await executeNodeWithRetry<PlanResult>({
      nodeId: "plan",
      nodeLabel: "Planner node",
      taskPrompt,
      requestFactory: (prompt) => ({
        workflowRunId: run.id,
        nodeId: "plan",
        agent: agents.planner,
        task: prompt,
        context,
        cwd: this.cwd,
        schema: PLAN_RESULT_SCHEMA,
        onUpdate: (up) =>
          this.forwardNodeProgress(
            run,
            "plan",
            agents.planner,
            "Formulating implementation plan...",
            startTime,
            tokenTracker,
            up
          ),
      }),
      executor: this.executor,
      retryPolicy: this.retryPolicy,
      sleep: this.sleep,
      tokenTracker,
      validate: (result) => {
        const gate = evaluatePlanGate(result);
        if (gate.pass && gate.plan) {
          return { ok: true, data: gate.plan };
        }
        return {
          ok: false,
          validationError: gate.error ?? "Invalid plan structure",
          terminalMessage: gate.error ?? "Plan gate validation failed",
        };
      },
      onExecutionFailure: async (execError) => {
        if (context === "fork" && isForkUnavailableError(execError)) {
          // A deterministic fork-unavailability is NOT an agent failure:
          // degrade to a fresh context without consuming the agent retry
          // budget (the planner prompt is self-contained, so fresh execution
          // remains correct).
          context = "fresh";
          await appendWorkflowEvent(this.baseDir, run.id, {
            event: "planner.fork_unavailable",
            state: run.state,
            node: "plan",
            details: { reason: execError },
          });
          return true;
        }
        return false;
      },
      fallbackMessage: "Plan generation failed",
    });

    run.plan = planData;
    run.complexity = planData.complexity;

    // Note: auto mode routing (audit Finding 6) is finalized by the caller
    // in finalizeAutoRouting, where the user's explicit-mode intent is known.

    await saveArtifact(this.baseDir, run.id, "plan.json", planData);
    await saveArtifact(this.baseDir, run.id, "request.md", run.request);

    run = await this.stateMachine.transition(run, "plan_ready", {
      node: "plan",
      reason: "Plan completed and validated",
    });

    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "node.completed",
      state: run.state,
      node: "plan",
    });

    this.onProgress?.({
      type: "node_end",
      run,
      nodeId: "plan",
      agent: agents.planner,
      action: `Plan approved (${planData.steps.length} step(s), ${planData.complexity} complexity)`,
      durationMs: Date.now() - startTime,
      tokens: tokenTracker.tokens,
      details: { steps: planData.steps.length, files: planData.files.length, complexity: planData.complexity },
    });

    return run;
  }

  async executeWorkerNode(run: WorkflowRun, agents: AgentRoles): Promise<WorkflowRun> {
    if (!run.plan) {
      throw new WorkflowError("invalid_transition", "Cannot execute worker without an approved plan");
    }
    const approvedPlan = run.plan;

    run = await this.stateMachine.transition(run, "implementing", {
      node: "implement",
      reason: "Starting implementation",
    });

    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "node.started",
      state: run.state,
      node: "implement",
    });

    const startTime = Date.now();
    const tokenTracker: NodeTokenTracker = {};

    this.onProgress?.({
      type: "node_start",
      run,
      nodeId: "implement",
      agent: agents.worker,
      action: "Executing implementation changes...",
    });

    const scout = await this.loadScoutArtifact(run.id);
    const taskPrompt = buildWorkerPrompt({
      task: run.request,
      plan: approvedPlan,
      scout,
      requirement: requirementPromptForRun(run),
    });
    const implData = await executeNodeWithRetry<ImplementationResult>({
      nodeId: "implement",
      nodeLabel: "Worker node",
      taskPrompt,
      requestFactory: (prompt) => ({
        workflowRunId: run.id,
        nodeId: "implement",
        agent: agents.worker,
        task: prompt,
        context: "fresh",
        cwd: this.cwd,
        schema: IMPLEMENTATION_RESULT_SCHEMA,
        onUpdate: (up) =>
          this.forwardNodeProgress(
            run,
            "implement",
            agents.worker,
            "Executing implementation changes...",
            startTime,
            tokenTracker,
            up
          ),
      }),
      executor: this.executor,
      retryPolicy: this.retryPolicy,
      sleep: this.sleep,
      tokenTracker,
      schemaDescription: "ImplementationResult",
      executionErrorDefault: "Worker execution failed",
      terminalErrorDetail: "Unknown error",
      validate: (result) => {
        const validation = validateImplementationResult(result);
        return validation.ok
          ? { ok: true, data: validation.data }
          : {
              ok: false,
              validationError: validation.error,
              terminalMessage: `Worker returned an invalid result: ${validation.error}`,
            };
      },
      onExecutionFailure: (execError) => {
        // Audit Finding 14: a zero-edit completion is a deterministic refusal
        // (or laziness) — a verbatim retry repeats it, so fail immediately.
        if (isWorkerRefusalError(execError)) {
          throw new WorkflowError("agent_execution_failed", wrapWorkerRefusal("Worker", execError), {
            nodeId: "implement",
          });
        }
        return false;
      },
      fallbackMessage: "Worker produced no valid result",
    });

    run = await this.settleImplementation(run, implData);

    const passedTests = implData.tests.filter((t) => t.status === "passed").length;
    const totalTests = implData.tests.length;
    const deterministicGateStatus = run.source === "spec"
      ? (run.verification?.status === "passed" ? "PASS" : "FIX_REQUIRED")
      : evaluateTestGate(implData.tests, approvedPlan.tests).status;

    this.onProgress?.({
      type: "node_end",
      run,
      nodeId: "implement",
      agent: agents.worker,
      action: `Implementation completed (${implData.changedFiles.length} file(s) changed, ${passedTests}/${totalTests} tests passed)`,
      durationMs: Date.now() - startTime,
      tokens: tokenTracker.tokens,
      details: {
        changedFiles: implData.changedFiles.map((f) => f.path),
        passedTests,
        totalTests,
        testGateStatus: deterministicGateStatus,
      },
    });

    return run;
  }

  /**
   * Persist a completed implementation result and settle the test gate.
   * Shared by the normal worker path and the resume path that re-hydrates
   * a result persisted before an interruption (post-remediation review M2).
   */
  private async settleImplementation(run: WorkflowRun, implData: ImplementationResult): Promise<WorkflowRun> {
    const plan = run.plan;
    if (!plan) {
      throw new WorkflowError("invalid_transition", "Cannot settle implementation without an approved plan");
    }

    run.implementation = implData;
    await saveArtifact(this.baseDir, run.id, "implementation.json", implData);

    run = await this.stateMachine.transition(run, "testing", {
      node: "implement",
      reason: "Implementation finished, evaluating test gate",
    });

    if (run.source === "spec") {
      const scopePassed = await this.runScopeGate(run, "implementation");
      if (!scopePassed) {
        run = await this.stateMachine.transition(run, "fixing", {
          node: "implement",
          reason: `Repository scope violation: ${run.scopeGate?.outOfScope.join(", ")}`,
        });
      } else {
        const verification = await this.runSpecVerification(run, "implementation");
        if (verification?.status === "failed") {
          run = await this.stateMachine.transition(run, "fixing", {
            node: "implement",
            reason: "Engine verification failed after implementation",
          });
        }
      }
    } else {
      const testGate = evaluateTestGate(implData.tests, plan.tests);
      await appendWorkflowEvent(this.baseDir, run.id, {
        event: "gate.test",
        state: run.state,
        details: { status: testGate.status, reason: testGate.reason },
      });
      if (testGate.status === "FIX_REQUIRED") {
        run = await this.stateMachine.transition(run, "fixing", {
          node: "implement",
          reason: `Test gate requires fixes: ${testGate.reason}`,
        });
      }
    }

    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "node.completed",
      state: run.state,
      node: "implement",
    });

    return run;
  }

  /**
   * Execute one reviewer (or specialized reviewer) with fresh context,
   * schema validation (audit Finding 4), and one retry on a malformed
   * structured result.
   */
  private async runReviewer(
    run: WorkflowRun,
    agents: AgentRoles,
    nodeId: string,
    prompt: string,
    reviewerId: string,
    round: number
  ): Promise<ReviewResult> {
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "node.started",
      state: run.state,
      node: nodeId,
    });

    const startTime = Date.now();
    const tokenTracker: NodeTokenTracker = {};

    this.onProgress?.({
      type: "node_start",
      run,
      nodeId,
      agent: agents.reviewer,
      action: `Independent review in progress (${reviewerId}, fresh context)...`,
    });

    const reviewData = await executeNodeWithRetry<ReviewResult>({
      nodeId,
      nodeLabel: `Reviewer ${nodeId}`,
      taskPrompt: prompt,
      requestFactory: (currentPrompt) =>
        createReviewerExecutionRequest<ReviewResult>({
          workflowRunId: run.id,
          nodeId,
          agent: agents.reviewer,
          task: currentPrompt,
          cwd: this.cwd,
          schema: REVIEW_RESULT_SCHEMA,
          timeoutMs: 180_000,
          onUpdate: (up) =>
            this.forwardNodeProgress(
              run,
              nodeId,
              agents.reviewer,
              `Reviewing diff (${reviewerId})...`,
              startTime,
              tokenTracker,
              up
            ),
        }),
      executor: this.executor,
      retryPolicy: this.retryPolicy,
      sleep: this.sleep,
      tokenTracker,
      schemaDescription: "ReviewResult",
      executionErrorDefault: "Reviewer execution failed",
      terminalErrorDetail: "No result",
      validate: (result) => {
        const validation = validateReviewResult(result);
        return validation.ok
          ? { ok: true, data: validation.data }
          : {
              ok: false,
              validationError: validation.error,
              terminalMessage: `Reviewer ${nodeId} returned an invalid result: ${validation.error}`,
            };
      },
      onValidated: async (data) => {
        data.reviewerId = reviewerId;
        data.round = round;
        await appendWorkflowEvent(this.baseDir, run.id, {
          event: "node.completed",
          state: run.state,
          node: nodeId,
        });
      },
      fallbackMessage: `Reviewer ${nodeId} produced no valid result`,
    });

    const isPass = reviewData.verdict === "PASS";
    const findingsCount = reviewData.findings.length;
    this.onProgress?.({
      type: "node_end",
      run,
      nodeId,
      agent: agents.reviewer,
      action: isPass
        ? `Verdict: PASS (0 findings, round ${round})`
        : `Verdict: REQUEST_CHANGES (${findingsCount} finding(s), round ${round})`,
      durationMs: Date.now() - startTime,
      tokens: tokenTracker.tokens,
      details: {
        verdict: reviewData.verdict,
        findings: findingsCount,
        findingList: reviewData.findings,
        round,
        reviewerId,
      },
    });

    return reviewData;
  }

  async executeReviewNode(run: WorkflowRun, agents: AgentRoles): Promise<WorkflowRun> {
    if (!run.plan) {
      throw new WorkflowError("invalid_transition", "Cannot review without an approved plan");
    }
    const approvedPlan = run.plan;

    // Review rounds are numbered from the persisted review history, NOT from
    // a counter the fix node advances: a test-gate-driven fix (audit
    // Finding 3) must not consume a review round.
    const persistedRounds = run.reviews.map((r) => r.round ?? 1);
    const currentRound = persistedRounds.length > 0 ? Math.max(...persistedRounds) + 1 : 1;
    const nodeId = `review-${currentRound}`;

    run = await this.stateMachine.transition(run, "reviewing", {
      node: nodeId,
      reason: `Starting review round ${currentRound}`,
    });

    run.reviewRound = currentRound;

    const latestFix = run.fixes.length > 0 ? run.fixes[run.fixes.length - 1] : undefined;
    const previousFindings: ReviewFinding[] =
      run.reviews.length > 0 ? run.reviews[run.reviews.length - 1].findings : [];

    const reviewerSpecs: Array<{ nodeId: string; specialization: ReviewerSpecialization; reviewerId: string }> =
      run.mode === "strict"
        ? [
            { nodeId: `${nodeId}-a`, specialization: "correctness", reviewerId: "reviewer-a" },
            { nodeId: `${nodeId}-b`, specialization: "quality_and_tests", reviewerId: "reviewer-b" },
          ]
        : [{ nodeId, specialization: "general", reviewerId: "reviewer-1" }];

    const reviewsForThisRound: ReviewResult[] = [];
    for (const spec of reviewerSpecs) {
      const prompt = buildReviewerPrompt({
        task: run.request,
        plan: approvedPlan,
        implementation: run.implementation,
        latestFix,
        previousFindings,
        specialization: spec.specialization,
        round: currentRound,
        requirement: requirementPromptForRun(run),
      });
      const result = await this.runReviewer(run, agents, spec.nodeId, prompt, spec.reviewerId, currentRound);
      reviewsForThisRound.push(result);
    }

    let hasRejections = reviewsForThisRound.some((r) => r.verdict === "REQUEST_CHANGES");

    // Audit Finding 5 (§24/§35): strict mode runs one final fresh reviewer
    // that independently verifies the end state (and previously reported
    // findings) before the workflow may complete.
    if (run.mode === "strict" && !hasRejections) {
      const finalNodeId = `${nodeId}-final`;
      const finalPreviousFindings = [
        ...run.reviews.flatMap((r) => r.findings),
        ...reviewsForThisRound.flatMap((r) => r.findings),
      ];
      const finalPrompt = buildReviewerPrompt({
        task: run.request,
        plan: approvedPlan,
        implementation: run.implementation,
        latestFix,
        previousFindings: finalPreviousFindings,
        specialization: "final",
        round: currentRound,
        requirement: requirementPromptForRun(run),
      });
      const finalResult = await this.runReviewer(run, agents, finalNodeId, finalPrompt, "reviewer-final", currentRound);
      reviewsForThisRound.push(finalResult);
      if (finalResult.verdict === "REQUEST_CHANGES") {
        hasRejections = true;
      }
    }

    run.reviews.push(...reviewsForThisRound);
    await saveArtifact(this.baseDir, run.id, `reviews/review-${currentRound}.json`, reviewsForThisRound);

    // §22: use structured verdicts and gates, never prose inference.
    const completionGate = evaluateCompletionGate(run);

    if (!hasRejections && completionGate.canComplete) {
      run = await this.stateMachine.transition(run, "completed", {
        node: nodeId,
        reason: "Review PASS, completion gate satisfied",
      });
      await saveArtifact(this.baseDir, run.id, "final.json", {
        status: "completed",
        completedAt: new Date().toISOString(),
        reviewRounds: run.reviewRound,
      });
      await this.releaseRunLock(run.id);
      return run;
    }

    // Audit Finding 3: the review budget is exhausted only when a reviewer
    // actually requested changes (in strict mode, any reviewer A/B rejection
    // counts). A PASS with an unsatisfied completion gate (e.g. required
    // tests still failing) is a test failure, not a review failure — and
    // still routes to fixing.
    if (run.reviewRound >= run.maxReviewRounds) {
      const error: WorkflowErrorDetails = hasRejections
        ? {
            code: "review_budget_exhausted",
            message: `Reviewer requested changes after ${run.reviewRound} rounds.`,
            nodeId,
          }
        : {
            code: "required_tests_failed",
            message: `Required tests are still failing after ${run.reviewRound} review round(s): ${completionGate.reasons.join("; ")}`,
            nodeId,
          };
      run = await this.stateMachine.transition(run, "failed", {
        node: nodeId,
        reason: error.message,
        error,
      });
      await this.releaseRunLock(run.id);
      return run;
    }

    run = await this.stateMachine.transition(run, "fixing", {
      node: nodeId,
      reason: hasRejections
        ? "Reviewer requested changes; transition to fixing"
        : `Reviewers passed but completion gate not satisfied (${completionGate.reasons.join("; ")}); routing to fixing`,
    });

    return run;
  }

  async executeFixNode(run: WorkflowRun, agents: AgentRoles): Promise<WorkflowRun> {
    if (!run.plan) {
      throw new WorkflowError("invalid_transition", "Cannot fix without an approved plan");
    }
    const approvedPlan = run.plan;
    if (
      run.source === "spec"
      && run.verification?.status === "failed"
      && run.fixes.length >= run.maxReviewRounds
    ) {
      const message = `Required verification still fails after ${run.fixes.length} fix round(s)`;
      run = await this.stateMachine.transition(run, "failed", {
        node: `fix-${run.fixes.length + 1}`,
        reason: message,
        error: {
          code: "required_tests_failed",
          message,
          nodeId: `fix-${run.fixes.length + 1}`,
        },
      });
      await this.releaseRunLock(run.id);
      return run;
    }

    // Fix rounds have their own counter: a fix is a fix, whether it was
    // driven by review findings or by the test gate (audit Finding 3).
    const fixRound = run.fixes.length + 1;
    const nodeId = `fix-${fixRound}`;

    if (run.state !== "fixing") {
      run = await this.stateMachine.transition(run, "fixing", {
        node: nodeId,
        reason: `Starting fix round ${fixRound}`,
      });
    }

    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "node.started",
      state: run.state,
      node: nodeId,
    });

    const startTime = Date.now();
    const tokenTracker: NodeTokenTracker = {};

    this.onProgress?.({
      type: "node_start",
      run,
      nodeId,
      agent: agents.worker,
      action: `Fixing review findings (round ${fixRound})...`,
    });

    // Collect findings from the most recent round that requested changes.
    // For test-gate-driven fixes this is empty; the failed tests are the
    // corrective input instead.
    const rejectingRounds = run.reviews
      .filter((r) => r.verdict === "REQUEST_CHANGES")
      .map((r) => r.round ?? 1);
    const findingsRound = rejectingRounds.length > 0 ? Math.max(...rejectingRounds) : undefined;
    const findings: ReviewFinding[] =
      findingsRound !== undefined
        ? run.reviews.filter((r) => (r.round ?? 1) === findingsRound).flatMap((r) => r.findings)
        : [];

    const latestTests =
      run.fixes.length > 0
        ? run.fixes[run.fixes.length - 1].tests
        : run.implementation?.tests ?? [];
    const failedTests = latestTests.filter((test) => test.status === "failed");
    const latestVerification = run.verification
      ? await this.loadVerificationArtifact(run, run.verification.label)
      : undefined;
    const verificationFailures = latestVerification?.commands.filter(
      (result) => result.status === "failed"
    );

    const taskPrompt = buildFixerPrompt({
      task: run.request,
      plan: approvedPlan,
      findings,
      failedTests,
      verificationFailures,
      outOfScopePaths: run.scopeGate?.outOfScope,
      round: fixRound,
      requirement: requirementPromptForRun(run),
    });

    const fixData = await executeNodeWithRetry<FixResult>({
      nodeId,
      nodeLabel: "Fix worker",
      taskPrompt,
      requestFactory: (prompt) => ({
        workflowRunId: run.id,
        nodeId,
        agent: agents.worker,
        task: prompt,
        context: "fresh",
        cwd: this.cwd,
        schema: FIX_RESULT_SCHEMA,
        onUpdate: (up) =>
          this.forwardNodeProgress(
            run,
            nodeId,
            agents.worker,
            `Fixing review findings (round ${fixRound})...`,
            startTime,
            tokenTracker,
            up
          ),
      }),
      executor: this.executor,
      retryPolicy: this.retryPolicy,
      sleep: this.sleep,
      tokenTracker,
      schemaDescription: "FixResult",
      executionErrorDefault: "Fix worker execution failed",
      terminalErrorDetail: "No result",
      validate: (result) => {
        const validation = validateFixResult(result);
        return validation.ok
          ? { ok: true, data: validation.data }
          : {
              ok: false,
              validationError: validation.error,
              terminalMessage: `Fix worker returned an invalid result: ${validation.error}`,
            };
      },
      onExecutionFailure: (execError) => {
        // Audit Finding 14: a zero-edit completion is a deterministic refusal
        // (or laziness) — a verbatim retry repeats it, so fail immediately.
        if (isWorkerRefusalError(execError)) {
          throw new WorkflowError("agent_execution_failed", wrapWorkerRefusal("Fix worker", execError), {
            nodeId,
          });
        }
        return false;
      },
      fallbackMessage: "Fix worker produced no valid result",
    });

    fixData.round = fixRound;
    const settledRun = await this.settleFix(run, fixData, nodeId, fixRound);

    const passedTests = fixData.tests.filter((t) => t.status === "passed").length;
    const fixFailedTests = fixData.tests.filter((t) => t.status === "failed").length;
    const totalTests = fixData.tests.length;

    this.onProgress?.({
      type: "node_end",
      run: settledRun,
      nodeId,
      agent: agents.worker,
      action: `Fix round ${fixRound} completed (${fixData.changedFiles.length} file(s) modified, ${passedTests}/${totalTests} tests passed)`,
      durationMs: Date.now() - startTime,
      tokens: tokenTracker.tokens,
      details: {
        changedFiles: fixData.changedFiles.map((f) => f.path),
        addressedFindings: fixData.addressedFindings,
        passedTests,
        failedTests: fixFailedTests,
        totalTests,
      },
    });

    return settledRun;
  }

  /**
   * Persist a completed fix result and transition to testing. Shared by the
   * normal fix path and the resume path that re-hydrates a fix persisted
   * before an interruption (post-remediation review M2).
   */
  private async settleFix(run: WorkflowRun, fixData: FixResult, nodeId: string, fixRound: number): Promise<WorkflowRun> {
    if (!run.fixes.some((f) => f.round === fixRound)) {
      run.fixes.push(fixData);
    }
    await saveArtifact(this.baseDir, run.id, `fixes/fix-${fixRound}.json`, fixData);

    // Note: review rounds are numbered by the review node from the persisted
    // review history; the fix node must not advance run.reviewRound (audit
    // Finding 3: test-gate-driven fixes do not consume a review round).

    run = await this.stateMachine.transition(run, "testing", {
      node: nodeId,
      reason: `Fix round ${fixRound} completed; ready for regression testing/review`,
    });

    if (run.source === "spec") {
      const scopePassed = await this.runScopeGate(run, `fix-${fixRound}`);
      if (!scopePassed) {
        run = await this.stateMachine.transition(run, "fixing", {
          node: nodeId,
          reason: `Repository scope violation after fix round ${fixRound}: ${run.scopeGate?.outOfScope.join(", ")}`,
        });
      } else {
        const verification = await this.runSpecVerification(run, `fix-${fixRound}`);
        if (verification?.status === "failed") {
          run = await this.stateMachine.transition(run, "fixing", {
            node: nodeId,
            reason: `Engine verification failed after fix round ${fixRound}`,
          });
        }
      }
    }

    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "node.completed",
      state: run.state,
      node: nodeId,
    });

    return run;
  }

  // --- High-Level User Commands ---

  /**
   * Preflight → create run → scout (when the mode requires it) → plan →
   * finalize auto routing. Shared by /work plan and /work auto.
   *
   * `autoRoute` is true only for /work auto (§25): the planner launches
   * first and the mode is resolved from the plan's complexity afterwards.
   * /work plan keeps explicit-mode semantics: the mode is the flag or
   * defaultMode, and normal/strict scout before planning (§26).
   */
  private async planPhase(
    request: string,
    options?: { mode?: WorkflowMode; autoRoute?: boolean; source?: "auto" | "plan" }
  ): Promise<{ run: WorkflowRun; agents: AgentRoles }> {
    const explicitMode = options?.mode;
    const autoRouted = (options?.autoRoute ?? false) && explicitMode === undefined;
    const initialMode = explicitMode ?? this.config.defaultMode;

    // One preflight, before the run exists (fail before modifications, §29).
    // The resolved mapping serves the whole run — no second preflight later.
    const agents = await this.preflightForRun({
      mode: initialMode,
      source: options?.source ?? "plan",
    });

    const run = await this.createRun(request, initialMode, autoRouted, {
      source: options?.source ?? "plan",
    });

    try {
      return { run: await this.runPlanningPhase(run, agents), agents };
    } catch (error) {
      // Audit Finding 2: persist the failure, release the lock, and return
      // the failed run so the command layer renders the exact failure.
      return { run: await this.markRunFailed(run, error), agents };
    }
  }

  async startPlan(request: string, options?: { mode?: WorkflowMode }): Promise<WorkflowRun> {
    const { run } = await this.planPhase(request, { mode: options?.mode, autoRoute: false, source: "plan" });
    return run;
  }

  async startImplement(runId?: string): Promise<WorkflowRun> {
    const targetRunId = runId ?? (await getActiveRunId(this.baseDir));
    if (!targetRunId) {
      throw new WorkflowError("invalid_transition", "No active workflow found. Start one with /work plan <task>");
    }

    const run = await loadWorkflowRun(this.baseDir, targetRunId);
    if (run.state !== "plan_ready") {
      throw new WorkflowError(
        "invalid_transition",
        `Cannot implement workflow in state "${run.state}"; expected "plan_ready"`
      );
    }

    const agents = await this.preflightForRun(run);
    await this.acquireRunLock(run.id);
    try {
      return await this.executeWorkerNode(run, agents);
    } catch (error) {
      return await this.markRunFailed(run, error);
    }
  }

  async startReview(runId?: string): Promise<WorkflowRun> {
    const targetRunId = runId ?? (await getActiveRunId(this.baseDir));
    if (!targetRunId) {
      throw new WorkflowError("invalid_transition", "No active workflow found to review");
    }

    const run = await loadWorkflowRun(this.baseDir, targetRunId);
    // Audit Finding 7 (§26): review is valid after implementation/fix only —
    // never on a bare plan (plan_ready).
    if (run.state !== "testing" && run.state !== "fixing") {
      throw new WorkflowError(
        "invalid_transition",
        `Cannot review workflow in state "${run.state}"; expected "testing" or "fixing"`
      );
    }

    const agents = await this.preflightForRun(run);
    await this.acquireRunLock(run.id);
    try {
      return await this.executeReviewNode(run, agents);
    } catch (error) {
      return await this.markRunFailed(run, error);
    }
  }

  async startFix(runId?: string): Promise<WorkflowRun> {
    const targetRunId = runId ?? (await getActiveRunId(this.baseDir));
    if (!targetRunId) {
      throw new WorkflowError("invalid_transition", "No active workflow found to fix");
    }

    const run = await loadWorkflowRun(this.baseDir, targetRunId);
    if (run.state !== "fixing") {
      const latestReview = run.reviews[run.reviews.length - 1];
      if (!latestReview || latestReview.verdict !== "REQUEST_CHANGES") {
        throw new WorkflowError(
          "invalid_transition",
          `Cannot fix workflow: latest review did not request changes (state: "${run.state}")`
        );
      }
    }

    const agents = await this.preflightForRun(run);
    await this.acquireRunLock(run.id);
    try {
      return await this.executeFixNode(run, agents);
    } catch (error) {
      return await this.markRunFailed(run, error);
    }
  }

  async startAuto(request: string, options?: { mode?: WorkflowMode }): Promise<WorkflowRun> {
    // planPhase owns preflight (pre-run, §29), run creation, and the
    // scout/plan phase; its resolved role mapping serves the whole run, so
    // no second preflight is needed here. A preflight failure throws before
    // any run or lock exists (post-remediation review M1 is covered by the
    // resume path below).
    const planned = await this.planPhase(request, { mode: options?.mode, autoRoute: true, source: "auto" });
    let run = planned.run;
    const agents = planned.agents;

    // planPhase returns the failed run (failure persisted, lock released)
    // when the scout or plan node fails.
    if (WORKFLOW_TERMINAL_STATES.includes(run.state)) {
      return run;
    }

    try {
      return await this.runExecutionLoop(run, agents);
    } catch (error) {
      return await this.markRunFailed(run, error);
    }
  }

  /**
   * Spec-driven entry (/work spec): the user has already written the spec
   * document, so no scout or planner agent runs. The engine reads the spec,
   * synthesizes the PlanResult deterministically (the spec itself, embedded
   * in the run request, is the authoritative plan), and drives the same
   * bounded implement → review → fix loop as /work auto.
   */
  async startSpec(specPath: string, options?: { mode?: WorkflowMode }): Promise<WorkflowRun> {
    const prepared = await prepareSpecSource(
      this.cwd,
      this.config.defaultMode,
      specPath,
      options?.mode
    );
    const specContent = prepared.content;
    const relativeSpecPath = prepared.relativePath;
    const parsedSpec = { policy: prepared.policy };
    const requirement = prepared.requirement;
    const mode = prepared.mode;
    const agents = await this.preflightForRun({ mode, source: "spec" });
    const request = `Spec-driven workflow from immutable requirement snapshot for "${relativeSpecPath}".`;

    let run = await this.createRun(request, mode, false, {
      source: "spec",
      specPath: relativeSpecPath,
      specPolicy: parsedSpec.policy,
      requirement,
      requirementContent: specContent,
    });

    try {
      run.plan = synthesizeSpecPlan(relativeSpecPath, parsedSpec.policy);
      run.complexity = run.plan.complexity;

      await saveArtifact(this.baseDir, run.id, "plan.json", run.plan);
      await saveArtifact(this.baseDir, run.id, "request.md", run.request);
      await appendWorkflowEvent(this.baseDir, run.id, {
        event: "spec.loaded",
        state: run.state,
        node: "spec",
        details: {
          requirement,
          policy: parsedSpec.policy,
        },
      });

      run = await this.stateMachine.transition(run, "plan_ready", {
        node: "spec",
        reason: `Spec loaded from ${relativeSpecPath}; plan synthesized deterministically (no planner agent)`,
      });

      return await this.runExecutionLoop(run, agents);
    } catch (error) {
      return await this.markRunFailed(run, error);
    }
  }

  async startTickets(
    specPath: string,
    options?: { mode?: WorkflowMode; ticketDir?: string; prepareOnly?: boolean }
  ): Promise<WorkflowRun> {
    const prepared = await prepareSpecSource(
      this.cwd,
      this.config.defaultMode,
      specPath,
      options?.mode
    );
    const requirementCriteria = extractRequirementCriteria(prepared.content);
    const graphSource = options?.ticketDir ? "imported" as const : "generated" as const;
    let graph: TicketGraph | undefined;
    if (options?.ticketDir) {
      try {
        graph = await importTicketGraph({
          ticketDir: path.resolve(this.cwd, options.ticketDir),
          requirement: prepared.requirement,
          requirementCriteria,
        });
      } catch (error) {
        if (error instanceof TicketGraphValidationError) {
          throw new WorkflowError("invalid_ticket_graph", error.message, { details: error.issues });
        }
        throw error;
      }
    }

    const agents = await this.preflightForRun({
      mode: prepared.mode,
      source: "tickets",
      ticketGraphSource: graphSource,
    });
    let run = await this.createRun(
      `Ticket-orchestrated workflow for "${prepared.relativePath}".`,
      prepared.mode,
      false,
      {
        source: "tickets",
        specPath: prepared.relativePath,
        specPolicy: prepared.policy,
        requirement: prepared.requirement,
        requirementContent: prepared.content,
        ticketGraphSource: graphSource,
      }
    );

    try {
      run = await this.stateMachine.transition(run, "ticketing", {
        node: "ticket-graph",
        reason: graph ? "Valid imported ticket graph selected" : "Generating ticket graph",
      });
      if (!graph) {
        const adapter = new GeneratedTicketGraphAdapter(
          this.executor,
          agents.planner,
          this.cwd,
          run.id
        );
        graph = await adapter.obtain({
          requirement: prepared.requirement,
          requirementPath: path.join(
            ".pi",
            "workflow",
            "runs",
            run.id,
            prepared.requirement.artifactPath
          ),
          requirementCriteria,
        });
      }

      run.ticketPlan = await freezeTicketGraph(this.baseDir, run.id, graph);
      run.tickets = graph.tickets.map((ticket) => ({
        id: ticket.id,
        title: ticket.title,
        blockedBy: ticket.blockedBy,
        phase: "pending",
        reviewRound: 0,
        fixRound: 0,
      }));
      run.finalGateStatus = "pending";
      await saveWorkflowRun(this.baseDir, run);
      await appendWorkflowEvent(this.baseDir, run.id, {
        event: graphSource === "imported" ? "ticket.graph_imported" : "ticket.graph_generated",
        state: run.state,
        node: "ticket-graph",
        details: {
          source: graphSource,
          contentHash: graph.contentHash,
          snapshot: run.ticketPlan,
        },
      });
      run = await this.stateMachine.transition(run, "executing_tickets", {
        node: "ticket-frontier",
        reason: "Ticket graph validated and frozen",
      });
      return options?.prepareOnly ? run : await this.executeTicketFrontier(run, agents);
    } catch (error) {
      if (error instanceof TicketGraphValidationError) {
        return await this.markRunFailed(
          run,
          new WorkflowError("invalid_ticket_graph", error.message, { details: error.issues }),
          "ticket-graph"
        );
      }
      if (error instanceof TicketGenerationError) {
        return await this.markRunFailed(
          run,
          new WorkflowError("invalid_ticket_graph", error.message, { details: { code: error.code } }),
          "ticketizer"
        );
      }
      return await this.markRunFailed(run, error, "ticket-graph");
    }
  }


  /**
   * The shared /work auto tail: worker → (review ↔ fix) loop until a
   * terminal state or a state the loop cannot advance.
   */
  private async runExecutionLoop(run: WorkflowRun, agents: AgentRoles): Promise<WorkflowRun> {
    run = await this.executeWorkerNode(run, agents);

    while (!WORKFLOW_TERMINAL_STATES.includes(run.state)) {
      if (run.state === "testing" || run.state === "reviewing") {
        run = await this.executeReviewNode(run, agents);
      } else if (run.state === "fixing") {
        run = await this.executeFixNode(run, agents);
      } else {
        break;
      }
    }
    return run;
  }

  /**
   * Restore a spec-driven run's plan deterministically (resume path): from
   * the in-memory state, else the persisted plan.json artifact, else
   * re-synthesized from the recorded specPath. Transitions to plan_ready.
   */
  private async restoreSpecPlan(run: WorkflowRun): Promise<WorkflowRun> {
    if (!run.plan) {
      const plan = (await this.loadPlanArtifact(run.id))
        ?? (run.specPath ? synthesizeSpecPlan(run.specPath, run.specPolicy) : undefined);
      if (!plan) {
        throw new WorkflowError(
          "state_corrupt",
          `Spec-driven run ${run.id} has no plan and no specPath to re-synthesize from; the persisted state is incomplete.`
        );
      }
      run.plan = plan;
      run.complexity = plan.complexity;
      await saveArtifact(this.baseDir, run.id, "plan.json", plan);
    }
    return await this.stateMachine.transition(run, "plan_ready", {
      node: "spec",
      reason: "Restored deterministic spec plan on resume (no planner agent)",
    });
  }

  async resume(runId?: string): Promise<WorkflowRun> {
    const targetRunId = runId ?? (await getActiveRunId(this.baseDir));
    if (!targetRunId) {
      throw new WorkflowError("invalid_transition", "No active workflow to resume");
    }

    let run: WorkflowRun;
    try {
      run = await loadWorkflowRun(this.baseDir, targetRunId);
    } catch (error) {
      // Fail safely (§43, audit Finding 2): a corrupt state.json never
      // touches the repository and surfaces as state_corrupt.
      throw error;
    }

    // Terminal runs cannot be resumed
    if (WORKFLOW_TERMINAL_STATES.includes(run.state)) {
      return run;
    }

    await this.acquireRunLock(run.id);

    let ticketGraph: TicketGraph | undefined;
    if (run.source === "spec" || run.source === "tickets") {
      try {
        run = await this.ensureSpecRequirement(run);
        if (run.source === "tickets") ticketGraph = await this.validateTicketResume(run);
      } catch (error) {
        return await this.markRunFailed(run, error, run.source === "tickets" ? "ticket-resume" : "spec");
      }
    }

    // Preflight failures leave the run in its current state (the user can
    // fix the agent configuration and resume again) — but the lock must
    // never be left behind (audit Finding 2; post-remediation review M1).
    let agents: AgentRoles;
    try {
      agents = await this.preflightForRun(run);
    } catch (error) {
      await this.releaseRunLock(run.id);
      try {
        await appendWorkflowEvent(this.baseDir, run.id, {
          event: "workflow.preflight_failed",
          state: run.state,
          details: { message: error instanceof Error ? error.message : String(error) },
        });
      } catch {
        // best effort — the original failure must propagate
      }
      throw error;
    }

    try {
      switch (run.state) {
        case "created":
        case "scouting":
        case "planning":
          if (run.source === "spec") {
            // A spec-driven run never plans with an agent: restore the
            // deterministic plan (state → persisted artifact → re-synthesize
            // from specPath), then finish the single-command automated flow
            // to completion, exactly as /work spec would have.
            run = await this.restoreSpecPlan(run);
            run = await this.finalizeAutoRouting(run, agents);
            run = await this.runExecutionLoop(run, agents);
            break;
          }
          // Audit Finding 8: re-hydrate the persisted scout artifact instead
          // of re-running (or silently skipping) the scout node.
          run = await this.runPlanningPhase(run, agents);
          break;
        case "plan_ready":
        case "implementing": {
          run = await this.finalizeAutoRouting(run, agents);
          // §48 Invariant 4 (post-remediation review M2): a mutating node
          // that started but did not complete must not be blindly re-run —
          // the working tree may already have been modified. Fail safely
          // with recovery information instead.
          if (run.state === "implementing") {
            const persistedImpl = run.implementation ?? (await this.loadImplementationArtifact(run.id));
            if (persistedImpl) {
              // The worker finished before the interruption; its result is
              // persisted. Settle the gate instead of re-running the worker.
              run = await this.settleImplementation(run, persistedImpl);
              break;
            }
            if (await this.nodeStartedWithoutCompletion(run.id, "implement")) {
              run = await this.markRunFailed(
                run,
                new WorkflowError(
                  "incomplete_node",
                  `Implementation node "implement" started before the interruption but did not complete, and no result was persisted. The working tree may already have been modified: inspect the repository, then /work abort and start a fresh run from a clean state.`,
                  { nodeId: "implement" }
                ),
                "implement"
              );
              break;
            }
          }
          run = await this.executeWorkerNode(run, agents);
          break;
        }
        case "testing":
        case "reviewing":
          run = await this.executeReviewNode(run, agents);
          break;
        case "fixing": {
          // §48 Invariant 4 (post-remediation review M2): same rule for the
          // mutating fix node.
          const fixRound = run.fixes.length + 1;
          const fixNodeId = `fix-${fixRound}`;
          const persistedFix = await this.loadFixArtifact(run.id, fixRound);
          if (persistedFix) {
            // The fixer finished before the interruption; its result is
            // persisted. Settle the transition instead of re-running it.
            run = await this.settleFix(run, persistedFix, fixNodeId, fixRound);
            if (run.state === "testing") {
              run = await this.executeReviewNode(run, agents);
            }
            break;
          }
          if (await this.nodeStartedWithoutCompletion(run.id, fixNodeId)) {
            run = await this.markRunFailed(
              run,
              new WorkflowError(
                "incomplete_node",
                `Fix node "${fixNodeId}" started before the interruption but did not complete, and no result was persisted. The working tree may already have been modified: inspect the repository, then /work abort and start a fresh run from a clean state.`,
                { nodeId: fixNodeId }
              ),
              fixNodeId
            );
            break;
          }
          run = await this.executeFixNode(run, agents);
          // After fixing, proceed to review
          if (run.state === "testing") {
            run = await this.executeReviewNode(run, agents);
          }
          break;
        }
        case "ticketing":
          if (!ticketGraph) throw new WorkflowError("ticket_graph_corrupt", "Ticket plan is unavailable");
          run = await this.stateMachine.transition(run, "executing_tickets", {
            node: "ticket-frontier",
            reason: "Resuming validated ticket plan",
          });
          run = await this.executeTicketFrontier(run, agents);
          break;
        case "executing_tickets":
          run = await this.executeTicketFrontier(run, agents);
          break;
        case "finalizing":
          if (!ticketGraph) throw new WorkflowError("ticket_graph_corrupt", "Final gate ticket plan is unavailable");
          run = await this.executeTicketFinalGate(run, ticketGraph, agents);
          break;
      }
      return run;
    } catch (error) {
      return await this.markRunFailed(run, error);
    }
  }

  async abort(runId?: string): Promise<WorkflowRun> {
    const targetRunId = runId ?? (await getActiveRunId(this.baseDir));
    if (!targetRunId) {
      throw new WorkflowError("invalid_transition", "No active workflow to abort");
    }

    const run = await loadWorkflowRun(this.baseDir, targetRunId);
    if (WORKFLOW_TERMINAL_STATES.includes(run.state)) {
      return run;
    }

    const aborted = await this.stateMachine.transition(run, "aborted", {
      reason: "Workflow explicitly aborted by user",
      error: {
        code: "workflow_aborted",
        message: "Workflow aborted. Repository changes were preserved.",
      },
    });

    await this.releaseRunLock(run.id);
    return aborted;
  }

  async status(runId?: string): Promise<WorkflowRun | null> {
    const targetRunId = runId ?? (await getActiveRunId(this.baseDir));
    if (!targetRunId) {
      const runs = await listWorkflowRuns(this.baseDir);
      if (runs.length === 0) return null;
      return await loadWorkflowRun(this.baseDir, runs[0]);
    }
    return await loadWorkflowRun(this.baseDir, targetRunId);
  }

  async getActiveRun(): Promise<WorkflowRun | null> {
    const activeId = await getActiveRunId(this.baseDir);
    if (!activeId) return null;
    try {
      return await loadWorkflowRun(this.baseDir, activeId);
    } catch {
      return null;
    }
  }

  async listRuns(): Promise<string[]> {
    return await listWorkflowRuns(this.baseDir);
  }
}

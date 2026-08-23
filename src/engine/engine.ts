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
import { captureRepositoryBaseline } from "../repository/baseline.ts";
import {
  getRunDir,
  getWorkflowBaseDir,
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

/** Resolved role → agent-name mapping for a run (audit Finding 10). */
export type AgentRoles = Record<WorkflowRole, string>;

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
export function synthesizeSpecPlan(specPath: string): PlanResult {
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
    tests: [{ description: "The project's test suite passes after implementation", required: true }],
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
  /** Injectable preflight (post-remediation review M1); tests use it to
   *  simulate preflight failures. Receives the mode being preflighted. */
  preflightForMode?: (mode: WorkflowMode) => Promise<AgentRoles>;
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
  public readonly onProgress?: WorkflowProgressCallback;
  private readonly preflightOverride?: (mode: WorkflowMode) => Promise<AgentRoles>;

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

  /**
   * Audit Finding 10: run preflight for a mode and return the resolved
   * role → agent mapping. Throws preflight_failed before any modification.
   * `requiredRoles` narrows the checked set (the spec-driven flow runs no
   * scout or planner node).
   */
  private async preflightForMode(mode: WorkflowMode, requiredRoles?: WorkflowRole[]): Promise<AgentRoles> {
    if (this.preflightOverride) {
      return this.preflightOverride(mode);
    }
    const preflight = await validateWorkflowPreflight(this.config, this.cwd, mode, undefined, requiredRoles);
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
    origin?: { source: "auto" | "plan" | "spec"; specPath?: string }
  ): Promise<WorkflowRun> {
    const runId = generateWorkflowRunId();
    await this.acquireRunLock(runId);

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
    };

    await saveWorkflowRun(this.baseDir, run);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "workflow.created",
      state: "created",
      details: {
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
    const taskPrompt = buildWorkerPrompt({ task: run.request, plan: approvedPlan, scout });
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

    run.implementation = implData;
    await saveArtifact(this.baseDir, run.id, "implementation.json", implData);

    run = await this.stateMachine.transition(run, "testing", {
      node: "implement",
      reason: "Implementation finished, evaluating test gate",
    });

    const testGate = evaluateTestGate(implData.tests, approvedPlan.tests);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "gate.test",
      state: run.state,
      details: { status: testGate.status, reason: testGate.reason },
    });

    // Audit Finding 3 (§10/§22): an unacceptable test gate routes directly
    // to fixing. The fixer prompt receives the failed tests.
    if (testGate.status === "FIX_REQUIRED") {
      run = await this.stateMachine.transition(run, "fixing", {
        node: "implement",
        reason: `Test gate requires fixes: ${testGate.reason}`,
      });
    }

    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "node.completed",
      state: run.state,
      node: "implement",
    });

    const passedTests = implData.tests.filter((t) => t.status === "passed").length;
    const totalTests = implData.tests.length;

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
        testGateStatus: testGate.status,
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

    const testGate = evaluateTestGate(implData.tests, plan.tests);
    await appendWorkflowEvent(this.baseDir, run.id, {
      event: "gate.test",
      state: run.state,
      details: { status: testGate.status, reason: testGate.reason },
    });

    // Audit Finding 3 (§10/§22): an unacceptable test gate routes directly
    // to fixing. The fixer prompt receives the failed tests.
    if (testGate.status === "FIX_REQUIRED") {
      run = await this.stateMachine.transition(run, "fixing", {
        node: "implement",
        reason: `Test gate requires fixes: ${testGate.reason}`,
      });
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
              terminalMessage: `Reviewer ${nodeId} returned an invalid review: ${validation.error}`,
            };
      },
      // Stamp the review identity and mark the node complete before the
      // terminal progress event is emitted by the caller.
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
    const failedTests = latestTests.filter((t) => t.status === "failed");

    const taskPrompt = buildFixerPrompt({
      task: run.request,
      plan: approvedPlan,
      findings,
      failedTests,
      round: fixRound,
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
    const agents = await this.preflightForMode(initialMode);

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

    const agents = await this.preflightForMode(run.mode);
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

    const agents = await this.preflightForMode(run.mode);
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

    const agents = await this.preflightForMode(run.mode);
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
    const absoluteSpecPath = path.isAbsolute(specPath) ? specPath : path.join(this.cwd, specPath);
    let specContent: string;
    try {
      specContent = await fs.readFile(absoluteSpecPath, "utf-8");
    } catch (error) {
      throw new WorkflowError(
        "invalid_transition",
        `Cannot read spec file "${specPath}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!specContent.trim()) {
      throw new WorkflowError("invalid_transition", `Spec file "${specPath}" is empty`);
    }
    // The spec is embedded verbatim in every node prompt (worker, each fresh
    // reviewer, fixer); an oversized document would multiply token cost per
    // node. Fail fast with guidance instead of burning the budget.
    const SPEC_MAX_CHARS = 100_000;
    if (specContent.length > SPEC_MAX_CHARS) {
      throw new WorkflowError(
        "invalid_transition",
        `Spec file "${specPath}" is too large (${specContent.length} characters > ${SPEC_MAX_CHARS}). ` +
          `Split it into smaller spec documents and run one /work spec per document.`
      );
    }

    const mode = options?.mode ?? this.config.defaultMode;
    // The spec flow runs only the worker and reviewer nodes; planner/scout
    // agents are not required to be configured at all (§29: fail before
    // modifications, on exactly the roles this flow launches).
    const agents = await this.preflightForMode(mode, ["worker", "reviewer"]);

    const relativeSpecPath = path.relative(this.cwd, absoluteSpecPath) || specPath;
    const request = [
      `Spec-driven workflow: implement the specification document "${relativeSpecPath}", reproduced in full below.`,
      "",
      "--- SPECIFICATION BEGIN ---",
      specContent.trim(),
      "--- SPECIFICATION END ---",
    ].join("\n");

    let run = await this.createRun(request, mode, false, { source: "spec", specPath: relativeSpecPath });

    try {
      run.plan = synthesizeSpecPlan(relativeSpecPath);
      run.complexity = run.plan.complexity;

      await saveArtifact(this.baseDir, run.id, "plan.json", run.plan);
      await saveArtifact(this.baseDir, run.id, "request.md", run.request);
      await appendWorkflowEvent(this.baseDir, run.id, {
        event: "spec.loaded",
        state: run.state,
        node: "spec",
        details: { path: relativeSpecPath, characters: specContent.length },
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
      const plan = (await this.loadPlanArtifact(run.id)) ?? (run.specPath ? synthesizeSpecPlan(run.specPath) : undefined);
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

    // Preflight failures leave the run in its current state (the user can
    // fix the agent configuration and resume again) — but the lock must
    // never be left behind (audit Finding 2; post-remediation review M1).
    let agents: AgentRoles;
    try {
      agents = await this.preflightForMode(run.mode);
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

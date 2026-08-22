/**
 * Regression tests for the audit findings in docs/pi-workflow.spec.md §52
 * (2026-08-21). Each test is named after the finding it covers.
 */
import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorkflowEngine } from "../src/engine/engine.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";
import { loadWorkflowRun, saveWorkflowRun, setActiveRunId, saveArtifact } from "../src/storage/store.ts";
import { appendWorkflowEvent } from "../src/storage/events.ts";
import { validateWorkflowPreflight } from "../src/agents/preflight.ts";
import { validateWorkflowRun, type WorkflowConfig, type WorkflowState, type WorkflowRun } from "../src/contracts/workflow.ts";
import { canTransition } from "../src/engine/transitions.ts";
import { WorkflowError } from "../src/engine/errors.ts";
import type { PlanResult } from "../src/contracts/plan.ts";
import type { ImplementationResult } from "../src/contracts/implementation.ts";
import type { ReviewResult } from "../src/contracts/review.ts";
import type { FixResult } from "../src/contracts/fix.ts";
import type { ScoutResult } from "../src/contracts/scout.ts";
import { buildScoutPrompt } from "../src/prompts/scout.ts";
import { buildPlannerPrompt } from "../src/prompts/planner.ts";
import { buildWorkerPrompt } from "../src/prompts/worker.ts";
import { buildReviewerPrompt } from "../src/prompts/reviewer.ts";
import { buildFixerPrompt } from "../src/prompts/fixer.ts";

const noSleep = async (_ms: number): Promise<void> => {};

const makePlan = (overrides: Partial<PlanResult> = {}): PlanResult => ({
  summary: "Implementation plan for the request",
  understanding: "Understand the requirements",
  files: [{ path: "src/main.ts", purpose: "Core logic", action: "modify" }],
  steps: [{ id: "s1", description: "Apply the changes" }],
  tests: [{ command: "npm test", description: "Run the test suite", required: true }],
  risks: [{ severity: "low", description: "Minimal risk" }],
  assumptions: ["Node.js is available"],
  complexity: "low",
  requiresSecondReviewer: false,
  ...overrides,
});

const makeImpl = (overrides: Partial<ImplementationResult> = {}): ImplementationResult => ({
  summary: "Implemented the required changes",
  changedFiles: [{ path: "src/main.ts", change: "Added the feature" }],
  tests: [{ command: "npm test", status: "passed", summary: "All 5 tests passed" }],
  unresolvedIssues: [],
  deviationsFromPlan: [],
  ...overrides,
});

const makePassReview = (overrides: Partial<ReviewResult> = {}): ReviewResult => ({
  verdict: "PASS",
  summary: "Looks correct and tested",
  findings: [],
  testAssessment: { sufficient: true, explanation: "Adequate coverage" },
  confidence: 0.95,
  ...overrides,
});

const makeFix = (overrides: Partial<FixResult> = {}): FixResult => ({
  summary: "Addressed the findings",
  addressedFindings: [],
  unaddressedFindings: [],
  changedFiles: [{ path: "src/main.ts", change: "Applied the fix" }],
  tests: [{ command: "npm test", status: "passed", summary: "All tests pass" }],
  ...overrides,
});

const makeScout = (overrides: Partial<ScoutResult> = {}): ScoutResult => ({
  summary: "Custom scout summary for rehydration test",
  relevantFiles: [{ path: "src/main.ts", relevance: "Entry point" }],
  contextHints: ["Hint: use the existing helper module"],
  ...overrides,
});

async function readEvents(runDir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(runDir, "events.jsonl"), "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const runDirOf = (tmpDir: string, runId: string) => path.join(tmpDir, ".pi", "workflow", "runs", runId);
const baseDirOf = (tmpDir: string) => path.join(tmpDir, ".pi", "workflow");

describe("Audit Findings & Remediation (§52)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wf-audit-test-"));
  });

  describe("Finding 2 — node failures are persisted and the run lock is released", () => {
    it("persists the failure on a worker failure in /work auto and releases the lock", async () => {
      const fake = new FakeAgentExecutor();
      fake.setHandler("implement", () => ({ status: "failed", error: "Worker crashed" }));
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startAuto("implement thing", { mode: "quick" });

      assert.equal(run.state, "failed");
      assert.equal(run.error?.code, "agent_execution_failed");
      assert.equal(run.error?.nodeId, "implement");

      // Persisted to state.json (§36 "Persist failures")
      const loaded = await loadWorkflowRun(baseDirOf(tmpDir), run.id);
      assert.equal(loaded.state, "failed");
      assert.equal(loaded.error?.code, "agent_execution_failed");
      assert.equal(loaded.error?.nodeId, "implement");

      // Recovery-oriented events (§14 / Finding 11)
      const events = await readEvents(runDirOf(tmpDir, run.id));
      assert.ok(events.some((e) => e.event === "node.failed" && e.node === "implement"));
      assert.ok(events.some((e) => e.event === "workflow.failed"));

      // Lock released: the project is not locked out by the failed run
      assert.equal(await engine.getActiveRun(), null);
      const run2 = await engine.startPlan("next task", { mode: "quick" });
      assert.equal(run2.state, "plan_ready");
    });

    it("persists the failure on a plan node failure in /work plan", async () => {
      const fake = new FakeAgentExecutor();
      fake.setHandler("plan", () => ({ status: "failed", error: "planner exploded" }));
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startPlan("some task", { mode: "quick" });

      assert.equal(run.state, "failed");
      assert.equal(run.error?.code, "agent_execution_failed");
      assert.equal(run.error?.nodeId, "plan");
      const loaded = await loadWorkflowRun(baseDirOf(tmpDir), run.id);
      assert.equal(loaded.state, "failed");
      assert.equal(await engine.getActiveRun(), null);
    });

    it("persists WorkflowError diagnostic details in the failure record", async () => {
      const fake = new FakeAgentExecutor();
      fake.setHandler("plan", () => {
        throw new WorkflowError("agent_execution_failed", "planner exploded", {
          nodeId: "plan",
          details: { hint: "check config", attempts: 3 },
        });
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startPlan("some task", { mode: "quick" });

      assert.equal(run.state, "failed");
      assert.deepEqual(run.error?.details, { hint: "check config", attempts: 3 });

      // The diagnostic blob must survive the round trip through state.json.
      const loaded = await loadWorkflowRun(baseDirOf(tmpDir), run.id);
      assert.equal(loaded.state, "failed");
      assert.equal(loaded.error?.code, "agent_execution_failed");
      assert.deepEqual(loaded.error?.details, { hint: "check config", attempts: 3 });
    });
  });

  describe("Finding 1 — planner fork degradation", () => {
    it("degrades to fresh context without consuming the agent retry budget", async () => {
      const forkError =
        "Failed to create forked subagent session: Parent session file does not exist: " +
        "/sessions/x.jsonl. Pi has not persisted enough history to fork yet.";
      let planCalls = 0;
      const fake = new FakeAgentExecutor();
      fake.setHandler("plan", (req) => {
        planCalls++;
        if (req.context === "fork") {
          return { status: "failed", error: forkError };
        }
        if (planCalls === 2) {
          // A genuine transient failure AFTER the degradation: it must still
          // get its one retry (proof the degradation did not burn the budget).
          return { status: "failed", error: "transient blip" };
        }
        return { status: "completed", result: makePlan() };
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startPlan("some task", { mode: "normal" });

      assert.equal(run.state, "plan_ready");
      const planReqs = fake.requests.filter((r) => r.nodeId === "plan");
      assert.equal(planReqs.length, 3, "fork failure + degraded fresh failure (retried) + success");
      assert.equal(planReqs[0].context, "fork");
      assert.equal(planReqs[1].context, "fresh");
      assert.equal(planReqs[2].context, "fresh");

      const events = await readEvents(runDirOf(tmpDir, run.id));
      const forkEvents = events.filter((e) => e.event === "planner.fork_unavailable");
      assert.equal(forkEvents.length, 1);
      assert.match(String((forkEvents[0] as any).details?.reason ?? ""), /not persisted enough history/);
    });

    it("still fails the run when the planner also fails fresh", async () => {
      const forkError =
        "Failed to create forked subagent session: Parent session file does not exist: " +
        "/sessions/x.jsonl. Pi has not persisted enough history to fork yet.";
      let planCalls = 0;
      const fake = new FakeAgentExecutor();
      fake.setHandler("plan", (req) => {
        planCalls++;
        if (req.context === "fork") return { status: "failed", error: forkError };
        return { status: "failed", error: "fresh also broken" };
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startPlan("some task", { mode: "quick" });

      assert.equal(run.state, "failed");
      assert.equal(run.error?.code, "agent_execution_failed");
      // fork fail (degrade, no budget) + fresh fail (budget 1) + fresh retry fail
      assert.equal(planCalls, 3);
    });
  });

  describe("Finding 3 — test gate routing", () => {
    it("routes FIX_REQUIRED directly to fixing and feeds failed tests to the fixer", async () => {
      const fake = new FakeAgentExecutor({
        implement: makeImpl({
          tests: [{ command: "npm test", status: "failed", summary: "3 required tests failed" }],
        }),
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startAuto("implement thing", { mode: "normal" });

      assert.equal(run.state, "completed");
      const fixReq = fake.requests.find((r) => r.nodeId === "fix-1");
      assert.ok(fixReq, "fixer must run after failing required tests");
      assert.match(fixReq.task, /3 required tests failed/);

      const events = await readEvents(runDirOf(tmpDir, run.id));
      assert.ok(
        events.some((e) => e.event === "state.changed" && e.from === "testing" && e.to === "fixing"),
        "testing must transition directly to fixing"
      );
      const ids = fake.requests.map((r) => r.nodeId);
      assert.ok(ids.indexOf("fix-1") < ids.indexOf("review-1"), "review must happen after the fix");
    });

    it("fails with required_tests_failed (not review_budget_exhausted) when reviewers pass but required tests keep failing", async () => {
      const failingTests = [{ command: "npm test", status: "failed" as const, summary: "required test X failed" }];
      const fake = new FakeAgentExecutor();
      fake.setHandler("worker", (req) => {
        if (req.nodeId === "implement") {
          return { status: "completed", result: makeImpl({ tests: failingTests }) };
        }
        return { status: "completed", result: makeFix({ tests: failingTests }) };
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startAuto("implement thing", { mode: "normal" });

      assert.equal(run.state, "failed");
      assert.equal(run.error?.code, "required_tests_failed");
      assert.notEqual(run.error?.code, "review_budget_exhausted");
      const reviewReqs = fake.requests.filter((r) => r.nodeId.startsWith("review"));
      assert.equal(reviewReqs.length, 3, "bounded by the review budget");
    });
  });

  describe("Finding 4 — structured output validation in the engine", () => {
    it("retries once with a schema-correction prompt on a malformed review verdict", async () => {
      let calls = 0;
      const fake = new FakeAgentExecutor();
      fake.setHandler("review-1", () => {
        calls++;
        if (calls === 1) {
          return { status: "completed", result: makePassReview({ verdict: "APPROVED" as any }) };
        }
        return { status: "completed", result: makePassReview() };
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startAuto("implement thing", { mode: "normal" });

      assert.equal(run.state, "completed");
      assert.equal(calls, 2);
      const reviewReqs = fake.requests.filter((r) => r.nodeId === "review-1");
      assert.equal(reviewReqs.length, 2);
      assert.match(reviewReqs[1].task, /schema validation/i);
    });

    it("fails with invalid_structured_output when the review is malformed twice", async () => {
      const fake = new FakeAgentExecutor();
      fake.setHandler("review-1", () => ({
        status: "completed",
        result: makePassReview({ verdict: "APPROVED" as any }),
      }));
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startAuto("implement thing", { mode: "quick" });

      assert.equal(run.state, "failed");
      assert.equal(run.error?.code, "invalid_structured_output");
      assert.equal(run.error?.nodeId, "review-1");
      // Not silently treated as "not PASS" → no fixing transition
      const events = await readEvents(runDirOf(tmpDir, run.id));
      assert.ok(!events.some((e) => e.event === "state.changed" && e.to === "fixing"));
    });

    it("validates worker output and retries with a correction prompt", async () => {
      let calls = 0;
      const fake = new FakeAgentExecutor();
      fake.setHandler("implement", () => {
        calls++;
        if (calls === 1) {
          return { status: "completed", result: makeImpl({ summary: "   " }) };
        }
        return { status: "completed", result: makeImpl() };
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startAuto("implement thing", { mode: "normal" });

      assert.equal(run.state, "completed");
      assert.equal(calls, 2);
      const implReqs = fake.requests.filter((r) => r.nodeId === "implement");
      assert.match(implReqs[1].task, /schema validation/i);
    });
  });

  describe("Finding 6 — auto-routed quick mode uses quick parameters", () => {
    it("auto-routes low complexity to quick: no scout, plan first, budget 2", async () => {
      const fake = new FakeAgentExecutor();
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startAuto("small localized fix");

      assert.equal(run.state, "completed");
      assert.equal(run.mode, "quick");
      assert.equal(run.maxReviewRounds, 2);
      assert.equal(fake.requests.filter((r) => r.nodeId === "scout").length, 0);
      const ids = fake.requests.map((r) => r.nodeId);
      assert.ok(ids.includes("plan"));
      assert.ok(ids.indexOf("plan") < ids.indexOf("implement"), "planner launches first in auto mode");
    });

    it("auto-routes high complexity to strict: post-plan scout feeds the worker, 3 fresh reviewers", async () => {
      const fake = new FakeAgentExecutor({
        plan: makePlan({ complexity: "high", requiresSecondReviewer: true }),
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startAuto("large architectural refactor");

      assert.equal(run.state, "completed");
      assert.equal(run.mode, "strict");
      const ids = fake.requests.map((r) => r.nodeId);
      assert.deepEqual(ids, ["plan", "scout", "implement", "review-1-a", "review-1-b", "review-1-final"]);

      // Scout output feeds the worker (§25 / audit Finding 6)
      const implReq = fake.requests.find((r) => r.nodeId === "implement")!;
      assert.match(implReq.task, /Scout Exploration Summary/);
    });
  });

  describe("Finding 7 — /work review preconditions", () => {
    it("rejects review in plan_ready state", async () => {
      const fake = new FakeAgentExecutor();
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });
      const run = await engine.startPlan("plan only", { mode: "quick" });
      assert.equal(run.state, "plan_ready");

      await assert.rejects(
        async () => await engine.startReview(run.id),
        (err: any) =>
          err instanceof WorkflowError && err.code === "invalid_transition" && /plan_ready/.test(err.message)
      );
    });
  });

  describe("Finding 8 — resume rehydrates the scout artifact", () => {
    it("passes the persisted scout result to the planner on resume from planning", async () => {
      const baseDir = baseDirOf(tmpDir);
      const runId = "wf_resume_scout";
      const now = new Date().toISOString();
      const run = {
        version: 1 as const,
        id: runId,
        cwd: tmpDir,
        createdAt: now,
        updatedAt: now,
        state: "planning" as WorkflowState,
        mode: "normal" as const,
        request: "rehydrate me",
        reviewRound: 1,
        maxReviewRounds: 3,
        reviews: [],
        fixes: [],
        baseline: { dirty: false, status: [], startedAt: now },
        autoRouted: false,
        modeResolved: true,
        currentNode: "plan",
      };
      await saveWorkflowRun(baseDir, run);
      await saveArtifact(baseDir, runId, "scout.json", makeScout());
      await setActiveRunId(baseDir, runId);

      const fake = new FakeAgentExecutor();
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const resumed = await engine.resume(runId);

      assert.equal(resumed.state, "plan_ready");
      const planReq = fake.requests.find((r) => r.nodeId === "plan");
      assert.ok(planReq, "planner must run on resume");
      // The scout node must NOT be re-run — its artifact is re-hydrated
      assert.equal(fake.requests.filter((r) => r.nodeId === "scout").length, 0);
      assert.match(planReq.task, /Custom scout summary for rehydration test/);
      assert.match(planReq.task, /Hint: use the existing helper module/);
    });
  });

  describe("Finding 9 — retry backoff is applied", () => {
    it("sleeps for the policy's delayMs on an agent-execution retry", async () => {
      const delays: number[] = [];
      let calls = 0;
      const fake = new FakeAgentExecutor();
      fake.setHandler("implement", () => {
        calls++;
        if (calls === 1) return { status: "failed", error: "transient worker crash" };
        return { status: "completed", result: makeImpl() };
      });
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        executor: fake,
        sleep: async (ms) => {
          delays.push(ms);
        },
      });

      const run = await engine.startAuto("implement thing", { mode: "quick" });

      assert.equal(run.state, "completed");
      assert.deepEqual(delays, [1000]);
    });
  });

  describe("Finding 10 — preflight correctness", () => {
    const config: WorkflowConfig = {
      defaultMode: "normal",
      maxReviewRounds: 3,
      agents: { scout: "scout", planner: "planner", worker: "worker", reviewer: "reviewer" },
    };
    const cloneConfig = () => ({ ...config, agents: { ...config.agents } });

    it("tolerates an unloadable preflight module, skips checks, and does not mutate config", async () => {
      const importFail = new Error("Cannot find module 'pi-subagents/preflight'");
      (importFail as any).code = "ERR_MODULE_NOT_FOUND";
      const cfg = cloneConfig();

      const result = await validateWorkflowPreflight(cfg, tmpDir, "normal", async () => {
        throw importFail;
      });

      assert.equal(result.ok, true);
      assert.equal(result.moduleUnavailable, true);
      assert.deepEqual(result.agents, cfg.agents);
      assert.deepEqual(cfg.agents, { scout: "scout", planner: "planner", worker: "worker", reviewer: "reviewer" });
    });

    it("surfaces a genuine resolution failure (fail before modifications)", async () => {
      const fakeModule = {
        resolveSubagentLaunchContract: async (input: { agent: string }) =>
          input.agent === "worker"
            ? { ok: false, code: "missing_agent", message: `Unknown agent: ${input.agent}`, diagnostics: [] }
            : { ok: true, code: undefined, message: undefined, diagnostics: [] },
      };
      const cfg = cloneConfig();

      const result = await validateWorkflowPreflight(cfg, tmpDir, "normal", async () => fakeModule);

      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /worker/);
      assert.match(result.error ?? "", /Unknown agent/);
      assert.deepEqual(cfg.agents, { scout: "scout", planner: "planner", worker: "worker", reviewer: "reviewer" });
    });

    it("returns a resolved role mapping via fallback instead of mutating config", async () => {
      const fakeModule = {
        resolveSubagentLaunchContract: async (input: { agent: string }) =>
          input.agent === "scout"
            ? { ok: false, code: "missing_agent", message: "Unknown agent: scout", diagnostics: [] }
            : { ok: true, code: undefined, message: undefined, diagnostics: [] },
      };
      const cfg = cloneConfig();

      const result = await validateWorkflowPreflight(cfg, tmpDir, "normal", async () => fakeModule);

      assert.equal(result.ok, true);
      assert.equal(result.agents?.scout, "researcher");
      assert.equal(result.agents?.planner, "planner");
      assert.equal(cfg.agents.scout, "scout", "config must not be mutated");
    });

    it("surfaces a thrown failure from the preflight logic", async () => {
      const fakeModule = {
        resolveSubagentLaunchContract: async (_input: { agent: string }) => {
          throw new Error("boom in preflight");
        },
      };
      const result = await validateWorkflowPreflight(cloneConfig(), tmpDir, "quick", async () => fakeModule);

      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /boom in preflight/);
    });
  });

  describe("Finding 11 — node lifecycle events", () => {
    it("emits node.started and node.completed around every executor call", async () => {
      const fake = new FakeAgentExecutor();
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startAuto("implement thing", { mode: "normal" });

      assert.equal(run.state, "completed");
      const events = await readEvents(runDirOf(tmpDir, run.id));
      const started = new Set(events.filter((e) => e.event === "node.started").map((e) => String(e.node)));
      const completed = new Set(events.filter((e) => e.event === "node.completed").map((e) => String(e.node)));
      for (const node of ["scout", "plan", "implement", "review-1"]) {
        assert.ok(started.has(node), `node.started missing for ${node}`);
        assert.ok(completed.has(node), `node.completed missing for ${node}`);
      }
    });
  });

  describe("Finding 12 — the dead paused state is removed", () => {
    it("no longer accepts paused as a workflow state", () => {
      assert.equal(canTransition("created", "paused" as any), false);
      assert.equal(canTransition("planning", "paused" as any), false);
    });

    it("treats a persisted run with state=paused as corrupt", () => {
      const now = new Date().toISOString();
      const run = {
        version: 1,
        id: "wf_paused",
        cwd: tmpDir,
        createdAt: now,
        updatedAt: now,
        state: "paused",
        mode: "normal",
        request: "x",
        reviewRound: 1,
        maxReviewRounds: 3,
        reviews: [],
        fixes: [],
        baseline: { dirty: false, status: [], startedAt: now },
      };
      const validation = validateWorkflowRun(run);
      assert.equal(validation.ok, false);
      assert.match(validation.ok ? "" : validation.error, /Invalid state/);
    });
  });

  describe("Post-remediation review — independent reviewer findings (2026-08-21)", () => {
    /** Build a minimal non-terminal run for resume-path tests. */
    const makeRunState = (runId: string, state: WorkflowState, overrides: Partial<WorkflowRun> = {}): WorkflowRun => {
      const now = new Date().toISOString();
      return {
        version: 1,
        id: runId,
        cwd: tmpDir,
        createdAt: now,
        updatedAt: now,
        state,
        mode: "quick",
        request: "resume me",
        reviewRound: 1,
        maxReviewRounds: 2,
        plan: makePlan(),
        reviews: [],
        fixes: [],
        baseline: { dirty: false, status: [], startedAt: now },
        autoRouted: false,
        modeResolved: true,
        ...overrides,
      };
    };

    it("M3: a thrown preflight resolver error fails immediately instead of falling back", async () => {
      const config: WorkflowConfig = {
        defaultMode: "normal",
        maxReviewRounds: 3,
        agents: { scout: "scout", planner: "planner", worker: "worker", reviewer: "reviewer" },
      };
      // The configured scout's resolver throws; the fallback "researcher"
      // would resolve fine. The throw must not be masked by the fallback.
      const throwingImport = async () => ({
        resolveSubagentLaunchContract: async ({ agent }: { agent: string }) => {
          if (agent === "scout") {
            throw new Error("resolver exploded");
          }
          return { ok: true };
        },
      });

      const result = await validateWorkflowPreflight(config, tmpDir, "normal", throwingImport);

      assert.equal(result.ok, false);
      assert.equal(result.moduleUnavailable, undefined);
      assert.ok(result.diagnostics?.some((d) => d.code === "preflight_error"));
      assert.match(result.error ?? "", /resolver exploded/);
    });

    it("M1: resume with a post-lock preflight failure releases the lock and keeps the run resumable", async () => {
      const baseDir = baseDirOf(tmpDir);
      const runId = "wf_m1_resume";
      await saveWorkflowRun(baseDir, makeRunState(runId, "testing", { implementation: makeImpl() }));
      await setActiveRunId(baseDir, runId);

      const fake = new FakeAgentExecutor();
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        executor: fake,
        sleep: noSleep,
        preflightForMode: async () => {
          throw new WorkflowError("preflight_failed", "simulated preflight failure");
        },
      });

      await assert.rejects(() => engine.resume(runId), (err: unknown) => {
        assert.ok(err instanceof WorkflowError);
        return err.code === "preflight_failed";
      });

      // Lock released: a failed preflight must not lock the project
      assert.equal(await engine.getActiveRun(), null);

      // The run survives in its original state (fix config, resume again)
      const loaded = await loadWorkflowRun(baseDir, runId);
      assert.equal(loaded.state, "testing");
      assert.equal(loaded.error, undefined);

      // The failure is recorded as an event
      const events = await readEvents(runDirOf(tmpDir, runId));
      assert.ok(events.some((e) => e.event === "workflow.preflight_failed"));

      // No node ran
      assert.equal(fake.requests.length, 0);
    });

    it("M1: /work auto runs preflight before creating any run (fail before modifications)", async () => {
      const baseDir = baseDirOf(tmpDir);
      const fake = new FakeAgentExecutor();
      const engine = new WorkflowEngine({
        cwd: tmpDir,
        executor: fake,
        sleep: noSleep,
        preflightForMode: async () => {
          throw new WorkflowError("preflight_failed", "simulated preflight failure");
        },
      });

      // Wrap-up: auto runs a single preflight up front, so a preflight
      // failure happens before any run, lock, or node execution exists
      // (§29). There is no post-lock preflight left to leak the lock.
      await assert.rejects(
        () => engine.startAuto("implement thing", { mode: "quick" }),
        (err: unknown) => err instanceof WorkflowError && err.code === "preflight_failed"
      );

      assert.equal(await engine.getActiveRun(), null);
      const runIds = await fs.readdir(path.join(baseDir, "runs")).catch(() => [] as string[]);
      assert.equal(runIds.length, 0);
      assert.equal(fake.requests.length, 0);
    });

    it("M2: resuming an interrupted implement without a persisted result fails safely instead of re-running the worker", async () => {
      const baseDir = baseDirOf(tmpDir);
      const runId = "wf_m2_impl_crash";
      await saveWorkflowRun(baseDir, makeRunState(runId, "implementing"));
      await setActiveRunId(baseDir, runId);
      // The process died after node.started, before any result was persisted.
      await appendWorkflowEvent(baseDir, runId, { event: "node.started", state: "implementing", node: "implement" });

      const fake = new FakeAgentExecutor();
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const resumed = await engine.resume(runId);

      assert.equal(resumed.state, "failed");
      assert.equal(resumed.error?.code, "incomplete_node");
      assert.equal(resumed.error?.nodeId, "implement");

      // The mutating worker was NOT re-run
      assert.equal(fake.requests.filter((r) => r.nodeId === "implement").length, 0);

      // Lock released, failure events present
      assert.equal(await engine.getActiveRun(), null);
      const events = await readEvents(runDirOf(tmpDir, runId));
      assert.ok(events.some((e) => e.event === "node.failed" && e.node === "implement"));
      assert.ok(events.some((e) => e.event === "workflow.failed"));
    });

    it("M2: resuming an implement with a persisted result re-hydrates it instead of re-running the worker", async () => {
      const baseDir = baseDirOf(tmpDir);
      const runId = "wf_m2_impl_artifact";
      await saveWorkflowRun(baseDir, makeRunState(runId, "implementing"));
      await setActiveRunId(baseDir, runId);
      // The worker persisted its result; the transition to testing was lost.
      await saveArtifact(baseDir, runId, "implementation.json", makeImpl());

      const fake = new FakeAgentExecutor();
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const resumed = await engine.resume(runId);

      // Gate passes (makeImpl's tests pass) → testing, ready for /work review
      assert.equal(resumed.state, "testing");
      assert.equal(fake.requests.filter((r) => r.nodeId === "implement").length, 0);

      const loaded = await loadWorkflowRun(baseDir, runId);
      assert.ok(loaded.implementation, "implementation re-hydrated from artifact");
      const events = await readEvents(runDirOf(tmpDir, runId));
      assert.ok(events.some((e) => e.event === "gate.test"));
      assert.ok(events.some((e) => e.event === "node.completed" && e.node === "implement"));
    });

    it("M2: resuming a fixing state with a persisted fix result re-hydrates it instead of re-running the fixer", async () => {
      const baseDir = baseDirOf(tmpDir);
      const runId = "wf_m2_fix_artifact";
      await saveWorkflowRun(
        baseDir,
        makeRunState(runId, "fixing", { implementation: makeImpl(), fixes: [makeFix({ round: 1 })] })
      );
      await setActiveRunId(baseDir, runId);
      // fix-2 persisted its result; the transition to testing was lost.
      await saveArtifact(baseDir, runId, "fixes/fix-2.json", makeFix({ round: 2 }));

      const fake = new FakeAgentExecutor();
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const resumed = await engine.resume(runId);

      // fix-2 is re-hydrated, the review node runs (round 1) and passes
      assert.equal(resumed.state, "completed");
      assert.equal(fake.requests.filter((r) => r.nodeId === "fix-2").length, 0);
      const reviewCalls = fake.requests.filter((r) => r.nodeId.startsWith("review"));
      assert.equal(reviewCalls.length, 1);

      const loaded = await loadWorkflowRun(baseDir, runId);
      assert.equal(loaded.fixes.length, 2);
      assert.equal(loaded.fixes[1]?.round, 2);
    });

    it("M2: resuming an interrupted fix node without a persisted result fails safely instead of re-running the fixer", async () => {
      const baseDir = baseDirOf(tmpDir);
      const runId = "wf_m2_fix_crash";
      await saveWorkflowRun(
        baseDir,
        makeRunState(runId, "fixing", { implementation: makeImpl(), fixes: [makeFix({ round: 1 })] })
      );
      await setActiveRunId(baseDir, runId);
      // The process died after node.started(fix-2), before any result persisted.
      await appendWorkflowEvent(baseDir, runId, { event: "node.started", state: "fixing", node: "fix-2" });

      const fake = new FakeAgentExecutor();
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const resumed = await engine.resume(runId);

      assert.equal(resumed.state, "failed");
      assert.equal(resumed.error?.code, "incomplete_node");
      assert.equal(resumed.error?.nodeId, "fix-2");
      assert.equal(fake.requests.filter((r) => r.nodeId === "fix-2").length, 0);
      assert.equal(await engine.getActiveRun(), null);
    });
  });

  describe("Wrap-up (2026-08-21) — /work plan keeps explicit-mode semantics", () => {
    it("bare /work plan scouts first, stays in defaultMode, and does not complexity-route", async () => {
      // Even with a low-complexity plan, /work plan without a mode flag is
      // NOT auto-routed: complexity routing is /work auto only (§25/§26).
      const fake = new FakeAgentExecutor({ plan: makePlan({ complexity: "low" }) });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startPlan("small fix");

      assert.equal(run.state, "plan_ready");
      assert.equal(run.mode, "normal", "defaultMode is kept; no routing to quick");
      assert.equal(run.maxReviewRounds, 3);
      assert.equal(run.autoRouted, false);
      assert.equal(run.modeResolved, true);
      const ids = fake.requests.map((r) => r.nodeId);
      assert.deepEqual(ids, ["scout", "plan"], "normal mode scouts before planning");
      const planReq = fake.requests.find((r) => r.nodeId === "plan")!;
      assert.match(planReq.task, /Scout Exploration Summary/);
    });
  });

  describe("Finding 13 — intercom detach hardening", () => {
    it("retries a detached planner once with a coordination prohibition appended", async () => {
      const detachError =
        'Detached for intercom coordination: planner. Reply to the supervisor request first, ' +
        'then wait with subagent_wait({ id: "ef25b0c7-f3d8-47b1-8b2a-cb949f19f6cd" }).';
      let calls = 0;
      const fake = new FakeAgentExecutor();
      fake.setHandler("plan", () => {
        calls++;
        if (calls === 1) return { status: "failed", error: detachError };
        return { status: "completed", result: makePlan() };
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startPlan("task", { mode: "quick" });

      assert.equal(run.state, "plan_ready");
      assert.equal(calls, 2, "detached node gets exactly one retry (agent retry budget)");
      const planReqs = fake.requests.filter((r) => r.nodeId === "plan");
      assert.equal(planReqs.length, 2);
      // The reminder phrase is retry-specific (the base prompt already bans
      // coordination tools via the Autonomy Constraint section).
      assert.doesNotMatch(planReqs[0].task, /previous attempt was discarded/i);
      assert.match(planReqs[1].task, /previous attempt was discarded/i);
      assert.match(planReqs[1].task, /contact_supervisor/);
    });

    it("fails the node when the retry also detaches, without extra attempts", async () => {
      const detachError = "Detached for intercom coordination before task completion.";
      let calls = 0;
      const fake = new FakeAgentExecutor();
      fake.setHandler("plan", () => {
        calls++;
        return { status: "failed", error: detachError };
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startPlan("task", { mode: "quick" });

      assert.equal(run.state, "failed");
      assert.equal(run.error?.code, "agent_execution_failed");
      assert.equal(calls, 2, "one initial attempt + one retry, then fail");
      assert.equal(await engine.getActiveRun(), null);
    });

    it("worker refusal fails fast after exactly one attempt (Finding 14)", async () => {
      const refusal =
        "Subagent completed without making edits for an implementation task. " +
        "It appears to have returned planning or scratchpad output instead of applying changes.";
      let workerCalls = 0;
      const fake = new FakeAgentExecutor();
      fake.setHandler("worker", () => {
        workerCalls++;
        return { status: "failed", error: refusal };
      });
      const engine = new WorkflowEngine({ cwd: tmpDir, executor: fake, sleep: noSleep });

      const run = await engine.startAuto("contradictory task", { mode: "quick" });

      assert.equal(run.state, "failed");
      assert.equal(run.error?.code, "agent_execution_failed");
      assert.equal(run.error?.nodeId, "implement");
      assert.match(run.error?.message ?? "", /declined to modify the repository/i);
      assert.equal(workerCalls, 1, "no verbatim retry on a deterministic refusal");
      assert.equal(await engine.getActiveRun(), null);
    });

    it("every node prompt carries the autonomy constraint", () => {
      const plan = makePlan();
      const prompts: Array<[string, string]> = [
        ["scout", buildScoutPrompt({ task: "t" })],
        ["planner", buildPlannerPrompt({ task: "t" })],
        ["worker", buildWorkerPrompt({ task: "t", plan })],
        ["reviewer", buildReviewerPrompt({ task: "t", plan, round: 1 })],
        ["fixer", buildFixerPrompt({ task: "t", plan, findings: [], round: 1 })],
      ];
      for (const [name, p] of prompts) {
        assert.match(p, /Autonomy Constraint/, `${name} prompt missing the constraint section`);
        assert.match(p, /contact_supervisor/, `${name} prompt missing the tool prohibition`);
      }
    });
  });
});

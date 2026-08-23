import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  WorkflowEngine,
  requiredRolesForRun,
  synthesizeSpecPlan,
  type WorkflowEngineOptions,
} from "../src/engine/engine.ts";
import { canTransition } from "../src/engine/transitions.ts";
import { appendWorkflowEvent } from "../src/storage/events.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";
import { FakeVerificationRunner } from "./fake-verification.ts";
import { validateWorkflowPreflight } from "../src/agents/preflight.ts";
import { DEFAULT_WORKFLOW_CONFIG, type WorkflowRun } from "../src/contracts/workflow.ts";
import { saveWorkflowRun, saveArtifact } from "../src/storage/store.ts";
import { evaluatePlanGate } from "../src/gates/plan-gate.ts";

function createSpecEngine(options: WorkflowEngineOptions): WorkflowEngine {
  return new WorkflowEngine({
    ...options,
    verificationRunner: options.verificationRunner ?? new FakeVerificationRunner(),
  });
}

describe("Spec-Driven Workflow (/work spec)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-wf-spec-test-"));
  });

  async function writeSpec(content: string, name = "spec.md"): Promise<string> {
    const specPath = path.join(tmpDir, name);
    await fs.writeFile(specPath, content, "utf-8");
    return specPath;
  }

  it("runs implement → review without any planner or scout agent", async () => {
    const specPath = await writeSpec(
      "# Add greeting module\n\nImplement `greet(name)` returning `\"hello <name>\"`."
    );
    const fakeExecutor = new FakeAgentExecutor();
    const engine = createSpecEngine({ cwd: tmpDir, executor: fakeExecutor });

    const run = await engine.startSpec(specPath, { mode: "quick" });

    assert.equal(run.state, "completed");
    assert.equal(run.reviewRound, 1);
    assert.ok(run.plan);
    assert.ok(run.implementation);

    const nodeIds = fakeExecutor.requests.map((r) => r.nodeId);
    assert.ok(!nodeIds.includes("scout"), "spec flow must not run the scout node");
    assert.ok(!nodeIds.includes("plan"), "spec flow must not run the planner node");
    assert.equal(nodeIds[0], "implement");
    assert.ok(nodeIds.includes("review-1"));
  });

  it("runs declared verification commands in order before review", async () => {
    const specPath = await writeSpec(`---
work:
  verify:
    - npm test
    - npm run typecheck
---
# Spec
`);
    const executor = new FakeAgentExecutor();
    const verificationRunner = new FakeVerificationRunner();
    const run = await createSpecEngine({
      cwd: tmpDir,
      executor,
      verificationRunner,
    }).startSpec(specPath);

    assert.equal(run.state, "completed");
    assert.deepEqual(verificationRunner.calls, [
      { command: "npm test", cwd: tmpDir },
      { command: "npm run typecheck", cwd: tmpDir },
    ]);
    assert.deepEqual(run.verification?.commands.map((result) => result.command), [
      "npm test",
      "npm run typecheck",
    ]);
    assert.equal(executor.requests[1].nodeId, "review-1");
  });

  it("routes failed engine verification through a bounded fix before review", async () => {
    const specPath = await writeSpec("# Spec\n\nImplement and verify.\n");
    const executor = new FakeAgentExecutor();
    const verificationRunner = new FakeVerificationRunner(["failed", "passed"]);
    const run = await createSpecEngine({
      cwd: tmpDir,
      executor,
      verificationRunner,
    }).startSpec(specPath, { mode: "quick" });

    assert.equal(run.state, "completed");
    assert.deepEqual(executor.requests.map((request) => request.nodeId), [
      "implement",
      "fix-1",
      "review-1",
    ]);
    assert.equal(run.reviewRound, 1, "verification-driven fixes do not consume review rounds");
    assert.match(executor.requests[1].task, /Engine Verification Failures/);
    assert.match(executor.requests[1].task, /command failed/);
    assert.deepEqual(verificationRunner.calls.map((call) => call.command), ["npm test", "npm test"]);
  });

  it("rehydrates completed verification artifacts on resume", async () => {
    const specPath = await writeSpec("# Spec\n\nResume verified work.\n");
    const executor = new FakeAgentExecutor();
    const initial = await createSpecEngine({ cwd: tmpDir, executor }).startSpec(specPath);
    initial.state = "implementing";
    initial.reviews = [];
    initial.verification = undefined;
    await saveWorkflowRun(path.join(tmpDir, ".pi", "workflow"), initial);

    const resumeRunner = new FakeVerificationRunner(["failed"]);
    const resumed = await createSpecEngine({
      cwd: tmpDir,
      executor: new FakeAgentExecutor(),
      verificationRunner: resumeRunner,
    }).resume(initial.id);

    assert.equal(resumed.state, "testing");
    assert.equal(resumeRunner.calls.length, 0);
    assert.equal(resumed.verification?.status, "passed");
  });

  it("reports verification infrastructure failure distinctly", async () => {
    const specPath = await writeSpec("# Spec\n\nVerify safely.\n");
    const executor = new FakeAgentExecutor();
    const run = await createSpecEngine({
      cwd: tmpDir,
      executor,
      verificationRunner: {
        run: async () => {
          throw new Error("shell unavailable");
        },
      },
    }).startSpec(specPath);

    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "verification_failed");
    assert.ok(executor.requests.every((request) => !request.nodeId.startsWith("review")));
  });

  it("preserves strict reviewer routing after deterministic gates pass", async () => {
    const specPath = await writeSpec("# Strict spec\n\nReview independently.\n");
    const executor = new FakeAgentExecutor();
    const run = await createSpecEngine({ cwd: tmpDir, executor }).startSpec(specPath, {
      mode: "strict",
    });

    assert.equal(run.state, "completed");
    assert.deepEqual(executor.requests.map((request) => request.nodeId), [
      "implement",
      "review-1-a",
      "review-1-b",
      "review-1-final",
    ]);
  });

  it("fails with required_tests_failed when verification fixes are exhausted", async () => {
    const specPath = await writeSpec("# Spec\n\nVerification must pass.\n");
    const executor = new FakeAgentExecutor();
    const run = await createSpecEngine({
      cwd: tmpDir,
      executor,
      verificationRunner: new FakeVerificationRunner(["failed"]),
    }).startSpec(specPath, { mode: "quick" });

    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "required_tests_failed");
    assert.deepEqual(executor.requests.map((request) => request.nodeId), [
      "implement",
      "fix-1",
      "fix-2",
    ]);
  });

  it("persists exact immutable bytes and references them from every prompt", async () => {
    const specBody = "The widget MUST render exactly three trace lines.";
    const source = `# Widget spec\n\n${specBody}\n`;
    const specPath = await writeSpec(source);
    const fakeExecutor = new FakeAgentExecutor();
    const engine = createSpecEngine({ cwd: tmpDir, executor: fakeExecutor });

    const run = await engine.startSpec(specPath);
    assert.ok(run.requirement);
    assert.doesNotMatch(run.request, new RegExp(specBody));

    const runDir = path.join(tmpDir, ".pi", "workflow", "runs", run.id);
    const snapshot = await fs.readFile(path.join(runDir, "requirement.md"), "utf-8");
    assert.equal(snapshot, source);

    for (const request of fakeExecutor.requests) {
      assert.doesNotMatch(request.task, new RegExp(specBody));
      assert.match(request.task, /Immutable run snapshot \(read-only\)/);
      assert.match(request.task, new RegExp(run.requirement.sha256));
      assert.match(request.task, /Do not edit either/);
    }

    const state = await fs.readFile(path.join(runDir, "state.json"), "utf-8");
    const events = await fs.readFile(path.join(runDir, "events.jsonl"), "utf-8");
    assert.doesNotMatch(state, new RegExp(specBody));
    assert.doesNotMatch(events, new RegExp(specBody));

    await fs.writeFile(specPath, "# Changed source\n", "utf-8");
    assert.equal(await fs.readFile(path.join(runDir, "requirement.md"), "utf-8"), source);
  });

  it("persists a synthesized plan that passes the plan gate", async () => {
    const specPath = await writeSpec("# Spec\n\nDo the thing.");
    const fakeExecutor = new FakeAgentExecutor();
    const engine = createSpecEngine({ cwd: tmpDir, executor: fakeExecutor });

    const run = await engine.startSpec(specPath);

    const gate = evaluatePlanGate(run.plan!);
    assert.ok(gate.pass, `synthesized plan must pass the gate: ${gate.error}`);

    const planJson = JSON.parse(
      await fs.readFile(path.join(tmpDir, ".pi", "workflow", "runs", run.id, "plan.json"), "utf-8")
    );
    assert.match(planJson.summary, /spec\.md/);
    assert.equal(planJson.files[0].action, "inspect");
  });

  it("fixes review findings and completes in round 2", async () => {
    const specPath = await writeSpec("# Spec\n\nHandle empty input.");
    const fakeExecutor = new FakeAgentExecutor({
      review: [
        {
          verdict: "REQUEST_CHANGES",
          summary: "Empty input crashes",
          findings: [
            {
              id: "finding-1",
              severity: "major",
              category: "correctness",
              description: "greet() crashes on empty name",
              evidence: "src/greet.ts:12",
            },
          ],
          testAssessment: { sufficient: true, explanation: "" },
          confidence: 0.9,
        },
        { verdict: "PASS", summary: "Fixed", findings: [], testAssessment: { sufficient: true, explanation: "" }, confidence: 0.95 },
      ],
    });
    const engine = createSpecEngine({ cwd: tmpDir, executor: fakeExecutor });

    const run = await engine.startSpec(specPath);

    assert.equal(run.state, "completed");
    assert.equal(run.reviewRound, 2);
    assert.equal(run.fixes.length, 1);
    // The fixer receives the same immutable snapshot contract.
    const fixRequest = fakeExecutor.requests.find((request) => request.nodeId === "fix-1");
    assert.ok(fixRequest);
    assert.match(fixRequest.task, /Authoritative Requirement Snapshot/);
    assert.match(fixRequest.task, new RegExp(run.requirement!.sha256));
  });

  it("fails the review budget like /work auto", async () => {
    const specPath = await writeSpec("# Spec\n\nImpossible bar.");
    const fakeExecutor = new FakeAgentExecutor({
      review: [
        {
          verdict: "REQUEST_CHANGES",
          summary: "No",
          findings: [
            { id: "f1", severity: "blocker", category: "correctness", description: "Still wrong", evidence: "x" },
          ],
          testAssessment: { sufficient: false, explanation: "" },
          confidence: 0.9,
        },
      ],
    });
    const engine = createSpecEngine({ cwd: tmpDir, executor: fakeExecutor, config: { maxReviewRounds: 2 } });

    const run = await engine.startSpec(specPath);

    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "review_budget_exhausted");
  });

  it("rejects a missing spec file before creating any run or lock", async () => {
    const fakeExecutor = new FakeAgentExecutor();
    const engine = createSpecEngine({ cwd: tmpDir, executor: fakeExecutor });

    await assert.rejects(
      engine.startSpec(path.join(tmpDir, "does-not-exist.md")),
      /Cannot read spec file/
    );

    assert.deepEqual(await engine.listRuns(), []);
    assert.equal(await engine.getActiveRun(), null);
  });

  it("rejects an empty spec file", async () => {
    const specPath = await writeSpec("   \n  \n");
    const engine = createSpecEngine({ cwd: tmpDir, executor: new FakeAgentExecutor() });

    await assert.rejects(engine.startSpec(specPath), /is empty/);
  });

  it("allows the created → plan_ready transition (deterministic spec plan)", () => {
    assert.equal(canTransition("created", "plan_ready"), true);
    assert.equal(canTransition("created", "implementing"), false);
  });

  it("preflights only the worker and reviewer roles for the spec flow", async () => {
    const config = {
      ...DEFAULT_WORKFLOW_CONFIG,
      agents: {
        scout: "",
        planner: "",
        worker: "worker",
        reviewer: "reviewer",
      },
    };
    const importStub = () =>
      Promise.resolve({
        resolveSubagentLaunchContract: async () => ({ ok: true }),
      });

    const specFlow = await validateWorkflowPreflight(config, tmpDir, "normal", importStub, [
      "worker",
      "reviewer",
    ]);
    assert.equal(specFlow.ok, true, "unconfigured scout/planner must not block the spec flow");

    const normalFlow = await validateWorkflowPreflight(config, tmpDir, "normal", importStub);
    assert.equal(normalFlow.ok, false, "normal mode still requires scout and planner");
  });

  it("selects roles centrally from source and mode", () => {
    assert.deepEqual(requiredRolesForRun({ source: "spec", mode: "strict" }), [
      "worker",
      "reviewer",
    ]);
    assert.deepEqual(requiredRolesForRun({ source: "plan", mode: "quick" }), [
      "planner",
      "worker",
      "reviewer",
    ]);
    assert.deepEqual(requiredRolesForRun({ source: "auto", mode: "normal" }), [
      "scout",
      "planner",
      "worker",
      "reviewer",
    ]);
  });

  it("synthesizes a spec plan whose test entry is required", () => {
    const plan = synthesizeSpecPlan("docs/feature.spec.md");
    assert.equal(plan.tests[0].required, true);
    assert.ok(plan.steps.length >= 3);
    assert.equal(plan.complexity, "medium");
  });

  it("persists source and specPath on the run record", async () => {
    const specPath = await writeSpec("# Spec\n\nDo the thing.");
    const engine = createSpecEngine({ cwd: tmpDir, executor: new FakeAgentExecutor() });

    const run = await engine.startSpec(specPath);

    assert.equal(run.source, "spec");
    assert.equal(run.specPath, "spec.md");
  });

  it("rejects an oversized spec before creating any run", async () => {
    const specPath = await writeSpec("# Big\n\n" + "x".repeat(100_001));
    const fakeExecutor = new FakeAgentExecutor();
    const engine = createSpecEngine({ cwd: tmpDir, executor: fakeExecutor });

    await assert.rejects(engine.startSpec(specPath), /too large/);
    assert.deepEqual(await engine.listRuns(), []);
    assert.equal(await engine.getActiveRun(), null);
  });

  /** Craft a persisted spec-driven run in an interrupted state. */
  async function craftSpecRun(state: "created" | "planning", extra?: Partial<WorkflowRun>): Promise<string> {
    const runId = `wf_spec_resume_${state}_${Math.random().toString(16).slice(2, 6)}`;
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      version: 1,
      id: runId,
      cwd: tmpDir,
      createdAt: now,
      updatedAt: now,
      state,
      mode: "quick",
      request: 'Spec-driven workflow: implement the specification document "spec.md".',
      reviewRound: 1,
      maxReviewRounds: 2,
      reviews: [],
      fixes: [],
      baseline: { dirty: false, status: [], startedAt: now },
      autoRouted: false,
      modeResolved: true,
      source: "spec",
      specPath: "spec.md",
      ...extra,
    };
    await saveWorkflowRun(path.join(tmpDir, ".pi", "workflow"), run);
    return runId;
  }

  it("resume restores the deterministic spec plan without running planner or scout", async () => {
    await writeSpec("# Spec\n\nResumed work.");
    const runId = await craftSpecRun("created");
    const fakeExecutor = new FakeAgentExecutor();
    const engine = createSpecEngine({ cwd: tmpDir, executor: fakeExecutor });

    const run = await engine.resume(runId);

    assert.equal(run.state, "completed");
    const nodeIds = fakeExecutor.requests.map((r) => r.nodeId);
    assert.ok(!nodeIds.includes("plan"), "resume must not run the planner for a spec run");
    assert.ok(!nodeIds.includes("scout"), "resume must not run the scout for a spec run");
    assert.ok(nodeIds.includes("implement"));
    assert.ok(nodeIds.includes("review-1"));
  });

  it("resume loads a persisted plan.json artifact for an interrupted spec run", async () => {
    await writeSpec("# Spec\n\nResumed work.");
    const runId = await craftSpecRun("planning");
    // Simulate: plan was synthesized and persisted, then the process died
    // before the plan_ready transition (run.plan absent from state.json).
    await saveArtifact(path.join(tmpDir, ".pi", "workflow"), runId, "plan.json", synthesizeSpecPlan("spec.md"));

    const fakeExecutor = new FakeAgentExecutor();
    const engine = createSpecEngine({ cwd: tmpDir, executor: fakeExecutor });

    const run = await engine.resume(runId);

    assert.equal(run.state, "completed");
    assert.ok(run.plan);
    assert.ok(fakeExecutor.requests.every((r) => r.nodeId !== "plan" && r.nodeId !== "scout"));
  });

  it("fails before agent execution when immutable snapshot metadata is untrustworthy", async () => {
    const runId = await craftSpecRun("created", {
      request: "immutable spec run",
      requirement: {
        kind: "spec",
        sourcePath: "spec.md",
        artifactPath: "requirement.md",
        sha256: "0".repeat(64),
        characters: 12,
      },
      specPolicy: { verification: [{ command: "npm test", required: true }] },
    });
    await saveArtifact(
      path.join(tmpDir, ".pi", "workflow"),
      runId,
      "requirement.md",
      "tampered"
    );
    const executor = new FakeAgentExecutor();
    const run = await createSpecEngine({ cwd: tmpDir, executor }).resume(runId);

    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "requirement_corrupt");
    assert.equal(executor.requests.length, 0);
  });

  it("migrates an embedded legacy requirement instead of rereading its source", async () => {
    await writeSpec("# Mutable source\n");
    const embedded = "# Frozen legacy requirement\n\nImplement the frozen behavior.";
    const runId = await craftSpecRun("created", {
      request: `Legacy\n\n--- SPECIFICATION BEGIN ---\n${embedded}\n--- SPECIFICATION END ---`,
    });
    await fs.writeFile(path.join(tmpDir, "spec.md"), "# Source changed\n", "utf-8");

    const run = await createSpecEngine({
      cwd: tmpDir,
      executor: new FakeAgentExecutor(),
    }).resume(runId);
    const runDir = path.join(tmpDir, ".pi", "workflow", "runs", runId);

    assert.ok(run.requirement);
    assert.equal(await fs.readFile(path.join(runDir, "requirement.md"), "utf-8"), embedded);
    const events = await fs.readFile(path.join(runDir, "events.jsonl"), "utf-8");
    assert.equal(events.match(/spec\.snapshot_migrated/g)?.length, 1);
  });

  it("rejects source fallback after a legacy mutating node started", async () => {
    await writeSpec("# Current mutable source\n");
    const runId = await craftSpecRun("created");
    await appendWorkflowEvent(path.join(tmpDir, ".pi", "workflow"), runId, {
      event: "node.started",
      state: "implementing",
      node: "implement",
    });
    const executor = new FakeAgentExecutor();

    const run = await createSpecEngine({ cwd: tmpDir, executor }).resume(runId);
    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "requirement_corrupt");
    assert.equal(executor.requests.length, 0);
  });

  it("resume fails safely when a spec run has no plan and no specPath", async () => {
    await writeSpec("# Spec\n\nUnrecoverable.");
    const runId = await craftSpecRun("created", { specPath: undefined });

    const engine = createSpecEngine({ cwd: tmpDir, executor: new FakeAgentExecutor() });
    const run = await engine.resume(runId);

    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "requirement_corrupt");
    assert.equal(await engine.getActiveRun(), null);
  });
});

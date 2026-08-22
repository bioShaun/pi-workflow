import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorkflowEngine, synthesizeSpecPlan } from "../src/engine/engine.ts";
import { canTransition } from "../src/engine/transitions.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";
import { validateWorkflowPreflight } from "../src/agents/preflight.ts";
import { DEFAULT_WORKFLOW_CONFIG } from "../src/contracts/workflow.ts";
import { evaluatePlanGate } from "../src/gates/plan-gate.ts";

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
    const engine = new WorkflowEngine({ cwd: tmpDir, executor: fakeExecutor });

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

  it("embeds the spec verbatim in every node prompt and persists it as the request", async () => {
    const specBody = "The widget MUST render exactly three trace lines.";
    const specPath = await writeSpec(`# Widget spec\n\n${specBody}\n`);
    const fakeExecutor = new FakeAgentExecutor();
    const engine = new WorkflowEngine({ cwd: tmpDir, executor: fakeExecutor });

    const run = await engine.startSpec(specPath);

    assert.match(run.request, /SPECIFICATION BEGIN/);
    assert.match(run.request, new RegExp(specBody));

    // Worker and fresh reviewer both receive the spec through the
    // "Original Requirement" section.
    for (const request of fakeExecutor.requests) {
      assert.match(request.task, new RegExp(specBody), `node ${request.nodeId} missed the spec`);
    }

    const requestMd = await fs.readFile(
      path.join(tmpDir, ".pi", "workflow", "runs", run.id, "request.md"),
      "utf-8"
    );
    assert.match(requestMd, /SPECIFICATION BEGIN/);
  });

  it("persists a synthesized plan that passes the plan gate", async () => {
    const specPath = await writeSpec("# Spec\n\nDo the thing.");
    const fakeExecutor = new FakeAgentExecutor();
    const engine = new WorkflowEngine({ cwd: tmpDir, executor: fakeExecutor });

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
    const engine = new WorkflowEngine({ cwd: tmpDir, executor: fakeExecutor });

    const run = await engine.startSpec(specPath);

    assert.equal(run.state, "completed");
    assert.equal(run.reviewRound, 2);
    assert.equal(run.fixes.length, 1);
    // The fixer prompt carries the spec (Original Requirement) too.
    const fixRequest = fakeExecutor.requests.find((r) => r.nodeId === "fix-1");
    assert.ok(fixRequest);
    assert.match(fixRequest.task, /SPECIFICATION BEGIN/);
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
    const engine = new WorkflowEngine({ cwd: tmpDir, executor: fakeExecutor, config: { maxReviewRounds: 2 } });

    const run = await engine.startSpec(specPath);

    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "review_budget_exhausted");
  });

  it("rejects a missing spec file before creating any run or lock", async () => {
    const fakeExecutor = new FakeAgentExecutor();
    const engine = new WorkflowEngine({ cwd: tmpDir, executor: fakeExecutor });

    await assert.rejects(
      engine.startSpec(path.join(tmpDir, "does-not-exist.md")),
      /Cannot read spec file/
    );

    assert.deepEqual(await engine.listRuns(), []);
    assert.equal(await engine.getActiveRun(), null);
  });

  it("rejects an empty spec file", async () => {
    const specPath = await writeSpec("   \n  \n");
    const engine = new WorkflowEngine({ cwd: tmpDir, executor: new FakeAgentExecutor() });

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

  it("synthesizes a spec plan whose test entry is required", () => {
    const plan = synthesizeSpecPlan("docs/feature.spec.md");
    assert.equal(plan.tests[0].required, true);
    assert.ok(plan.steps.length >= 3);
    assert.equal(plan.complexity, "medium");
  });
});

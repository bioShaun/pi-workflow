import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import type { WorkflowRole } from "../src/agents/preflight.ts";
import { renderStatus } from "../src/commands/renderer.ts";
import { WorkflowEngine, type AgentRoles } from "../src/engine/engine.ts";
import { saveWorkflowRun } from "../src/storage/store.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";

import { FakeVerificationRunner } from "./fake-verification.ts";
const execFileAsync = promisify(execFile);
const agents: AgentRoles = {
  scout: "scout",
  planner: "planner",
  worker: "worker",
  reviewer: "reviewer",
};

describe("Ticket-orchestrated run creation", () => {
  let cwd: string;
  let specPath: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(process.cwd(), ".scratch", "ticket-flow-test-"));
    specPath = path.join(cwd, "spec.md");
    await fs.writeFile(specPath, `# Epic

## Acceptance Criteria

1. Greeting works.
2. Greeting is documented.
`, "utf-8");
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  async function writeImportedTickets(): Promise<string> {
    const dir = path.join(cwd, "issues");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "01-greeting.md"), `# T1: Greeting
Capability: Users receive greetings
Kind: behavioral
Blocked by: none
Testing seam: Call greet(name)
TDD: required
Red command: npm test
Covers: AC-1
Verify:
- npm test
## Acceptance Criteria
- Greeting works
`, "utf-8");
    await fs.writeFile(path.join(dir, "02-docs.md"), `# T2: Documentation
Capability: Users discover greeting usage
Kind: documentation
Blocked by: T1
Testing seam: Render documentation
TDD: exempt
TDD exemption: Documentation-only change
Covers: AC-2
Verify:
- npm run typecheck
## Acceptance Criteria
- Greeting is documented
`, "utf-8");
    return dir;
  }

  it("creates an inspectable imported run with worker/reviewer preflight only", async () => {
    const ticketDir = await writeImportedTickets();
    let requiredRoles: WorkflowRole[] = [];
    const engine = new WorkflowEngine({
      cwd,
      executor: new FakeAgentExecutor(),
      preflightForMode: async (_mode, roles) => {
        requiredRoles = roles;
        return agents;
      },
    });

    const run = await engine.startTickets(specPath, { ticketDir, mode: "quick", prepareOnly: true });
    assert.equal(run.state, "executing_tickets");
    assert.equal(run.source, "tickets");
    assert.equal(run.ticketGraphSource, "imported");
    assert.deepEqual(requiredRoles, ["worker", "reviewer"]);
    assert.equal(run.ticketPlan?.ticketCount, 2);
    assert.deepEqual(run.tickets?.map((ticket) => ticket.phase), ["pending", "pending"]);

    const status = renderStatus(run);
    assert.match(status, /Tickets: 0\/2 completed/);
    assert.match(status, /Ready: 1/);
    assert.match(status, /Blocked: 1/);
    assert.match(status, /Next: Start T1: Greeting/);
    assert.doesNotMatch(status, new RegExp(run.id));
  });

  it("generates with planner preflight and persists the distinct source kind", async () => {
    const executor = new FakeAgentExecutor();
    executor.setHandler("ticketizer", () => ({
      status: "completed",
      result: {
        tickets: [{
          id: "T1",
          title: "Whole epic",
          capability: "Users receive and discover greetings",
          kind: "behavioral",
          acceptanceCriteria: ["Greeting works and is documented"],
          blockedBy: [],
          testingSeam: "Call and document greet(name)",
          verification: [{ command: "npm test", required: true }],
          redCommand: "npm test",
          tdd: { policy: "required" },
          covers: ["AC-1", "AC-2"],
        }],
        finalGate: { acceptanceCriteria: [], covers: [], verification: [] },
      },
    }));
    let requiredRoles: WorkflowRole[] = [];
    const run = await new WorkflowEngine({
      cwd,
      executor,
      preflightForMode: async (_mode, roles) => {
        requiredRoles = roles;
        return agents;
      },
    }).startTickets(specPath, { prepareOnly: true });

    assert.equal(run.state, "executing_tickets");
    assert.equal(run.ticketGraphSource, "generated");
    assert.deepEqual(requiredRoles, ["planner", "worker", "reviewer"]);
    assert.deepEqual(executor.requests.map((request) => request.nodeId), ["ticketizer"]);
  });

  it("completes a non-behavioral exempt ticket without a red phase", async () => {
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await fs.writeFile(specPath, "# Docs\n\n## Acceptance Criteria\n\n1. Usage is documented.\n", "utf-8");
    const dir = path.join(cwd, "docs-issues");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "01-docs.md"), `# D1: Document usage
Capability: Users can discover usage
Kind: documentation
Blocked by: none
Testing seam: Render documentation
TDD: exempt
TDD exemption: Documentation-only output has no meaningful failing behavioral test
Covers: AC-1
Verify:
- npm run typecheck
## Acceptance Criteria
- Usage is documented
`, "utf-8");
    const executor = new FakeAgentExecutor();
    const verificationRunner = new FakeVerificationRunner();
    const run = await new WorkflowEngine({
      cwd,
      executor,
      verificationRunner,
      preflightForMode: async () => agents,
    }).startTickets(specPath, { ticketDir: dir, mode: "quick" });

    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.equal(run.tickets?.[0].phase, "ticket_completed");
    assert.equal(run.tickets?.[0].verification?.status, "passed");
    assert.equal(run.tickets?.[0].scope?.status, "passed");
    assert.equal(run.tickets?.[0].review?.verdict, "PASS");
    assert.deepEqual(executor.requests.map((request) => request.nodeId), [
      "ticket-D1-implement",
      "ticket-D1-review-1",
      "ticket-final-review-1",
    ]);
    assert.ok(executor.requests.every((request) => request.context === "fresh"));
    assert.deepEqual(verificationRunner.calls.map((call) => call.command), ["npm run typecheck", "npm test"]);
  });

  it("requires engine-observed red evidence before behavioral implementation", async () => {
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await fs.writeFile(specPath, "# Greeting\n\n## Acceptance Criteria\n\n1. Greeting works.\n", "utf-8");
    const dir = path.join(cwd, "behavior-issues");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "01-greeting.md"), `# B1: Greeting behavior
Capability: Users receive greetings
Kind: behavioral
Blocked by: none
Testing seam: Call greet(name)
TDD: required
Red command: npm test
Covers: AC-1
Verify:
- npm test
## Acceptance Criteria
- Greeting works
`, "utf-8");
    const executor = new FakeAgentExecutor();
    executor.setHandler("ticket-B1-red", async () => {
      await fs.writeFile(path.join(cwd, "greet.test.ts"), "failing test\n", "utf-8");
      return {
        status: "completed",
        result: {
          summary: "Added smallest greeting test",
          expectedFailure: "command failed",
          changedTestPaths: ["greet.test.ts"],
          existingReproduction: false,
        },
      };
    });
    const verificationRunner = new FakeVerificationRunner(["failed", "passed"]);
    const run = await new WorkflowEngine({
      cwd,
      executor,
      verificationRunner,
      preflightForMode: async () => agents,
    }).startTickets(specPath, { ticketDir: dir, mode: "quick" });

    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.equal(run.tickets?.[0].red?.status, "passed");
    assert.deepEqual(executor.requests.map((request) => request.nodeId), [
      "ticket-B1-red",
      "ticket-B1-implement",
      "ticket-B1-review-1",
      "ticket-final-review-1",
    ]);
    assert.deepEqual(verificationRunner.calls.map((call) => call.command), ["npm test", "npm test", "npm test"]);
  });

  it("rejects a passing red command before implementation", async () => {
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await fs.writeFile(specPath, "# Greeting\n\n## Acceptance Criteria\n\n1. Greeting works.\n", "utf-8");
    const dir = path.join(cwd, "invalid-red-issues");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "01-greeting.md"), `# B1: Greeting behavior
Capability: Users receive greetings
Kind: behavioral
Blocked by: none
Testing seam: Call greet(name)
TDD: required
Red command: npm test
Covers: AC-1
Verify:
- npm test
## Acceptance Criteria
- Greeting works
`, "utf-8");
    const executor = new FakeAgentExecutor();
    executor.setHandler("ticket-B1-red", async () => {
      await fs.writeFile(path.join(cwd, "greet.test.ts"), "test\n", "utf-8");
      return {
        status: "completed",
        result: {
          summary: "Added test",
          expectedFailure: "command failed",
          changedTestPaths: ["greet.test.ts"],
          existingReproduction: false,
        },
      };
    });
    const run = await new WorkflowEngine({
      cwd,
      executor,
      verificationRunner: new FakeVerificationRunner(["passed"]),
      preflightForMode: async () => agents,
    }).startTickets(specPath, { ticketDir: dir, mode: "quick" });

    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "invalid_red_evidence");
    assert.deepEqual(executor.requests.map((request) => request.nodeId), ["ticket-B1-red"]);
  });

  it("reruns deterministic gates after a ticket-scoped fix", async () => {
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await fs.writeFile(specPath, "# Docs\n\n## Acceptance Criteria\n\n1. Usage is documented.\n", "utf-8");
    const dir = path.join(cwd, "fix-issues");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "01-docs.md"), `# D1: Document usage
Capability: Users discover usage
Kind: documentation
Blocked by: none
Testing seam: Render documentation
TDD: exempt
TDD exemption: Documentation-only change
Covers: AC-1
Verify:
- npm run typecheck
## Acceptance Criteria
- Usage is documented
`, "utf-8");
    const executor = new FakeAgentExecutor({
      review: [
        {
          verdict: "REQUEST_CHANGES",
          summary: "Missing example",
          findings: [{ id: "F1", severity: "major", category: "correctness", description: "Add example", evidence: "docs" }],
          testAssessment: { sufficient: true, explanation: "Mechanical" },
          confidence: 0.9,
        },
        {
          verdict: "PASS",
          summary: "Fixed",
          findings: [],
          testAssessment: { sufficient: true, explanation: "Complete" },
          confidence: 0.95,
        },
      ],
    });
    const verificationRunner = new FakeVerificationRunner();
    const run = await new WorkflowEngine({
      cwd,
      executor,
      verificationRunner,
      preflightForMode: async () => agents,
    }).startTickets(specPath, { ticketDir: dir, mode: "quick" });

    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.equal(run.tickets?.[0].fixRound, 1);
    assert.equal(run.tickets?.[0].reviewRound, 2);
    assert.deepEqual(executor.requests.map((request) => request.nodeId), [
      "ticket-D1-implement",
      "ticket-D1-review-1",
      "ticket-D1-fix-1",
      "ticket-D1-review-2",
      "ticket-final-review-1",
    ]);
    assert.equal(verificationRunner.calls.length, 3);
  });

  it("stops dependents when ticket review budget is exhausted", async () => {
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await fs.writeFile(specPath, "# Docs\n\n## Acceptance Criteria\n\n1. Usage is documented.\n", "utf-8");
    const dir = path.join(cwd, "budget-issues");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "01-docs.md"), `# D1: Document usage
Capability: Users discover usage
Kind: documentation
Blocked by: none
Testing seam: Render documentation
TDD: exempt
TDD exemption: Documentation-only change
Covers: AC-1
Verify:
- npm run typecheck
## Acceptance Criteria
- Usage is documented
`, "utf-8");
    const rejection = {
      verdict: "REQUEST_CHANGES" as const,
      summary: "Still incomplete",
      findings: [{ id: "F1", severity: "major" as const, category: "correctness" as const, description: "Incomplete", evidence: "docs" }],
      testAssessment: { sufficient: true, explanation: "Mechanical" },
      confidence: 0.9,
    };
    const run = await new WorkflowEngine({
      cwd,
      executor: new FakeAgentExecutor({ review: [rejection] }),
      verificationRunner: new FakeVerificationRunner(),
      preflightForMode: async () => agents,
      config: { maxReviewRounds: 2 },
    }).startTickets(specPath, { ticketDir: dir, mode: "quick" });

    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "ticket_review_budget_exhausted");
    assert.equal(run.tickets?.[0].phase, "ticket_failed");
  });

  it("repairs final verification without invalidating ticket history", async () => {
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await fs.writeFile(specPath, "# Docs\n\n## Acceptance Criteria\n\n1. Usage is documented.\n", "utf-8");
    const dir = path.join(cwd, "final-fix-issues");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "01-docs.md"), `# D1: Document usage
Capability: Users discover usage
Kind: documentation
Blocked by: none
Testing seam: Render documentation
TDD: exempt
TDD exemption: Documentation-only change
Covers: AC-1
Verify:
- npm run typecheck
## Acceptance Criteria
- Usage is documented
`, "utf-8");
    const executor = new FakeAgentExecutor();
    const verificationRunner = new FakeVerificationRunner(["passed", "failed", "passed"]);
    const run = await new WorkflowEngine({
      cwd,
      executor,
      verificationRunner,
      preflightForMode: async () => agents,
    }).startTickets(specPath, { ticketDir: dir, mode: "quick" });

    assert.equal(run.state, "completed", JSON.stringify(run.error));
    assert.equal(run.finalGateStatus, "passed");
    assert.equal(run.tickets?.[0].phase, "ticket_completed");
    assert.equal(run.tickets?.[0].fixRound, 0);
    assert.deepEqual(executor.requests.map((request) => request.nodeId), [
      "ticket-D1-implement",
      "ticket-D1-review-1",
      "ticket-final-fix-1",
      "ticket-final-review-2",
    ]);
  });

  it("resumes pending ticket work from immutable artifacts after source edits", async () => {
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await fs.writeFile(specPath, "# Docs\n\n## Acceptance Criteria\n\n1. Usage is documented.\n", "utf-8");
    const dir = path.join(cwd, "resume-issues");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "01-docs.md"), `# D1: Document usage
Capability: Users discover usage
Kind: documentation
Blocked by: none
Testing seam: Render documentation
TDD: exempt
TDD exemption: Documentation-only change
Covers: AC-1
Verify:
- npm run typecheck
## Acceptance Criteria
- Usage is documented
`, "utf-8");
    const created = await new WorkflowEngine({
      cwd,
      executor: new FakeAgentExecutor(),
      preflightForMode: async () => agents,
    }).startTickets(specPath, { ticketDir: dir, mode: "quick", prepareOnly: true });
    await fs.writeFile(path.join(dir, "01-docs.md"), "# Mutable source ticket changed\n", "utf-8");
    const executor = new FakeAgentExecutor();
    const resumed = await new WorkflowEngine({
      cwd,
      executor,
      verificationRunner: new FakeVerificationRunner(),
      preflightForMode: async () => agents,
    }).resume(created.id);

    assert.equal(resumed.state, "completed", JSON.stringify(resumed.error));
    assert.deepEqual(executor.requests.map((request) => request.nodeId), [
      "ticket-D1-implement",
      "ticket-D1-review-1",
      "ticket-final-review-1",
    ]);
  });

  it("fails before agents on graph corruption or a missing active checkpoint", async () => {
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await fs.writeFile(specPath, "# Docs\n\n## Acceptance Criteria\n\n1. Usage is documented.\n", "utf-8");
    const dir = path.join(cwd, "corrupt-issues");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "01-docs.md"), `# D1: Document usage
Capability: Users discover usage
Kind: documentation
Blocked by: none
Testing seam: Render documentation
TDD: exempt
TDD exemption: Documentation-only change
Covers: AC-1
Verify:
- npm run typecheck
## Acceptance Criteria
- Usage is documented
`, "utf-8");
    const first = await new WorkflowEngine({
      cwd,
      executor: new FakeAgentExecutor(),
      preflightForMode: async () => agents,
    }).startTickets(specPath, { ticketDir: dir, prepareOnly: true });
    await fs.writeFile(
      path.join(cwd, ".pi", "workflow", "runs", first.id, "ticket-plan.json"),
      "{}",
      "utf-8"
    );
    const corruptExecutor = new FakeAgentExecutor();
    const corrupt = await new WorkflowEngine({
      cwd,
      executor: corruptExecutor,
      preflightForMode: async () => agents,
    }).resume(first.id);
    assert.equal(corrupt.state, "failed");
    assert.equal(corrupt.error?.code, "ticket_graph_corrupt");
    assert.equal(corruptExecutor.requests.length, 0);

    const second = await new WorkflowEngine({
      cwd,
      executor: new FakeAgentExecutor(),
      preflightForMode: async () => agents,
    }).startTickets(specPath, { ticketDir: dir, prepareOnly: true });
    second.tickets![0].phase = "implementing";
    second.tickets![0].checkpoint = undefined;
    await saveWorkflowRun(path.join(cwd, ".pi", "workflow"), second);
    const checkpointExecutor = new FakeAgentExecutor();
    const missingCheckpoint = await new WorkflowEngine({
      cwd,
      executor: checkpointExecutor,
      preflightForMode: async () => agents,
    }).resume(second.id);
    assert.equal(missingCheckpoint.state, "failed");
    assert.equal(missingCheckpoint.error?.code, "ticket_graph_corrupt");
    assert.equal(checkpointExecutor.requests.length, 0);
  });
});

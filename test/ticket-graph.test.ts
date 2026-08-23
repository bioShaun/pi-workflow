import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TicketDefinition } from "../src/contracts/tickets.ts";
import {
  freezeTicketGraph,
  importTicketGraph,
  TicketGraphValidationError,
  validateTicketGraph,
} from "../src/tickets/graph.ts";
import {
  GeneratedTicketGraphAdapter,
  TicketGenerationError,
} from "../src/tickets/adapter.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";

const requirement = { artifactPath: "requirement.md", sha256: "abc123" };

function ticket(overrides: Partial<TicketDefinition> = {}): TicketDefinition {
  return {
    id: "T1",
    title: "Deliver greeting",
    capability: "Users can receive a greeting",
    kind: "behavioral",
    acceptanceCriteria: ["A greeting is returned"],
    blockedBy: [],
    testingSeam: "Call greet(name)",
    verification: [{ command: "npm test", required: true }],
    redCommand: "npm test",
    tdd: { policy: "required" },
    covers: ["AC-1"],
    ...overrides,
  };
}

describe("Ticket graph import and validation", () => {
  let root: string;
  let ticketDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(process.cwd(), ".scratch", "ticket-graph-test-"));
    ticketDir = path.join(root, "issues");
    await fs.mkdir(ticketDir);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("imports deterministic Markdown and freezes an immutable graph snapshot", async () => {
    const first = `# T1: Deliver greeting
Capability: Users can receive a greeting
Kind: behavioral
Blocked by: none
Testing seam: Call greet(name)
TDD: required
Red command: npm test
Covers: AC-1
Verify:
- npm test
Allow:
- src/greet.ts
## Acceptance Criteria
- A greeting is returned
`;
    const second = `# T2: Expose greeting docs
Capability: Users can discover greeting usage
Kind: documentation
Blocked by: T1
Testing seam: Render the documentation page
TDD: exempt
TDD exemption: Documentation-only change has no behavioral red seam
Covers: AC-2
Verify:
- npm run typecheck
## Acceptance Criteria
- Usage is documented
`;
    await fs.writeFile(path.join(ticketDir, "02-docs.md"), second, "utf-8");
    await fs.writeFile(path.join(ticketDir, "01-greeting.md"), first, "utf-8");
    const before = await Promise.all([
      fs.readFile(path.join(ticketDir, "01-greeting.md"), "utf-8"),
      fs.readFile(path.join(ticketDir, "02-docs.md"), "utf-8"),
    ]);

    const graph = await importTicketGraph({
      ticketDir,
      requirement,
      requirementCriteria: ["AC-1", "AC-2"],
    });
    assert.deepEqual(graph.tickets.map((item) => item.id), ["T1", "T2"]);
    assert.deepEqual(graph.coverage, { "AC-1": ["T1"], "AC-2": ["T2"] });
    assert.equal(graph.tickets[1].tdd.policy, "exempt");

    const baseDir = path.join(root, ".pi", "workflow");
    const snapshot = await freezeTicketGraph(baseDir, "run-1", graph);
    assert.equal(snapshot.ticketCount, 2);
    assert.equal(snapshot.artifactPath, "ticket-plan.json");
    assert.deepEqual(await Promise.all([
      fs.readFile(path.join(ticketDir, "01-greeting.md"), "utf-8"),
      fs.readFile(path.join(ticketDir, "02-docs.md"), "utf-8"),
    ]), before);
  });

  it("rejects duplicate ids, unknown blockers, cycles, and coverage gaps", () => {
    const cases: Array<[string, TicketDefinition[], string[], string]> = [
      ["duplicate", [ticket(), ticket()], ["AC-1"], "duplicate_id"],
      ["unknown blocker", [ticket({ blockedBy: ["missing"] })], ["AC-1"], "unknown_blocker"],
      [
        "cycle",
        [ticket({ id: "T1", blockedBy: ["T2"] }), ticket({ id: "T2", blockedBy: ["T1"] })],
        ["AC-1"],
        "cycle",
      ],
      ["coverage", [ticket()], ["AC-1", "AC-2"], "coverage_gap"],
    ];
    for (const [name, tickets, criteria, code] of cases) {
      assert.throws(
        () => validateTicketGraph({ requirement, requirementCriteria: criteria, tickets }),
        (error: unknown) => {
          assert.ok(error instanceof TicketGraphValidationError, name);
          assert.ok(error.issues.some((issue) => issue.code === code), name);
          return true;
        }
      );
    }
  });

  it("rejects missing metadata and unjustified horizontal decomposition", async () => {
    await fs.writeFile(path.join(ticketDir, "01-invalid.md"), "# T1: Missing fields\n", "utf-8");
    await assert.rejects(
      importTicketGraph({ ticketDir, requirement, requirementCriteria: ["AC-1"] }),
      (error: unknown) => error instanceof TicketGraphValidationError
        && error.issues.some((issue) => issue.code === "missing_metadata")
    );

    assert.throws(
      () => validateTicketGraph({
        requirement,
        requirementCriteria: ["AC-1", "AC-2"],
        tickets: [
          ticket({ id: "T1", capability: "Types for every feature", covers: ["AC-1"] }),
          ticket({ id: "T2", capability: "Storage for every feature", covers: ["AC-2"] }),
        ],
      }),
      (error: unknown) => error instanceof TicketGraphValidationError
        && error.issues.some((issue) => issue.code === "horizontal_decomposition")
    );
  });

  it("generates through a dedicated bounded ticketizer and shared validator", async () => {
    const executor = new FakeAgentExecutor();
    executor.setHandler("ticketizer", () => ({
      status: "completed",
      result: {
        tickets: [ticket()],
        finalGate: { acceptanceCriteria: [], covers: [], verification: [] },
      },
    }));
    const adapter = new GeneratedTicketGraphAdapter(executor, "planner", root, "run-1", 5_000);
    const graph = await adapter.obtain({
      requirement,
      requirementPath: ".pi/workflow/runs/run-1/requirement.md",
      requirementCriteria: ["AC-1"],
    });

    assert.equal(graph.tickets[0].id, "T1");
    assert.equal(executor.requests[0].nodeId, "ticketizer");
    assert.equal(executor.requests[0].agent, "planner");
    assert.equal(executor.requests[0].context, "fresh");
    assert.equal(executor.requests[0].timeoutMs, 5_000);
    assert.match(executor.requests[0].task, /immutable specification/i);
  });

  it("fails boundedly on timeout and malformed ticketizer output", async () => {
    for (const [status, expected] of [
      ["timed_out", "ticketizer_timeout"],
      ["completed", "ticketizer_malformed"],
    ] as const) {
      const executor = new FakeAgentExecutor();
      executor.setHandler("ticketizer", () => ({
        status,
        ...(status === "completed" ? { result: {} } : {}),
      }));
      const adapter = new GeneratedTicketGraphAdapter(executor, "planner", root, "run-1");
      await assert.rejects(
        adapter.obtain({
          requirement,
          requirementPath: "requirement.md",
          requirementCriteria: ["AC-1"],
        }),
        (error: unknown) => error instanceof TicketGenerationError && error.code === expected
      );
    }
  });
});

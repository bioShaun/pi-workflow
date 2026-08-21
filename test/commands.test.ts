import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseWorkArgs } from "../src/commands/parser.ts";
import {
  renderHelp,
  renderPlanSummary,
  renderStatus,
  renderCompleted,
  renderAborted,
} from "../src/commands/renderer.ts";
import type { WorkflowRun } from "../src/contracts/workflow.ts";
import type { PlanResult } from "../src/contracts/plan.ts";

describe("CLI Parser and UX Renderer", () => {
  describe("Parser", () => {
    it("parses help command", () => {
      assert.equal(parseWorkArgs("").subcommand, "help");
      assert.equal(parseWorkArgs("help").subcommand, "help");
    });

    it("parses plan with task and modes", () => {
      const p1 = parseWorkArgs("plan Add feature");
      assert.equal(p1.subcommand, "plan");
      assert.equal(p1.task, "Add feature");
      assert.equal(p1.mode, undefined);

      const p2 = parseWorkArgs("plan Add feature --strict");
      assert.equal(p2.subcommand, "plan");
      assert.equal(p2.task, "Add feature");
      assert.equal(p2.mode, "strict");

      const p3 = parseWorkArgs("plan Fix bug --quick");
      assert.equal(p3.subcommand, "plan");
      assert.equal(p3.task, "Fix bug");
      assert.equal(p3.mode, "quick");
    });

    it("parses auto, implement, review, fix, status, resume, abort", () => {
      assert.equal(parseWorkArgs("implement").subcommand, "implement");
      assert.equal(parseWorkArgs("review").subcommand, "review");
      assert.equal(parseWorkArgs("fix").subcommand, "fix");
      assert.equal(parseWorkArgs("status").subcommand, "status");
      assert.equal(parseWorkArgs("resume").subcommand, "resume");
      assert.equal(parseWorkArgs("abort").subcommand, "abort");
      assert.equal(parseWorkArgs("list").subcommand, "list");

      const auto = parseWorkArgs("auto Fix memory leak --normal");
      assert.equal(auto.subcommand, "auto");
      assert.equal(auto.task, "Fix memory leak");
      assert.equal(auto.mode, "normal");
    });
  });

  describe("Renderer", () => {
    it("renders help output properly", () => {
      const help = renderHelp();
      assert.match(help, /\/work auto/);
      assert.match(help, /\/work plan/);
      assert.match(help, /\/work review/);
    });

    it("renders status output properly", () => {
      const run: WorkflowRun = {
        version: 1,
        id: "wf_20260821_124500_a81f",
        cwd: "/tmp",
        createdAt: "2026-08-21T12:45:00Z",
        updatedAt: "2026-08-21T12:46:00Z",
        state: "reviewing",
        mode: "normal",
        request: "Task",
        reviewRound: 1,
        maxReviewRounds: 3,
        plan: {
          summary: "Plan summary",
          understanding: "",
          files: [],
          steps: [{ id: "1", description: "step 1" }],
          tests: [],
          risks: [],
          assumptions: [],
          complexity: "low",
          requiresSecondReviewer: false,
        },
        implementation: {
          summary: "Impl summary",
          changedFiles: [{ path: "src/a.ts", change: "Added code" }],
          tests: [{ status: "passed", summary: "Tests passed" }],
          unresolvedIssues: [],
          deviationsFromPlan: [],
        },
        reviews: [
          {
            verdict: "REQUEST_CHANGES",
            summary: "Bug found",
            findings: [
              {
                id: "1",
                severity: "major",
                category: "correctness",
                description: "retry path loses original error",
                evidence: "",
              },
            ],
            testAssessment: { sufficient: false, explanation: "" },
            confidence: 0.9,
          },
        ],
        fixes: [],
        baseline: { dirty: false, status: [], startedAt: "" },
      };

      const statusStr = renderStatus(run);
      assert.match(statusStr, /wf_20260821_124500_a81f/);
      assert.match(statusStr, /Plan\s+PASS/);
      assert.match(statusStr, /Implementation\s+PASS/);
      assert.match(statusStr, /Review\s+REQUEST_CHANGES/);
      assert.match(statusStr, /retry path loses original error/);
    });

    it("renders completed output properly", () => {
      const run: WorkflowRun = {
        version: 1,
        id: "wf_20260821_124500_a81f",
        cwd: "/tmp",
        createdAt: "",
        updatedAt: "",
        state: "completed",
        mode: "normal",
        request: "Task",
        reviewRound: 2,
        maxReviewRounds: 3,
        implementation: {
          summary: "Impl",
          changedFiles: [{ path: "src/foo.ts", change: "" }],
          tests: [{ status: "passed", summary: "" }],
          unresolvedIssues: [],
          deviationsFromPlan: [],
        },
        reviews: [],
        fixes: [],
        baseline: { dirty: false, status: [], startedAt: "" },
      };

      const compStr = renderCompleted(run);
      assert.match(compStr, /pi-workflow · completed/);
      assert.match(compStr, /src\/foo\.ts/);
      assert.match(compStr, /PASS after 2 round\(s\)/);
    });
  });
});

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  registerHooks,
  type ResolveFnOutput,
  type ResolveHookContext,
} from "node:module";
import { parseWorkArgs } from "../src/commands/parser.ts";
import {
  renderHelp,
  renderPlanSummary,
  renderStatus,
  renderCompleted,
  renderAborted,
  renderTraceLine,
  formatWorkingBreadcrumb,
} from "../src/commands/renderer.ts";
import type { WorkflowProgressEvent } from "../src/engine/engine.ts";
import type { WorkflowRun } from "../src/contracts/workflow.ts";
import type { PlanResult } from "../src/contracts/plan.ts";

// work.ts transitively imports the pi-subagents delegation constants, and
// Node refuses to strip types from .ts files under node_modules. Stub the
// specifier the same way test/progress.test.ts does; only the four event
// names are touched at runtime, and the wiring tests below never emit
// through the bus.
const SUBAGENT_DELEGATION_STUB = [
  'export const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";',
  'export const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";',
  'export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";',
  'export const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";',
].join("\n");

registerHooks({
  resolve(
    specifier: string,
    context: ResolveHookContext,
    nextResolve: (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput
  ): ResolveFnOutput {
    if (specifier === "pi-subagents/delegation") {
      return {
        url: `data:text/javascript,${encodeURIComponent(SUBAGENT_DELEGATION_STUB)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { registerWorkCommand, createProgressNotifier } = await import("../src/commands/work.ts");

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

    it("renders compact trace lines (Claude Code style)", () => {
      const trace1 = renderTraceLine({
        status: "success",
        agent: "planner",
        action: "Plan approved (4 steps, low complexity)",
        durationMs: 3200,
        tokens: 65200,
      });
      assert.match(trace1, /^✓ \[planner\] Plan approved \(4 steps, low complexity\) · 3\.2s · 65\.2k tok$/);

      const trace2 = renderTraceLine({
        status: "warning",
        agent: "reviewer",
        action: "Verdict: REQUEST_CHANGES (1 finding(s), round 1)",
        durationMs: 4500,
        tokens: 180000,
        details: ["[HIGH] transitions.ts: Missing null guard"],
      });
      assert.match(trace2, /^⚠️ \[reviewer\] Verdict: REQUEST_CHANGES/);
      assert.match(trace2, /↳ \[HIGH\] transitions\.ts: Missing null guard/);
    });

    it("formats dynamic working breadcrumb", () => {
      const breadcrumb = formatWorkingBreadcrumb("worker", "Executing code changes", "tool: edit_file", 8400, 142000);
      assert.equal(breadcrumb, "[worker] Executing code changes · tool: edit_file · 8.4s · 142.0k tok");
    });
  });

  describe("Work command progress wiring", () => {
    function makeNotifier() {
      const notifications: Array<{ msg: string; type: string }> = [];
      const working: Array<string | undefined> = [];
      const notifier = createProgressNotifier(
        (msg, type = "info") => notifications.push({ msg, type }),
        (msg) => working.push(msg)
      );
      return { notifier, notifications, working };
    }

    function endEvent(
      nodeId: string,
      action: string,
      details: Record<string, unknown> = {},
      agent = "worker"
    ): WorkflowProgressEvent {
      return {
        type: "node_end",
        run: {} as WorkflowRun,
        nodeId,
        agent,
        action,
        durationMs: 1000,
        tokens: 500,
        details,
      };
    }

    it("maps a review REQUEST_CHANGES terminal event to a warning trace with findings", () => {
      const { notifier, notifications } = makeNotifier();

      notifier(
        endEvent(
          "review-1",
          "Verdict: REQUEST_CHANGES (1 finding(s), round 1)",
          {
            verdict: "REQUEST_CHANGES",
            findingList: [
              { severity: "major", description: "Missing null guard", file: "src/main.ts" },
            ],
          },
          "reviewer"
        )
      );

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].type, "warning");
      assert.match(notifications[0].msg, /^⚠️ \[reviewer\]/);
      assert.match(notifications[0].msg, /\[MAJOR\] Missing null guard \(src\/main\.ts\)/);
    });

    it("maps a fix terminal event to an error trace when the fix worker's tests failed", () => {
      const { notifier, notifications } = makeNotifier();

      notifier(
        endEvent("fix-1", "Fix round 1 completed (1 file(s) modified, 1/2 tests passed)", {
          changedFiles: ["src/main.ts"],
          addressedFindings: ["finding-1"],
          passedTests: 1,
          failedTests: 1,
          totalTests: 2,
        })
      );

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].type, "error");
      assert.match(notifications[0].msg, /^✗ \[worker\]/);
      assert.match(notifications[0].msg, /1 failed test\(s\) \(1\/2 passed\)/);
    });

    it("keeps a fix terminal event a success trace when all tests passed", () => {
      const { notifier, notifications } = makeNotifier();

      notifier(
        endEvent("fix-1", "Fix round 1 completed (1 file(s) modified, 2/2 tests passed)", {
          changedFiles: ["src/main.ts"],
          addressedFindings: ["finding-1"],
          passedTests: 2,
          failedTests: 0,
          totalTests: 2,
        })
      );

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].type, "info");
      assert.match(notifications[0].msg, /^✓ \[worker\]/);
      assert.doesNotMatch(notifications[0].msg, /did not pass|failed test/);
    });

    it("updates the working breadcrumb on node_update with live tool metadata", () => {
      const { notifier, working } = makeNotifier();

      notifier({
        type: "node_update",
        run: {} as WorkflowRun,
        nodeId: "fix-1",
        agent: "worker",
        action: "Fixing review findings (round 1)...",
        durationMs: 8400,
        tokens: 142000,
        details: { currentTool: "edit", currentToolArgs: "src/main.ts" },
      });

      assert.equal(working.length, 1);
      assert.equal(
        working[0],
        "[worker] Fixing review findings (round 1)... · edit · 8.4s · 142.0k tok"
      );
    });

    it("clears the working message in the finally path after the handler finishes", async () => {
      let registered: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
      const pi = {
        registerCommand: (name: string, cfg: unknown) => {
          registered = cfg as typeof registered;
        },
      } as any;
      registerWorkCommand(pi);
      assert.ok(registered);

      const notifications: Array<{ msg: string; type: string }> = [];
      const working: Array<string | undefined> = [];
      const ctx: any = {
        cwd: process.cwd(),
        ui: {
          notify: (msg: string, type = "info") => notifications.push({ msg, type }),
          setWorkingMessage: (msg?: string) => working.push(msg),
        },
      };

      await registered!.handler("help", ctx);

      assert.ok(notifications.length >= 1, "handler notified the UI");
      assert.equal(working[working.length - 1], undefined, "finally path clears the working message");
    });
  });
});

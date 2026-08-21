import type {
  AgentExecutor,
  AgentExecutionRequest,
  AgentExecutionResult,
} from "../src/agents/executor.ts";
import type { PlanResult } from "../src/contracts/plan.ts";
import type { ImplementationResult } from "../src/contracts/implementation.ts";
import type { ReviewResult } from "../src/contracts/review.ts";
import type { FixResult } from "../src/contracts/fix.ts";
import type { ScoutResult } from "../src/contracts/scout.ts";

export type HandlerFn<T = any> = (
  req: AgentExecutionRequest<T>
) => Promise<AgentExecutionResult<T>> | AgentExecutionResult<T>;

export class FakeAgentExecutor implements AgentExecutor {
  public requests: AgentExecutionRequest[] = [];
  public customHandlers: Map<string, HandlerFn> = new Map();
  public defaultResponses: {
    scout?: ScoutResult;
    plan?: PlanResult;
    implement?: ImplementationResult;
    review?: ReviewResult[];
    fix?: FixResult[];
  } = {};

  private reviewIndex = 0;
  private fixIndex = 0;

  constructor(defaults?: {
    scout?: ScoutResult;
    plan?: PlanResult;
    implement?: ImplementationResult;
    review?: ReviewResult[];
    fix?: FixResult[];
  }) {
    if (defaults) {
      this.defaultResponses = defaults;
    }
  }

  setHandler(nodeIdOrRole: string, handler: HandlerFn) {
    this.customHandlers.set(nodeIdOrRole, handler);
  }

  async execute<T>(request: AgentExecutionRequest<T>): Promise<AgentExecutionResult<T>> {
    this.requests.push(request);

    // 1. Check custom handler by nodeId
    if (this.customHandlers.has(request.nodeId)) {
      return this.customHandlers.get(request.nodeId)!(request);
    }

    // 2. Check custom handler by agent name
    if (this.customHandlers.has(request.agent)) {
      return this.customHandlers.get(request.agent)!(request);
    }

    // 3. Fall back to role-based default responses
    if (request.nodeId === "scout") {
      const scout: ScoutResult = this.defaultResponses.scout ?? {
        summary: "Scouted repository structure",
        relevantFiles: [{ path: "src/main.ts", relevance: "Main entry point" }],
        contextHints: ["TypeScript Node.js project"],
      };
      return {
        status: "completed",
        result: scout as unknown as T,
        usage: { input: 100, output: 50, turns: 1, toolCalls: 2 },
      };
    }

    if (request.nodeId === "plan") {
      const plan: PlanResult = this.defaultResponses.plan ?? {
        summary: "Implementation plan for request",
        understanding: "Understand the requirements",
        files: [{ path: "src/main.ts", purpose: "Implement core logic", action: "modify" }],
        steps: [{ id: "step-1", description: "Apply changes to main.ts" }],
        tests: [{ command: "npm test", description: "Run test suite", required: true }],
        risks: [{ severity: "low", description: "Minimal risk" }],
        assumptions: ["Node.js is available"],
        complexity: "low",
        requiresSecondReviewer: false,
      };
      return {
        status: "completed",
        result: plan as unknown as T,
        usage: { input: 200, output: 100, turns: 1, toolCalls: 3 },
      };
    }

    if (request.nodeId === "implement") {
      const impl: ImplementationResult = this.defaultResponses.implement ?? {
        summary: "Implemented required changes",
        changedFiles: [{ path: "src/main.ts", change: "Added new functionality" }],
        tests: [{ command: "npm test", status: "passed", summary: "All 5 tests passed" }],
        unresolvedIssues: [],
        deviationsFromPlan: [],
      };
      return {
        status: "completed",
        result: impl as unknown as T,
        usage: { input: 300, output: 150, turns: 2, toolCalls: 5 },
      };
    }

    if (request.nodeId.startsWith("review")) {
      const reviews = this.defaultResponses.review;
      let review: ReviewResult;
      if (reviews && reviews.length > 0) {
        review = reviews[Math.min(this.reviewIndex, reviews.length - 1)];
        this.reviewIndex++;
      } else {
        review = {
          verdict: "PASS",
          summary: "All changes look great and tests pass",
          findings: [],
          testAssessment: { sufficient: true, explanation: "Adequate test coverage" },
          confidence: 0.95,
        };
      }
      return {
        status: "completed",
        result: review as unknown as T,
        usage: { input: 250, output: 80, turns: 1, toolCalls: 2 },
      };
    }

    if (request.nodeId.startsWith("fix")) {
      const fixes = this.defaultResponses.fix;
      let fix: FixResult;
      if (fixes && fixes.length > 0) {
        fix = fixes[Math.min(this.fixIndex, fixes.length - 1)];
        this.fixIndex++;
      } else {
        fix = {
          summary: "Addressed all review findings",
          addressedFindings: ["finding-1"],
          unaddressedFindings: [],
          changedFiles: [{ path: "src/main.ts", change: "Fixed issue reported by reviewer" }],
          tests: [{ command: "npm test", status: "passed", summary: "All tests pass" }],
        };
      }
      return {
        status: "completed",
        result: fix as unknown as T,
        usage: { input: 280, output: 120, turns: 1, toolCalls: 3 },
      };
    }

    return {
      status: "completed",
      result: {} as T,
    };
  }
}

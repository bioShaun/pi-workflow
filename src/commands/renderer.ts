import type { WorkflowRun } from "../contracts/workflow.ts";
import type { PlanResult } from "../contracts/plan.ts";
import type { TestResult } from "../contracts/implementation.ts";

function verificationIcon(status: TestResult["status"]): string {
  return status === "passed" ? "✓" : status === "failed" ? "✗" : "–";
}

/**
 * Render worker-reported verification entries (commands like `npm test` /
 * `tsc --noEmit`, NOT individual test cases) one per line. The smoke-test
 * review showed a bare "N passed" count invites misreading N as a test-case
 * count — the per-entry summaries make what was actually run legible.
 */
export function renderVerificationList(tests: TestResult[], maxEntries = 5): string[] {
  if (tests.length === 0) return ["– none reported"];
  const lines = tests.slice(0, maxEntries).map(
    (t) => `${verificationIcon(t.status)} ${t.command ? `\`${t.command}\` — ` : ""}${t.summary}`
  );
  if (tests.length > maxEntries) {
    lines.push(`… +${tests.length - maxEntries} more (see /work status)`);
  }
  return lines;
}

export function renderHelp(): string {
  return [
    "pi-workflow — Deterministic Coding-Workflow Orchestrator",
    "",
    "Usage:",
    "  /work auto <task> [--quick|--normal|--strict]  Run automated workflow end-to-end",
    "  /work plan <task> [--quick|--normal|--strict]  Generate and persist implementation plan",
    "  /work spec <spec-path> [--quick|--normal|--strict]  Spec-driven flow: implement → review → fix (no planner)",
    "  /work implement [runId]                        Execute worker for approved plan",
    "  /work review [runId]                           Launch fresh reviewer(s)",
    "  /work fix [runId]                              Execute fix worker for review findings",
    "  /work status [runId]                           Inspect active or specified workflow status",
    "  /work resume [runId]                           Resume workflow from last persisted checkpoint",
    "  /work abort [runId]                            Abort active workflow (preserves changes)",
    "  /work list                                     List all workflow runs",
    "  /work help                                     Show this help message",
  ].join("\n");
}

export function renderPlanSummary(plan: PlanResult, run: WorkflowRun): string {
  const lines: string[] = [
    `pi-workflow · ${run.mode}`,
    "",
    `Run: ${run.id}`,
    `State: ${run.state}`,
    `Complexity: ${plan.complexity}`,
    "",
    `Plan Summary:`,
    plan.summary,
    "",
    `Planned Files (${plan.files.length}):`,
    ...plan.files.map((f) => `  [${f.action}] ${f.path}`),
    "",
    `Steps (${plan.steps.length}):`,
    ...plan.steps.map((s) => `  ${s.id}. ${s.description}`),
    "",
    `Verification Tests (${plan.tests.length}):`,
    ...plan.tests.map((t) => `  - ${t.required ? "[REQUIRED] " : ""}${t.description}`),
  ];

  if (plan.risks.length > 0) {
    lines.push(
      "",
      `Identified Risks:`,
      ...plan.risks.map((r) => `  - [${r.severity.toUpperCase()}] ${r.description}`)
    );
  }

  lines.push("", "Next step: Run `/work implement` or use `/work auto`.");
  return lines.join("\n");
}

export function renderStatus(run: WorkflowRun | null): string {
  if (!run) {
    return "pi-workflow: No active or recent workflow found. Start one with `/work auto <task>` or `/work plan <task>`.";
  }

  const lines: string[] = [
    `pi-workflow · ${run.mode}`,
    "",
    `Run: ${run.id}`,
    `Mode: ${run.mode}`,
    ...(run.source ? [`Source: ${run.source}${run.specPath ? ` (${run.specPath})` : ""}`] : []),
    `State: ${run.state}`,
    ...(run.currentNode ? [`Current node: ${run.currentNode}`] : []),
    `Started: ${run.createdAt}`,
    `Updated: ${run.updatedAt}`,
    "",
  ];

  // Plan status
  if (run.plan) {
    lines.push(`Plan           PASS (${run.plan.steps.length} steps, ${run.plan.complexity} complexity)`);
  } else {
    lines.push("Plan           PENDING");
  }

  // Implementation status
  if (run.implementation) {
    const passedTests = run.implementation.tests.filter((t) => t.status === "passed").length;
    const totalTests = run.implementation.tests.length;
    lines.push(`Implementation PASS (${run.implementation.changedFiles.length} file(s) changed)`);
    lines.push(`Verification    ${passedTests}/${totalTests} passed`);
  } else {
    lines.push("Implementation PENDING");
  }

  // Review status
  if (run.reviews.length > 0) {
    const latestReview = run.reviews[run.reviews.length - 1];
    lines.push(
      `Review         ${latestReview.verdict} (${run.reviewRound}/${run.maxReviewRounds})`
    );

    const outstanding = latestReview.findings;
    if (outstanding.length > 0 && latestReview.verdict === "REQUEST_CHANGES") {
      lines.push("", "Outstanding Findings:");
      for (const f of outstanding) {
        lines.push(`- [${f.severity}] ${f.description}${f.file ? ` (${f.file})` : ""}`);
      }
    }
  } else {
    lines.push("Review         PENDING");
  }

  // Error if any
  if (run.error) {
    lines.push("", `Error [${run.error.code}]: ${run.error.message}`);
  }

  return lines.join("\n");
}

export function renderCompleted(run: WorkflowRun): string {
  const changedFiles =
    run.fixes.length > 0
      ? run.fixes[run.fixes.length - 1].changedFiles
      : run.implementation?.changedFiles ?? [];

  const latestTests =
    run.fixes.length > 0
      ? run.fixes[run.fixes.length - 1].tests
      : run.implementation?.tests ?? [];

  const passedTests = latestTests.filter((t) => t.status === "passed").length;

  const lines = [
    `pi-workflow · completed`,
    "",
    "Changed Files:",
    ...changedFiles.map((f) => `- ${f.path}`),
    "",
    // These are the worker's reported verification commands/results, not
    // individual test cases (see renderVerificationList).
    `Verification (${passedTests}/${latestTests.length} passed):`,
    ...renderVerificationList(latestTests),
    "",
    "Review:",
    `✓ PASS after ${run.reviewRound} round(s)`,
    "",
    `Run: ${run.id}`,
  ];
  if (run.source === "spec" && run.specPath) {
    lines.push(`Spec: ${run.specPath}`);
  }
  return lines.join("\n");
}

export function renderAborted(run: WorkflowRun): string {
  return [
    `pi-workflow · aborted`,
    "",
    `Run: ${run.id}`,
    "Workflow aborted. Repository changes were preserved.",
  ].join("\n");
}

/** Render a failed run (audit Finding 2: failures are persisted and surfaced). */
export function renderRunError(run: WorkflowRun): string {
  const code = run.error?.code ?? "unknown";
  const message = run.error?.message ?? "Unknown error";
  const nodeId = run.error?.nodeId ? ` (node: ${run.error.nodeId})` : "";
  return `Workflow failed [${code}]${nodeId}: ${message}\nRun: ${run.id}\nUse /work status for details, /work abort to release the run.`;
}

export interface TraceLineOptions {
  status?: "success" | "warning" | "error" | "running";
  agent: string;
  action: string;
  durationMs?: number;
  tokens?: number;
  details?: string[];
}

/** Render a compact single-line trace item (Claude Code style) */
export function renderTraceLine(opts: TraceLineOptions): string {
  const icon =
    opts.status === "warning"
      ? "⚠️"
      : opts.status === "error"
      ? "✗"
      : opts.status === "running"
      ? "⠋"
      : "✓";

  const durStr = opts.durationMs != null ? ` · ${(opts.durationMs / 1000).toFixed(1)}s` : "";
  const tokStr = opts.tokens != null && opts.tokens > 0 ? ` · ${(opts.tokens / 1000).toFixed(1)}k tok` : "";

  const mainLine = `${icon} [${opts.agent}] ${opts.action}${durStr}${tokStr}`;
  if (opts.details && opts.details.length > 0) {
    return [mainLine, ...opts.details.map((d) => `  ↳ ${d}`)].join("\n");
  }
  return mainLine;
}

/** Format a dynamic working message breadcrumb shown during streaming */
export function formatWorkingBreadcrumb(
  agent: string,
  action: string,
  currentTool?: string,
  durationMs?: number,
  tokens?: number
): string {
  const toolStr = currentTool ? ` · ${currentTool}` : "";
  const durStr = durationMs != null ? ` · ${(durationMs / 1000).toFixed(1)}s` : "";
  const tokStr = tokens != null && tokens > 0 ? ` · ${(tokens / 1000).toFixed(1)}k tok` : "";
  return `[${agent}] ${action}${toolStr}${durStr}${tokStr}`;
}

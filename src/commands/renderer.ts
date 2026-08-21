import type { WorkflowRun } from "../contracts/workflow.ts";
import type { PlanResult } from "../contracts/plan.ts";

export function renderHelp(): string {
  return [
    "pi-workflow — Deterministic Coding-Workflow Orchestrator",
    "",
    "Usage:",
    "  /work auto <task> [--quick|--normal|--strict]  Run automated workflow end-to-end",
    "  /work plan <task> [--quick|--normal|--strict]  Generate and persist implementation plan",
    "  /work implement [runId]                        Execute worker for approved plan",
    "  /work review [runId]                           Launch fresh reviewer(s)",
    "  /work fix [runId]                              Execute fix worker for review findings",
    "  /work status [runId]                           Inspect active or specified workflow status",
    "  /work resume [runId]                           Resume workflow from last persisted checkpoint",
    "  /work abort [runId]                            Abort active workflow (preserves changes)",
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
    lines.push(`Tests          ${passedTests}/${totalTests} passed`);
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

  return [
    `pi-workflow · completed`,
    "",
    "Changed Files:",
    ...changedFiles.map((f) => `- ${f.path}`),
    "",
    "Tests:",
    `✓ ${passedTests} passed`,
    "",
    "Review:",
    `✓ PASS after ${run.reviewRound} round(s)`,
    "",
    `Run: ${run.id}`,
  ].join("\n");
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

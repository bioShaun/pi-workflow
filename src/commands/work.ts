import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { parseWorkArgs } from "./parser.ts";
import {
  renderHelp,
  renderPlanSummary,
  renderStatus,
  renderCompleted,
  renderAborted,
  renderRunError,
  renderTraceLine,
  formatWorkingBreadcrumb,
} from "./renderer.ts";
import { WorkflowEngine } from "../engine/engine.ts";
import type { WorkflowProgressEvent } from "../engine/engine.ts";
import { PiSubagentsExecutor } from "../agents/pi-subagents-executor.ts";
import { createWorkflowUI, type WorkflowUI } from "./ui-port.ts";
import { WorkflowLiveWidget, WIDGET_KEY } from "./widget.ts";

export type NotifyFn = (msg: string, type: "info" | "warning" | "error") => void;

/**
 * Maps workflow progress events onto the command-layer UI: live aboveEditor widget,
 * fallback breadcrumbs via setWorking, and compact trace lines via notify.
 */
export function createProgressNotifier(
  ui: WorkflowUI,
  widgetHolder: { widget?: WorkflowLiveWidget }
): (event: WorkflowProgressEvent) => void {
  return (event: WorkflowProgressEvent) => {
    if (event.type === "node_start") {
      if (!widgetHolder.widget) {
        widgetHolder.widget = new WorkflowLiveWidget({
          runId: event.run.id,
          mode: event.run.mode,
          node: event.nodeId,
          agent: event.agent ?? event.nodeId,
          action: event.action ?? "Working...",
          tokens: event.tokens ?? 0,
          expanded: false,
        });
        widgetHolder.widget.attach(ui);
      } else {
        widgetHolder.widget.update({
          node: event.nodeId,
          agent: event.agent ?? event.nodeId,
          action: event.action ?? "Working...",
          tokens: event.tokens ?? 0,
        });
      }
      ui.setWorking(formatWorkingBreadcrumb(event.agent ?? event.nodeId, event.action ?? "Working..."));
    } else if (event.type === "node_update") {
      const toolName = event.details?.currentTool as string | undefined;
      const toolArgs = event.details?.currentToolArgs as string | undefined;
      const recentOut = event.details?.recentOutput as string | undefined;

      if (widgetHolder.widget) {
        widgetHolder.widget.update({
          node: event.nodeId,
          agent: event.agent ?? event.nodeId,
          action: event.action ?? "Working...",
          durationMs: event.durationMs,
          tokens: event.tokens ?? widgetHolder.widget.state.tokens,
          tool: toolName ? { name: toolName, args: toolArgs } : undefined,
          stdout: recentOut,
        });
      }

      ui.setWorking(
        formatWorkingBreadcrumb(
          event.agent ?? event.nodeId,
          event.action ?? "Working...",
          toolName,
          event.durationMs,
          event.tokens
        )
      );
    } else if (event.type === "node_end") {
      let traceDetails: string[] | undefined;
      let traceStatus: "success" | "warning" | "error" = "success";

      if (event.nodeId.startsWith("review")) {
        const verdict = event.details?.verdict as string | undefined;
        if (verdict === "REQUEST_CHANGES") {
          traceStatus = "warning";
          const findingList = event.details?.findingList as Array<{ severity: string; description: string; file?: string }> | undefined;
          if (findingList && findingList.length > 0) {
            traceDetails = findingList.map(
              (f) => `[${f.severity.toUpperCase()}] ${f.description}${f.file ? ` (${f.file})` : ""}`
            );
          }
        }
      } else if (event.nodeId.startsWith("fix")) {
        const totalTests = (event.details?.totalTests as number | undefined) ?? 0;
        const passedTests = (event.details?.passedTests as number | undefined) ?? 0;
        const failedTests = (event.details?.failedTests as number | undefined) ?? 0;
        if (failedTests > 0) {
          traceStatus = "error";
          traceDetails = [`Fix worker reported ${failedTests} failed test(s) (${passedTests}/${totalTests} passed)`];
        } else if (totalTests > 0 && passedTests < totalTests) {
          traceStatus = "warning";
          traceDetails = [`${totalTests - passedTests} test(s) did not pass (${passedTests}/${totalTests} passed)`];
        }
      }

      ui.notify(
        renderTraceLine({
          status: traceStatus,
          agent: event.agent ?? event.nodeId,
          action: event.action ?? "Completed",
          durationMs: event.durationMs,
          tokens: event.tokens,
          details: traceDetails,
        }),
        traceStatus === "warning" ? "warning" : traceStatus === "error" ? "error" : "info"
      );
    }
  };
}

export function registerWorkCommand(pi: ExtensionAPI): void {
  const getEngine = (ui: WorkflowUI, widgetHolder: { widget?: WorkflowLiveWidget }, cwd: string) => {
    const executor = new PiSubagentsExecutor(pi as any);
    return new WorkflowEngine({
      cwd,
      executor,
      onProgress: createProgressNotifier(ui, widgetHolder),
    });
  };

  pi.registerCommand("work", {
    description:
      "Deterministic workflow orchestrator: /work [auto|plan|spec|implement|review|fix|status|resume|abort|list|help]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const sub = (prefix ?? "").split(" ")[0].toLowerCase();
      const candidates = [
        "auto ",
        "plan ",
        "spec ",
        "implement",
        "review",
        "fix",
        "status",
        "resume",
        "abort",
        "list",
        "help",
      ];
      const items: AutocompleteItem[] = candidates
        .filter((c) => c.startsWith(sub))
        .map((c) => ({ value: c, label: c.trim() }));
      return items.length ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseWorkArgs(args);
      const ui = createWorkflowUI(ctx);
      const widgetHolder: { widget?: WorkflowLiveWidget } = {};
      const engine = getEngine(ui, widgetHolder, ctx.cwd);

      ui.notify(`⏳ /work ${parsed.subcommand} received, processing...`, "info");

      try {
        switch (parsed.subcommand) {
          case "help": {
            ui.notify(renderHelp(), "info");
            break;
          }

          case "plan": {
            if (!parsed.task) {
              ui.notify("Usage: /work plan <task description>", "error");
              return;
            }
            ui.notify(`Planning workflow: "${parsed.task}"...`, "info");
            const run = await engine.startPlan(parsed.task, { mode: parsed.mode });
            if (run.state === "failed") {
              ui.notify(renderRunError(run), "error");
            } else {
              ui.notify(renderPlanSummary(run.plan!, run), "info");
            }
            break;
          }

          case "implement": {
            ui.notify("Executing implementation worker...", "info");
            const run = await engine.startImplement(parsed.runId);
            if (run.state === "failed") {
              ui.notify(renderRunError(run), "error");
            } else if (run.state === "fixing") {
              ui.notify(
                `Implementation finished but required tests failed (run ${run.id}). Run /work fix to address them.`,
                "warning"
              );
            } else {
              ui.notify(`Implementation completed for run ${run.id}. Ready for /work review.`, "info");
            }
            break;
          }

          case "review": {
            ui.notify("Launching independent reviewer (fresh context)...", "info");
            const run = await engine.startReview(parsed.runId);
            if (run.state === "completed") {
              ui.notify(renderCompleted(run), "info");
            } else if (run.state === "fixing") {
              const latestReview = run.reviews[run.reviews.length - 1];
              if (latestReview?.verdict === "REQUEST_CHANGES") {
                ui.notify(
                  `Review requested changes (${latestReview.findings.length} finding(s)). Run /work fix to address them.`,
                  "warning"
                );
              } else {
                ui.notify(
                  `Reviewers passed but the completion gate is not satisfied (run ${run.id}). Run /work fix.`,
                  "warning"
                );
              }
            } else if (run.state === "failed") {
              ui.notify(renderRunError(run), "error");
            }
            break;
          }

          case "fix": {
            ui.notify("Executing fix worker...", "info");
            const run = await engine.startFix(parsed.runId);
            if (run.state === "failed") {
              ui.notify(renderRunError(run), "error");
            } else {
              ui.notify(`Fix round completed for run ${run.id}. Ready for /work review.`, "info");
            }
            break;
          }

          case "spec": {
            if (!parsed.task) {
              ui.notify("Usage: /work spec <path-to-spec> [--quick|--normal|--strict]", "error");
              return;
            }
            ui.notify(`Starting spec-driven workflow from "${parsed.task}" (implement → review → fix)...`, "info");
            const run = await engine.startSpec(parsed.task, { mode: parsed.mode });
            if (run.state === "completed") {
              ui.notify(renderCompleted(run), "info");
            } else if (run.state === "failed") {
              ui.notify(`Workflow failed [${run.error?.code}]: ${run.error?.message}`, "error");
            } else if (run.state === "aborted") {
              ui.notify(renderAborted(run), "warning");
            }
            break;
          }

          case "auto": {
            if (!parsed.task) {
              ui.notify("Usage: /work auto <task description> [--quick|--normal|--strict]", "error");
              return;
            }
            ui.notify(`Starting automated workflow: "${parsed.task}"...`, "info");
            const run = await engine.startAuto(parsed.task, { mode: parsed.mode });
            if (run.state === "completed") {
              ui.notify(renderCompleted(run), "info");
            } else if (run.state === "failed") {
              ui.notify(`Workflow failed [${run.error?.code}]: ${run.error?.message}`, "error");
            } else if (run.state === "aborted") {
              ui.notify(renderAborted(run), "warning");
            }
            break;
          }

          case "status": {
            const run = await engine.status(parsed.runId);
            ui.notify(renderStatus(run), "info");
            break;
          }

          case "resume": {
            ui.notify("Resuming workflow from last checkpoint...", "info");
            const run = await engine.resume(parsed.runId);
            if (run.state === "completed") {
              ui.notify(renderCompleted(run), "info");
            } else {
              ui.notify(renderStatus(run), "info");
            }
            break;
          }

          case "abort": {
            const run = await engine.abort(parsed.runId);
            ui.notify(renderAborted(run), "warning");
            break;
          }

          case "list": {
            const runs = await engine.listRuns();
            if (runs.length === 0) {
              ui.notify("No workflow runs found.", "info");
            } else {
              ui.notify(`Workflow runs:\n${runs.map((r) => `  - ${r}`).join("\n")}`, "info");
            }
            break;
          }
        }
      } catch (err: any) {
        ui.notify(`Workflow error: ${err?.message ?? String(err)}`, "error");
      } finally {
        if (widgetHolder.widget) {
          widgetHolder.widget.dispose(ui);
        }
        ui.setWorking();
      }
    },
  });
}


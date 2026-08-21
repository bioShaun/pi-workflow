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
} from "./renderer.ts";
import { WorkflowEngine } from "../engine/engine.ts";
import { PiSubagentsExecutor } from "../agents/pi-subagents-executor.ts";

export function registerWorkCommand(pi: ExtensionAPI): void {
  const getEngine = (cwd: string) => {
    const executor = new PiSubagentsExecutor(pi as any);
    return new WorkflowEngine({
      cwd,
      executor,
    });
  };

  pi.registerCommand("work", {
    description:
      "Deterministic workflow orchestrator: /work [auto|plan|implement|review|fix|status|resume|abort|help]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const sub = (prefix ?? "").split(" ")[0].toLowerCase();
      const items: AutocompleteItem[] = [
        "",
        "auto ",
        "plan ",
        "implement",
        "review",
        "fix",
        "status",
        "resume",
        "abort",
        "list",
        "help",
      ]
        .filter((c) => c === "" || c.startsWith(sub))
        .map((c) => ({ value: c, label: c || "auto" }));
      return items.length ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseWorkArgs(args);
      const engine = getEngine(ctx.cwd);

      const notify = (msg: string, type: "info" | "warning" | "error" = "info") => {
        if ((ctx as any).ui?.notify) {
          (ctx as any).ui.notify(msg, type);
        }
      };

      try {
        switch (parsed.subcommand) {
          case "help": {
            notify(renderHelp(), "info");
            break;
          }

          case "plan": {
            if (!parsed.task) {
              notify("Usage: /work plan <task description>", "error");
              return;
            }
            notify(`Planning workflow: "${parsed.task}"...`, "info");
            const run = await engine.startPlan(parsed.task, { mode: parsed.mode });
            if (run.state === "failed") {
              notify(renderRunError(run), "error");
            } else {
              notify(renderPlanSummary(run.plan!, run), "info");
            }
            break;
          }

          case "implement": {
            notify("Executing implementation worker...", "info");
            const run = await engine.startImplement(parsed.runId);
            if (run.state === "failed") {
              notify(renderRunError(run), "error");
            } else if (run.state === "fixing") {
              // Audit Finding 3: the test gate routed the run to fixing.
              notify(
                `Implementation finished but required tests failed (run ${run.id}). Run /work fix to address them.`,
                "warning"
              );
            } else {
              notify(`Implementation completed for run ${run.id}. Ready for /work review.`, "info");
            }
            break;
          }

          case "review": {
            notify("Launching independent reviewer (fresh context)...", "info");
            const run = await engine.startReview(parsed.runId);
            if (run.state === "completed") {
              notify(renderCompleted(run), "info");
            } else if (run.state === "fixing") {
              const latestReview = run.reviews[run.reviews.length - 1];
              if (latestReview?.verdict === "REQUEST_CHANGES") {
                notify(
                  `Review requested changes (${latestReview.findings.length} finding(s)). Run /work fix to address them.`,
                  "warning"
                );
              } else {
                notify(
                  `Reviewers passed but the completion gate is not satisfied (run ${run.id}). Run /work fix.`,
                  "warning"
                );
              }
            } else if (run.state === "failed") {
              notify(renderRunError(run), "error");
            }
            break;
          }

          case "fix": {
            notify("Executing fix worker...", "info");
            const run = await engine.startFix(parsed.runId);
            if (run.state === "failed") {
              notify(renderRunError(run), "error");
            } else {
              notify(`Fix round completed for run ${run.id}. Ready for /work review.`, "info");
            }
            break;
          }

          case "auto": {
            if (!parsed.task) {
              notify("Usage: /work auto <task description> [--quick|--normal|--strict]", "error");
              return;
            }
            notify(`Starting automated workflow: "${parsed.task}"...`, "info");
            const run = await engine.startAuto(parsed.task, { mode: parsed.mode });
            if (run.state === "completed") {
              notify(renderCompleted(run), "info");
            } else if (run.state === "failed") {
              notify(`Workflow failed [${run.error?.code}]: ${run.error?.message}`, "error");
            } else if (run.state === "aborted") {
              notify(renderAborted(run), "warning");
            }
            break;
          }

          case "status": {
            const run = await engine.status(parsed.runId);
            notify(renderStatus(run), "info");
            break;
          }

          case "resume": {
            notify("Resuming workflow from last checkpoint...", "info");
            const run = await engine.resume(parsed.runId);
            if (run.state === "completed") {
              notify(renderCompleted(run), "info");
            } else {
              notify(renderStatus(run), "info");
            }
            break;
          }

          case "abort": {
            const run = await engine.abort(parsed.runId);
            notify(renderAborted(run), "warning");
            break;
          }

          case "list": {
            const runs = await engine.listRuns();
            if (runs.length === 0) {
              notify("No workflow runs found.", "info");
            } else {
              notify(`Workflow runs:\n${runs.map((r) => `  - ${r}`).join("\n")}`, "info");
            }
            break;
          }
        }
      } catch (err: any) {
        notify(`Workflow error: ${err?.message ?? String(err)}`, "error");
      }
    },
  });
}

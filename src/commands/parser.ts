import type { WorkflowMode } from "../contracts/workflow.ts";

export type WorkSubcommand =
  | "help"
  | "plan"
  | "implement"
  | "review"
  | "fix"
  | "auto"
  | "status"
  | "resume"
  | "abort"
  | "list";

export interface ParsedWorkCommand {
  subcommand: WorkSubcommand;
  task?: string;
  runId?: string;
  mode?: WorkflowMode;
  rawArgs: string;
}

export function parseWorkArgs(argsStr: string): ParsedWorkCommand {
  const trimmed = (argsStr ?? "").trim();
  if (!trimmed || trimmed === "help") {
    return { subcommand: "help", rawArgs: trimmed };
  }

  const parts = trimmed.split(/\s+/);
  const sub = parts[0].toLowerCase();
  const rest = parts.slice(1);

  let mode: WorkflowMode | undefined;
  const filteredRest: string[] = [];

  for (const part of rest) {
    if (part === "--quick") {
      mode = "quick";
    } else if (part === "--normal") {
      mode = "normal";
    } else if (part === "--strict") {
      mode = "strict";
    } else {
      filteredRest.push(part);
    }
  }

  const remainder = filteredRest.join(" ").trim();

  switch (sub) {
    case "plan":
      return {
        subcommand: "plan",
        task: remainder,
        mode,
        rawArgs: trimmed,
      };
    case "implement":
      return {
        subcommand: "implement",
        runId: remainder || undefined,
        rawArgs: trimmed,
      };
    case "review":
      return {
        subcommand: "review",
        runId: remainder || undefined,
        rawArgs: trimmed,
      };
    case "fix":
      return {
        subcommand: "fix",
        runId: remainder || undefined,
        rawArgs: trimmed,
      };
    case "auto":
      return {
        subcommand: "auto",
        task: remainder,
        mode,
        rawArgs: trimmed,
      };
    case "status":
      return {
        subcommand: "status",
        runId: remainder || undefined,
        rawArgs: trimmed,
      };
    case "resume":
      return {
        subcommand: "resume",
        runId: remainder || undefined,
        rawArgs: trimmed,
      };
    case "abort":
      return {
        subcommand: "abort",
        runId: remainder || undefined,
        rawArgs: trimmed,
      };
    case "list":
      return {
        subcommand: "list",
        rawArgs: trimmed,
      };
    default:
      // If no recognized subcommand, treat whole line as /work auto <task>
      return {
        subcommand: "auto",
        task: trimmed,
        mode,
        rawArgs: trimmed,
      };
  }
}

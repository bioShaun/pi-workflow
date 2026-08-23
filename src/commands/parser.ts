import type { WorkflowMode } from "../contracts/workflow.ts";

export type WorkSubcommand =
  | "help"
  | "plan"
  | "spec"
  | "tickets"
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
  ticketDir?: string;
  error?: string;
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
    case "spec":
      // task carries the spec file path (relative to the project root or absolute)
      return {
        subcommand: "spec",
        task: remainder,
        mode,
        rawArgs: trimmed,
      };
    case "tickets": {
      const ticketFlagIndexes = filteredRest
        .map((part, index) => part === "--tickets" ? index : -1)
        .filter((index) => index >= 0);
      const modeCount = rest.filter((part) => ["--quick", "--normal", "--strict"].includes(part)).length;
      if (modeCount > 1) {
        return { subcommand: "tickets", mode, rawArgs: trimmed, error: "Specify only one execution mode" };
      }
      if (ticketFlagIndexes.length > 1) {
        return { subcommand: "tickets", mode, rawArgs: trimmed, error: "Specify --tickets at most once" };
      }
      const ticketFlag = ticketFlagIndexes[0];
      const specParts = ticketFlag === undefined ? filteredRest : filteredRest.slice(0, ticketFlag);
      const ticketDir = ticketFlag === undefined ? undefined : filteredRest[ticketFlag + 1];
      const trailing = ticketFlag === undefined ? [] : filteredRest.slice(ticketFlag + 2);
      const unknownFlag = specParts.find((part) => part.startsWith("--"));
      if (unknownFlag || (ticketFlag !== undefined && (!ticketDir || ticketDir.startsWith("--") || trailing.length > 0))) {
        return {
          subcommand: "tickets",
          mode,
          rawArgs: trimmed,
          error: unknownFlag
            ? `Unknown tickets option: ${unknownFlag}`
            : "--tickets requires exactly one directory path",
        };
      }
      return {
        subcommand: "tickets",
        task: specParts.join(" ").trim(),
        ticketDir,
        mode,
        rawArgs: trimmed,
      };
    }
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

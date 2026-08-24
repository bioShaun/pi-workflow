import type { WorkflowRun, WorkflowMode } from "../contracts/workflow.ts";

export type ActivityKind = "read" | "search" | "edit" | "run" | "other";

export interface WidgetActivity {
  key: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  status: "previous" | "active";
  output: string[];
}

export interface WorkflowRouteStep {
  label: string;
  status: "completed" | "active" | "pending" | "conditional";
}

/** Strip ANSI and terminal control sequences. */
export function stripAnsi(text: string): string {
  if (!text) return "";
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][A-Za-z0-9]|\x1b[<=>]/g, "");
}

/** Sanitize and collapse whitespace for a single line of text. */
export function sanitizeSingleLine(text: string): string {
  const clean = stripAnsi(text)
    // replace newlines and control characters with space
    // eslint-disable-next-line no-control-regex
    .replace(/[\r\n\t\x00-\x1f\x7f-\x9f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return clean;
}

/** Format node ID to human-readable stage label. */
export function formatStageLabel(nodeId?: string): string {
  if (!nodeId) return "Unknown";
  const id = nodeId.toLowerCase().trim();

  if (id === "scout") return "Explore";
  if (id === "plan") return "Plan";
  if (id === "implement" || id === "implementation" || id === "worker") return "Implement";
  if (id === "spec") return "Load specification";
  if (id === "ticketizer" || id === "ticket-graph") return "Plan tickets";
  if (id === "ticket-frontier" || id === "ticketing") return "Execute tickets";
  if (id === "ticket-final-gate" || id === "finalizing") return "Final specification gate";

  // Strict review nodes
  const reviewMatch = id.match(/^review-(\d+)(?:-([ab]|final))?$/);
  if (reviewMatch) {
    const round = reviewMatch[1];
    const spec = reviewMatch[2];
    if (spec === "a") return `Correctness review · round ${round}`;
    if (spec === "b") return `Quality review · round ${round}`;
    if (spec === "final") return `Final review · round ${round}`;
    return `Review round ${round}`;
  }

  // Fix nodes
  const fixMatch = id.match(/^fix-(\d+)$/);
  if (fixMatch) {
    return `Fix round ${fixMatch[1]}`;
  }

  // Ticket nodes
  const ticketMatch = id.match(/^ticket-([a-zA-Z0-9_-]+)$/);
  if (ticketMatch) {
    const name = ticketMatch[1].replace(/[-_]+/g, " ");
    return `Ticket ${name}`;
  }

  // Generic fallback: capitalize words separated by dashes or underscores
  return id
    .split(/[-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Map agent role to standard role label. */
export function formatAgentRole(agent?: string, fallbackNode?: string): string {
  const name = (agent ?? fallbackNode ?? "worker").toLowerCase();
  if (name.includes("scout")) return "scout";
  if (name.includes("plan")) return "planner";
  if (name.includes("review")) return "reviewer";
  if (name.includes("fix")) return "fixer";
  if (name.includes("worker") || name.includes("implement")) return "worker";
  return name;
}

/** Tool category mapping */
const READ_TOOLS = new Set(["read_file", "read", "view_file", "view", "cat", "view_file_content"]);
const SEARCH_TOOLS = new Set([
  "grep_search",
  "find_by_name",
  "grep",
  "find",
  "glob",
  "search",
  "search_web",
  "read_url_content",
  "list_dir",
]);
const EDIT_TOOLS = new Set([
  "edit_file",
  "replace_file_content",
  "write_to_file",
  "edit",
  "write",
  "patch",
]);
const RUN_TOOLS = new Set(["run_command", "bash", "sh", "exec", "shell", "run"]);

/** Check if an argument key or string looks sensitive */
function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes("password") ||
    k.includes("token") ||
    k.includes("secret") ||
    k.includes("auth") ||
    k.includes("credential") ||
    k.includes("key") && (k.includes("api") || k.includes("priv") || k.includes("access")) ||
    k.includes("prompt") ||
    k.includes("content") ||
    k.includes("codecontent") ||
    k.includes("replacementcontent") ||
    k.includes("targetcontent") ||
    k.includes("schema") ||
    k.includes("env") ||
    k.includes("headers")
  );
}

/** Clean command string by removing leading environment variable assignments */
function cleanCommandArgs(cmd: string): string {
  let cleaned = sanitizeSingleLine(cmd);
  // Strip leading VAR=val assignments
  cleaned = cleaned.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, "");
  return cleaned;
}

/** Normalize tool name and args into a safe activity structure */
export function normalizeToolCall(toolName?: string, rawArgs?: string | Record<string, unknown>): {
  kind: ActivityKind;
  label: string;
  detail?: string;
} | undefined {
  if (!toolName || typeof toolName !== "string" || !toolName.trim()) {
    return undefined;
  }

  const name = toolName.trim().toLowerCase();
  let parsedArgs: Record<string, unknown> | undefined;

  if (typeof rawArgs === "object" && rawArgs !== null) {
    parsedArgs = rawArgs;
  } else if (typeof rawArgs === "string" && rawArgs.trim().startsWith("{")) {
    try {
      parsedArgs = JSON.parse(rawArgs.trim());
    } catch {
      // Not valid JSON, keep as raw string
    }
  }

  // Helper to extract a path from args
  const extractPath = (): string | undefined => {
    if (parsedArgs) {
      for (const [key, val] of Object.entries(parsedArgs)) {
        if (typeof val === "string" && !isSensitiveKey(key)) {
          const lk = key.toLowerCase();
          if (
            lk === "targetfile" ||
            lk === "absolutepath" ||
            lk === "path" ||
            lk === "filepath" ||
            lk === "file" ||
            lk === "filename"
          ) {
            return sanitizeSingleLine(val);
          }
        }
      }
    }
    if (typeof rawArgs === "string") {
      const s = sanitizeSingleLine(rawArgs);
      if (s && !s.startsWith("{") && !s.includes("=")) {
        return s;
      }
    }
    return undefined;
  };

  // 1. Read tools
  if (READ_TOOLS.has(name)) {
    const pathVal = extractPath();
    return {
      kind: "read",
      label: "Read",
      detail: pathVal,
    };
  }

  // 2. Search tools
  if (SEARCH_TOOLS.has(name)) {
    let queryVal: string | undefined;
    if (parsedArgs) {
      const query = parsedArgs.query ?? parsedArgs.Query ?? parsedArgs.pattern ?? parsedArgs.Pattern;
      const searchDir = parsedArgs.SearchDirectory ?? parsedArgs.SearchPath ?? parsedArgs.DirectoryPath ?? parsedArgs.path;
      if (typeof query === "string" && query.trim()) {
        queryVal = sanitizeSingleLine(query);
      } else if (typeof searchDir === "string" && searchDir.trim()) {
        queryVal = sanitizeSingleLine(searchDir);
      }
    } else if (typeof rawArgs === "string") {
      queryVal = sanitizeSingleLine(rawArgs);
    }
    return {
      kind: "search",
      label: "Search",
      detail: queryVal,
    };
  }

  // 3. Edit tools
  if (EDIT_TOOLS.has(name)) {
    const pathVal = extractPath();
    return {
      kind: "edit",
      label: "Edit",
      detail: pathVal,
    };
  }

  // 4. Run tools
  if (RUN_TOOLS.has(name)) {
    let cmdVal: string | undefined;
    if (parsedArgs) {
      const cmd = parsedArgs.CommandLine ?? parsedArgs.command ?? parsedArgs.cmd ?? parsedArgs.script;
      if (typeof cmd === "string" && cmd.trim()) {
        cmdVal = cleanCommandArgs(cmd);
      }
    } else if (typeof rawArgs === "string") {
      cmdVal = cleanCommandArgs(rawArgs);
    }
    return {
      kind: "run",
      label: "Run",
      detail: cmdVal,
    };
  }

  // 5. Unknown/other tools -> Do not expose raw argument payload
  return {
    kind: "other",
    label: toolName.trim(),
    detail: undefined,
  };
}

/** Normalize output lines, keeping at most the newest two single-line entries */
export function normalizeOutputLines(recentOutputLines?: string[], recentOutput?: string): string[] {
  let rawLines: string[] = [];

  if (Array.isArray(recentOutputLines) && recentOutputLines.length > 0) {
    rawLines = recentOutputLines;
  } else if (typeof recentOutput === "string" && recentOutput.trim()) {
    rawLines = recentOutput.split(/\r?\n/);
  }

  const cleaned: string[] = [];
  for (const line of rawLines) {
    const clean = sanitizeSingleLine(line);
    if (clean.length > 0) {
      cleaned.push(clean);
    }
  }

  // Retain only the newest 2 lines
  return cleaned.slice(-2);
}

/** Maintain rolling activity tape (at most 2 previous + 1 active) */
export function updateActivityTape(
  existingActivities: WidgetActivity[],
  currentTool?: { tool?: string; name?: string; args?: string | Record<string, unknown> },
  recentTools?: Array<{ tool: string; args: string }>,
  currentOutputLines?: string[]
): WidgetActivity[] {
  const result: WidgetActivity[] = [];

  // 1. Process recent tools as previous activities
  const previousList: WidgetActivity[] = [];

  // Include existing previous activities
  for (const act of existingActivities) {
    if (act.status === "previous") {
      previousList.push(act);
    } else if (act.status === "active") {
      // Former active becomes previous
      previousList.push({
        ...act,
        status: "previous",
        output: [], // clear active output when moving to previous
      });
    }
  }

  // Include new recentTools
  if (Array.isArray(recentTools)) {
    for (const t of recentTools) {
      const norm = normalizeToolCall(t.tool, t.args);
      if (norm) {
        previousList.push({
          key: `${norm.kind}:${norm.label}:${norm.detail ?? ""}`,
          kind: norm.kind,
          label: norm.label,
          detail: norm.detail,
          status: "previous",
          output: [],
        });
      }
    }
  }

  // Deduplicate consecutive previous activities
  const dedupedPrevious: WidgetActivity[] = [];
  for (const act of previousList) {
    const last = dedupedPrevious[dedupedPrevious.length - 1];
    if (last && last.kind === act.kind && last.label === act.label && last.detail === act.detail) {
      // Replace with newer
      dedupedPrevious[dedupedPrevious.length - 1] = act;
    } else {
      dedupedPrevious.push(act);
    }
  }

  // Keep at most 2 newest previous activities
  const boundedPrevious = dedupedPrevious.slice(-2);
  result.push(...boundedPrevious);

  // 2. Active activity
  const activeToolName = (currentTool as any)?.name ?? (currentTool as any)?.tool;
  const activeToolArgs = (currentTool as any)?.args;
  const activeNorm = normalizeToolCall(activeToolName, activeToolArgs);

  if (activeNorm) {
    const activeKey = `${activeNorm.kind}:${activeNorm.label}:${activeNorm.detail ?? ""}`;
    // If the last previous activity is identical to current active, remove it from previous
    if (result.length > 0) {
      const lastPrev = result[result.length - 1];
      if (lastPrev.kind === activeNorm.kind && lastPrev.label === activeNorm.label && lastPrev.detail === activeNorm.detail) {
        result.pop();
      }
    }

    result.push({
      key: activeKey,
      kind: activeNorm.kind,
      label: activeNorm.label,
      detail: activeNorm.detail,
      status: "active",
      output: currentOutputLines ?? [],
    });
  }

  return result;
}

/** Derive workflow route steps */
export function deriveWorkflowRoute(
  source: "auto" | "plan" | "spec" | "tickets" | "manual" | undefined,
  mode: WorkflowMode,
  currentNodeId: string,
  reviewRound: number = 1
): WorkflowRouteStep[] {
  const src = source ?? "auto";

  if (src === "spec") {
    if (mode === "strict") {
      return [
        { label: "implement", status: currentNodeId === "implement" ? "active" : "completed" },
        { label: "verification", status: "pending" },
        { label: "review A/B", status: currentNodeId.includes("review") ? "active" : "pending" },
        { label: "final review", status: "pending" },
        { label: "complete", status: "pending" },
      ];
    }
    return [
      { label: "implement", status: currentNodeId === "implement" ? "active" : "completed" },
      { label: "verification", status: "pending" },
      { label: "review", status: currentNodeId.includes("review") ? "active" : "pending" },
      { label: "complete", status: "pending" },
    ];
  }

  if (src === "tickets") {
    return [
      { label: "ticket execution", status: "active" },
      { label: "final verification", status: "pending" },
      { label: "final review", status: "pending" },
      { label: "complete", status: "pending" },
    ];
  }

  if (src === "plan") {
    return [
      { label: "plan", status: "active" },
      { label: "complete", status: "pending" },
    ];
  }

  // Auto workflow
  if (currentNodeId.startsWith("fix")) {
    return [
      { label: `fix round ${reviewRound}`, status: "active" },
      { label: "verification", status: "pending" },
      { label: `review round ${reviewRound + 1}`, status: "pending" },
    ];
  }

  if (mode === "strict") {
    return [
      { label: "explore", status: currentNodeId === "scout" ? "active" : "completed" },
      { label: "plan", status: currentNodeId === "plan" ? "active" : currentNodeId === "scout" ? "pending" : "completed" },
      { label: "implement", status: currentNodeId === "implement" ? "active" : "pending" },
      { label: "review A/B", status: "pending" },
      { label: "final review", status: "pending" },
      { label: "complete", status: "pending" },
    ];
  }

  if (mode === "quick") {
    return [
      { label: "plan", status: currentNodeId === "plan" ? "active" : "completed" },
      { label: "implement", status: currentNodeId === "implement" ? "active" : "pending" },
      { label: "review", status: currentNodeId.startsWith("review") ? "active" : "pending" },
      { label: "complete", status: "pending" },
    ];
  }

  // Normal mode
  return [
    { label: "explore", status: currentNodeId === "scout" ? "active" : "completed" },
    { label: "plan", status: currentNodeId === "plan" ? "active" : currentNodeId === "scout" ? "pending" : "completed" },
    { label: "implement", status: currentNodeId === "implement" ? "active" : "pending" },
    { label: "review", status: currentNodeId.startsWith("review") ? "active" : "pending" },
    { label: "complete", status: "pending" },
  ];
}

/** Format next route string */
export function formatNextRoute(route: WorkflowRouteStep[]): string {
  const activeIdx = route.findIndex((r) => r.status === "active");
  const nextSteps = activeIdx >= 0 ? route.slice(activeIdx + 1) : route;
  if (nextSteps.length === 0) return "Next: complete";
  return `Next: ${nextSteps.map((s) => s.label).join(" → ")}`;
}

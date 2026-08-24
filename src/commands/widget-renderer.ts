import {
  stripAnsi,
  formatStageLabel,
  formatAgentRole,
  formatNextRoute,
  type WidgetActivity,
  type WorkflowRouteStep,
} from "./activity-normalizer.ts";
import { truncateMiddle } from "../utils/truncate.ts";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface WidgetDiagnostics {
  model?: string;
  context?: "fresh" | "fork";
  retry?: number;
  error?: string;
  stale?: boolean;
}

export interface WidgetState {
  runId: string;
  source?: "auto" | "plan" | "spec" | "tickets" | "manual";
  mode?: "quick" | "normal" | "strict";
  label?: string;
  nodeId?: string;
  node?: string; // backwards compatibility
  stageLabel?: string;
  agent?: string;
  action?: string;
  activities?: WidgetActivity[];
  route?: WorkflowRouteStep[];
  nodeTokens?: number;
  tokens?: number; // backwards compatibility alias
  toolCount?: number;
  expanded?: boolean;
  spinnerFrame?: number;
  durationMs?: number;
  lastProgressAt?: number;
  now?: number;
  diagnostics?: WidgetDiagnostics;

  // Backwards compatibility legacy fields
  tool?: { name: string; args?: string };
  stdout?: string;
}

export interface ThemeHelper {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

/** Measure visible printable length of a string ignoring ANSI escapes */
export function getVisibleLength(text: string): number {
  return stripAnsi(text).length;
}

/** Truncate text to a maximum visible width, appending ellipsis if truncated */
export function truncateToVisibleWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const visibleLen = getVisibleLength(text);
  if (visibleLen <= maxWidth) return text;

  // If there are no ANSI escape codes, simple slice
  if (!text.includes("\x1b")) {
    return text.slice(0, Math.max(0, maxWidth - 1)) + "…";
  }

  // Handle text with ANSI codes: iterate characters tracking visible width
  let result = "";
  let visibleCount = 0;
  let inEscape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\x1b") {
      inEscape = true;
      result += char;
      continue;
    }
    if (inEscape) {
      result += char;
      if (char === "m" || char === "a" || char === "A" || char === "z" || char === "Z" || char === "\x07") {
        inEscape = false;
      }
      continue;
    }

    if (visibleCount + 1 > maxWidth - 1) {
      result += "…\x1b[0m";
      break;
    }

    result += char;
    visibleCount++;
  }

  return result;
}

/** Format token count into human-readable string */
export function formatTokens(tokens?: number): string {
  const count = tokens ?? 0;
  if (count <= 0) return "0 tok";
  if (count < 1000) return `${count} tok`;
  return `${(count / 1000).toFixed(1)}k tok`;
}

/** Format duration in milliseconds to human-readable string (seconds or m:ss) */
export function formatDuration(ms?: number): string {
  if (ms == null || ms < 0) return "0.0s";
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

/** Pure renderer for live workflow widget */
export function renderLiveWidget(
  state: WidgetState,
  width: number = 100,
  theme?: ThemeHelper
): string[] {
  const colorize = (color: string, text: string) => {
    return theme?.fg ? theme.fg(color, text) : text;
  };
  const makeBold = (text: string) => {
    return theme?.bold ? theme.bold(text) : text;
  };

  const frameIdx = (state.spinnerFrame ?? 0) % SPINNER_FRAMES.length;
  const glyph = SPINNER_FRAMES[frameIdx];
  const now = state.now ?? Date.now();
  const nodeId = state.nodeId || state.node || "worker";
  const stage = state.stageLabel || formatStageLabel(nodeId);
  const agentRole = formatAgentRole(state.agent, nodeId);
  const effectiveTokens = state.nodeTokens ?? state.tokens ?? 0;
  const durationMs = state.durationMs ?? 0;
  const source = state.source ?? (state.label === "spec" ? "spec" : "auto");
  const mode = state.mode ?? "normal";

  // 1. Build Header Banner
  const isNarrow = width < 60;
  let headerText = "";

  if (isNarrow) {
    // Narrow priority: 1. spinner, 2. stage, 3. duration, 4. mode, 5. tokens, 6. source
    // Construct header fitting width
    const base = `${colorize("accent", glyph)} ${stage} · ${formatDuration(durationMs)}`;
    if (getVisibleLength(`${base} · ${mode}`) <= width) {
      headerText = `${base} · ${mode}`;
    } else {
      headerText = base;
    }
  } else {
    // Normal header: ⠸ pi-workflow · spec/strict · Implement · 1:06 · node 232.6k tok
    const brand = `pi-workflow · ${source}/${mode}`;
    const durStr = formatDuration(durationMs);
    const tokStr = `node ${formatTokens(effectiveTokens)}`;
    headerText = `${colorize("accent", glyph)} ${brand} · ${stage} · ${durStr} · ${tokStr}`;
  }

  // 2. Collapsed View
  if (!state.expanded) {
    const lines: string[] = [];
    lines.push(truncateToVisibleWidth(headerText, width));

    // Agent and action row
    const actionText = state.action || "Working...";
    const nodeRow = `└─ ${agentRole} · ${actionText}`;
    lines.push(truncateToVisibleWidth(nodeRow, width));

    // Toggle hint
    const toggleHint = "   Ctrl+O 查看最近活动";
    lines.push(truncateToVisibleWidth(colorize("dim", toggleHint), width));

    return lines.slice(0, 3);
  }

  // 3. Expanded View
  const lines: string[] = [];
  lines.push(truncateToVisibleWidth(headerText, width));

  // Active stage row
  const activeAction = state.action || "Working...";
  lines.push(truncateToVisibleWidth(`├─ ${agentRole} · ${activeAction}`, width));
  lines.push(`│`);

  // Telemetry activities
  const activities = state.activities ?? [];

  // If no activities yet (or empty)
  if (activities.length === 0 && !state.tool) {
    const elapsedSec = Math.floor(durationMs / 1000);
    const waitStr = `├─ Waiting for first activity update · ${elapsedSec}s`;
    lines.push(truncateToVisibleWidth(colorize("dim", waitStr), width));
  } else if (activities.length > 0) {
    lines.push(`├─ Recent activity`);

    // In narrow width, show at most 1 previous activity
    const previousActs = activities.filter((a) => a.status === "previous");
    const activeAct = activities.find((a) => a.status === "active");

    const maxPrevious = isNarrow ? 1 : 2;
    const displayedPrevious = previousActs.slice(-maxPrevious);
    const displayActs = [...displayedPrevious, ...(activeAct ? [activeAct] : [])];

    for (const act of displayActs) {
      let detailText = act.detail ? ` ${act.detail}` : "";
      if (act.detail && isNarrow && act.detail.length > 25) {
        detailText = ` ${truncateMiddle(act.detail, 25)}`;
      }

      if (act.status === "previous") {
        const line = `│  · ${act.label}${detailText}`;
        lines.push(truncateToVisibleWidth(line, width));
      } else {
        const line = `│  ${colorize("accent", glyph)} ${act.label}${detailText}`;
        lines.push(truncateToVisibleWidth(line, width));

        // Output lines (at most 2)
        if (act.output && act.output.length > 0) {
          for (const outLine of act.output.slice(-2)) {
            const outFormatted = `│    ${colorize("dim", outLine)}`;
            lines.push(truncateToVisibleWidth(outFormatted, width));
          }
        }
      }
    }
    lines.push(`│`);
  } else if (state.tool?.name) {
    // Fallback for legacy tool property
    lines.push(`├─ Recent activity`);
    const argsStr = state.tool.args ? ` ${state.tool.args}` : "";
    lines.push(truncateToVisibleWidth(`│  ${colorize("accent", glyph)} ${state.tool.name}${argsStr}`, width));
    if (state.stdout) {
      lines.push(truncateToVisibleWidth(`│    ${colorize("dim", state.stdout)}`, width));
    }
    lines.push(`│`);
  }

  // Freshness line
  const lastProgressAt = state.lastProgressAt;
  const toolCount = state.toolCount ?? (activities.length > 0 ? activities.length : 0);
  const toolCallsStr = toolCount > 0 ? ` · ${toolCount} tool calls` : "";

  if (lastProgressAt != null) {
    const ageSec = Math.max(0, Math.floor((now - lastProgressAt) / 1000));
    if (ageSec < 30) {
      const freshLine = `├─ Last progress ${ageSec}s ago${toolCallsStr}`;
      lines.push(truncateToVisibleWidth(colorize("dim", freshLine), width));
    } else if (ageSec < 120) {
      const staleLine = `├─ No observable progress for ${ageSec}s${toolCallsStr}`;
      lines.push(truncateToVisibleWidth(colorize("warning", staleLine), width));
    } else {
      const min = Math.floor(ageSec / 60);
      const sec = ageSec % 60;
      const ageStr = `${min}m ${sec}s`;
      const severeStaleLine = `├─ No observable progress for ${ageStr}${toolCallsStr}`;
      lines.push(truncateToVisibleWidth(colorize("error", severeStaleLine), width));
    }
  }

  // Next Route line
  const route = state.route ?? [];
  if (route.length > 0) {
    const routeText = formatNextRoute(route);
    lines.push(truncateToVisibleWidth(`├─ ${routeText}`, width));
  }

  // Diagnostics line (only when retry, failure, error, or stale > 120s)
  const isStale = lastProgressAt != null && Math.floor((now - lastProgressAt) / 1000) >= 120;
  const hasDiag = state.diagnostics?.error || state.diagnostics?.retry || isStale;
  if (hasDiag && !isNarrow) {
    const diagParts = [state.runId, nodeId];
    if (state.diagnostics?.context) diagParts.push(state.diagnostics.context);
    if (state.diagnostics?.retry) diagParts.push(`retry #${state.diagnostics.retry}`);
    lines.push(truncateToVisibleWidth(colorize("dim", `├─ Diagnostics: ${diagParts.join(" · ")}`), width));
  }

  // Footer toggle hint
  lines.push(truncateToVisibleWidth(`└─ ${colorize("dim", "Ctrl+O 折叠")}`, width));

  // Height bounding: ensure expanded widget never exceeds 12 rows
  if (lines.length > 12) {
    // Preserve header (0..1), footer (last 3: freshness, route, toggle)
    // Trim extra activity rows from the middle
    while (lines.length > 12) {
      // Find an activity row to remove (starting from index 3)
      if (lines.length > 5) {
        lines.splice(3, 1);
      } else {
        break;
      }
    }
  }

  return lines;
}

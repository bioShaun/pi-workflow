export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface WidgetState {
  runId: string;
  mode: "quick" | "normal" | "strict";
  node: string;
  agent: string;
  action: string;
  tool?: { name: string; args?: string };
  stdout?: string;
  tokens: number;
  expanded: boolean;
  spinnerFrame?: number;
  durationMs?: number;
}

export interface ThemeHelper {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

/**
 * Truncate a string to maxWidth while keeping it visually bounded
 */
function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)) + "…";
}

/**
 * Format token count to human readable 'k' string
 */
export function formatTokens(tokens: number): string {
  if (!tokens || tokens <= 0) return "0 tok";
  if (tokens < 1000) return `${tokens} tok`;
  return `${(tokens / 1000).toFixed(1)}k tok`;
}

/**
 * Format duration in milliseconds to human readable 's' string
 */
export function formatDuration(ms?: number): string {
  if (ms == null || ms < 0) return "0.0s";
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Pure function rendering the live tree-branch widget for aboveEditor placement
 */
export function renderLiveWidget(
  state: WidgetState,
  width: number = 100,
  theme?: ThemeHelper
): string[] {
  const frameIdx = (state.spinnerFrame ?? 0) % SPINNER_FRAMES.length;
  const glyph = SPINNER_FRAMES[frameIdx];

  const colorize = (color: string, text: string) => {
    return theme?.fg ? theme.fg(color, text) : text;
  };
  const makeBold = (text: string) => {
    return theme?.bold ? theme.bold(text) : text;
  };

  const lines: string[] = [];

  // 1. Header Banner
  const headerLeft = `${colorize("accent", glyph)} [pi-workflow] auto (${state.mode})`;
  const durStr = state.durationMs ? ` · ${formatDuration(state.durationMs)}` : "";
  const tokStr = formatTokens(state.tokens);
  const headerRight = `node: ${state.node}${durStr} · ${tokStr}`;

  // Simple one-line header
  lines.push(truncateText(`${headerLeft} · ${headerRight}`, width));

  // 2. Active Node Row
  const nodeRow = `├─ ${colorize("accent", glyph)} ${makeBold(state.agent)} (${state.action})`;
  lines.push(truncateText(nodeRow, width));

  // 3. Tool Row (if tool is present)
  if (state.tool?.name) {
    const argsStr = state.tool.args ? ` (${state.tool.args})` : "";
    const toolRow = `│  ⎿ tool: ${colorize("accent", state.tool.name)}${argsStr}`;
    lines.push(truncateText(toolRow, width));
  }

  // 4. Stdout Row (if stdout is present)
  if (state.stdout) {
    const stdoutRow = `│  ⎿ ${colorize("dim", state.stdout)}`;
    lines.push(truncateText(stdoutRow, width));
  }

  // 5. Expanded verbose block
  if (state.expanded) {
    lines.push(truncateText(`│  ⎿ context: fresh · runId: ${state.runId}`, width));
    if (state.tool) {
      lines.push(truncateText(`│  ⎿ status: in-flight I/O · mode: ${state.mode}`, width));
    }
  }

  // 6. Footer hint
  const toggleHint = state.expanded ? "按 Ctrl+O 折叠详情" : "按 Ctrl+O 展开实时工具输出";
  lines.push(truncateText(`└─ ${colorize("dim", toggleHint)}`, width));

  return lines;
}

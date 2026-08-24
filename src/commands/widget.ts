import type { Component, TUI } from "@earendil-works/pi-tui";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { renderLiveWidget, type WidgetState, type ThemeHelper } from "./widget-renderer.ts";
import { updateActivityTape } from "./activity-normalizer.ts";
import type { WorkflowUI } from "./ui-port.ts";

export const WIDGET_KEY = "pi-workflow-live";

/**
 * Check if the input key is Ctrl+O.
 *
 * Terminals that negotiated the kitty keyboard protocol or xterm
 * modifyOtherKeys deliver Ctrl+O as an escape sequence (e.g. "\x1b[111;5u"
 * or "\x1b[27;5;111~") instead of the raw 0x0F byte, so matching must go
 * through pi-tui's matchesKey. Release events are ignored: input listeners
 * run before the TUI's own release filter.
 */
export function isCtrlO(data: string): boolean {
  if (!data || isKeyRelease(data)) return false;
  return matchesKey(data, "ctrl+o");
}

export class WorkflowLiveWidget {
  public state: WidgetState;
  private ui?: WorkflowUI;
  private tui?: TUI;
  private tickerTimer?: ReturnType<typeof setInterval>;
  private unsubscribeInput?: () => void;
  private lastRenderKey: string = "";
  private isDisposed: boolean = false;

  constructor(initialState: WidgetState) {
    const now = initialState.now ?? Date.now();
    this.state = {
      ...initialState,
      spinnerFrame: initialState.spinnerFrame ?? 0,
      expanded: initialState.expanded ?? false,
      now,
      lastProgressAt: initialState.lastProgressAt ?? now,
      nodeTokens: initialState.nodeTokens ?? initialState.tokens ?? 0,
      toolCount: initialState.toolCount ?? 0,
      activities: initialState.activities ?? [],
      route: initialState.route ?? [],
    };
  }

  public update(patch: Partial<WidgetState>): void {
    if (this.isDisposed) return;

    const prevNode = this.state.nodeId || this.state.node || "worker";
    const nextNode = patch.nodeId || patch.node || prevNode;

    const effectiveTokens = patch.nodeTokens ?? patch.tokens ?? (nextNode !== prevNode ? 0 : this.state.nodeTokens);

    let activities = patch.activities;
    if (!activities && patch.tool) {
      const outLines = patch.stdout ? [patch.stdout] : undefined;
      activities = updateActivityTape(
        nextNode !== prevNode ? [] : (this.state.activities ?? []),
        patch.tool,
        undefined,
        outLines
      );
    }

    // Node transition resets previous node's activities and stale state
    if (nextNode !== prevNode) {
      this.state = {
        ...this.state,
        ...patch,
        nodeId: nextNode,
        node: nextNode,
        nodeTokens: effectiveTokens,
        tokens: effectiveTokens,
        activities: activities ?? [],
        toolCount: patch.toolCount ?? 0,
        lastProgressAt: patch.lastProgressAt ?? Date.now(),
        now: Date.now(),
      };
    } else {
      this.state = {
        ...this.state,
        ...patch,
        nodeTokens: effectiveTokens,
        tokens: effectiveTokens,
        ...(activities ? { activities } : {}),
        now: patch.now ?? this.state.now ?? Date.now(),
      };
    }

    this.requestRenderIfChanged();
  }

  public getRenderKey(): string {
    const now = this.state.now ?? Date.now();
    const lastProg = this.state.lastProgressAt;
    const freshnessAgeSec = lastProg != null ? Math.floor((now - lastProg) / 1000) : undefined;
    const durSec = Math.floor((this.state.durationMs ?? 0) / 1000);

    return JSON.stringify({
      nodeId: this.state.nodeId || this.state.node,
      agent: this.state.agent,
      action: this.state.action,
      activities: (this.state.activities ?? []).map((a) => ({
        k: a.kind,
        l: a.label,
        d: a.detail,
        s: a.status,
        o: a.output,
      })),
      route: (this.state.route ?? []).map((r) => `${r.label}:${r.status}`),
      tokens: this.state.nodeTokens ?? this.state.tokens,
      toolCount: this.state.toolCount,
      expanded: this.state.expanded,
      frame: this.state.spinnerFrame,
      dur: durSec,
      freshness: freshnessAgeSec,
    });
  }

  private requestRenderIfChanged(): void {
    const key = this.getRenderKey();
    if (key !== this.lastRenderKey) {
      this.lastRenderKey = key;
      this.tui?.requestRender();
      if (this.ui?.isRPC?.() && this.ui.hasUI()) {
        try {
          this.ui.setWidget(WIDGET_KEY, this.renderRPC(), { placement: "aboveEditor" });
        } catch {
          // Ignore RPC refresh errors
        }
      }
    }
  }

  public render(width: number, theme?: ThemeHelper): string[] {
    return renderLiveWidget(this.state, width, theme);
  }

  public renderRPC(): string[] {
    return renderLiveWidget(this.state, 100);
  }

  public handleTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (this.isDisposed) return undefined;
    if (isCtrlO(data)) {
      this.state.expanded = !this.state.expanded;
      this.requestRenderIfChanged();
      return { consume: true };
    }
    return undefined;
  }

  public createComponent(): (tui: TUI, theme: any) => Component & { dispose?(): void } {
    return (tui: TUI, theme: any) => {
      this.tui = tui;
      return {
        render: (width: number) => this.render(width, theme),
        invalidate: () => {
          this.lastRenderKey = "";
        },
        dispose: () => {
          if (this.tui === tui) {
            this.tui = undefined;
          }
        },
      };
    };
  }

  public attach(ui: WorkflowUI): void {
    if (this.isDisposed) return;
    this.ui = ui;

    // Register widget with ui port
    if (ui.hasUI()) {
      if (ui.isRPC()) {
        ui.setWidget(WIDGET_KEY, this.renderRPC(), { placement: "aboveEditor" });
      } else {
        ui.setWidget(WIDGET_KEY, this.createComponent(), { placement: "aboveEditor" });
      }
    }

    // Subscribe to Ctrl+O terminal input
    if (ui.onTerminalInput) {
      this.unsubscribeInput = ui.onTerminalInput((data) => this.handleTerminalInput(data));
    }

    // Start 500ms spinner ticker
    if (!this.tickerTimer) {
      this.tickerTimer = setInterval(() => {
        if (this.isDisposed) return;
        this.state.now = Date.now();
        this.state.spinnerFrame = ((this.state.spinnerFrame ?? 0) + 1) % 10;
        this.requestRenderIfChanged();
      }, 500);
      if (typeof this.tickerTimer.unref === "function") {
        this.tickerTimer.unref();
      }
    }
  }

  public dispose(ui?: WorkflowUI): void {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = undefined;
    }

    if (this.unsubscribeInput) {
      this.unsubscribeInput();
      this.unsubscribeInput = undefined;
    }

    const effectiveUI = ui ?? this.ui;
    if (effectiveUI && effectiveUI.hasUI()) {
      effectiveUI.setWidget(WIDGET_KEY, undefined);
    }

    this.tui = undefined;
    this.ui = undefined;
  }
}

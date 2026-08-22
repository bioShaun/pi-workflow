import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderLiveWidget, type WidgetState, type ThemeHelper } from "./widget-renderer.ts";
import type { WorkflowUI } from "./ui-port.ts";

export const WIDGET_KEY = "pi-workflow-live";

/**
 * Check if the input key is Ctrl+O (ASCII 15)
 */
export function isCtrlO(data: string): boolean {
  return data === "\x0f" || data === "\u000f";
}

export class WorkflowLiveWidget {
  public state: WidgetState;
  private tui?: TUI;
  private tickerTimer?: ReturnType<typeof setInterval>;
  private unsubscribeInput?: () => void;
  private lastRenderKey: string = "";
  private isDisposed: boolean = false;

  constructor(initialState: WidgetState) {
    this.state = {
      ...initialState,
      spinnerFrame: initialState.spinnerFrame ?? 0,
      expanded: initialState.expanded ?? false,
    };
  }

  public update(patch: Partial<WidgetState>): void {
    if (this.isDisposed) return;
    this.state = { ...this.state, ...patch };
    this.requestRenderIfChanged();
  }

  public getRenderKey(): string {
    return JSON.stringify({
      node: this.state.node,
      agent: this.state.agent,
      action: this.state.action,
      tool: this.state.tool,
      stdout: this.state.stdout,
      tokens: this.state.tokens,
      expanded: this.state.expanded,
      frame: this.state.spinnerFrame,
      dur: Math.floor((this.state.durationMs ?? 0) / 1000),
    });
  }

  private requestRenderIfChanged(): void {
    const key = this.getRenderKey();
    if (key !== this.lastRenderKey) {
      this.lastRenderKey = key;
      this.tui?.requestRender();
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

    if (ui && ui.hasUI()) {
      ui.setWidget(WIDGET_KEY, undefined);
    }

    this.tui = undefined;
  }
}

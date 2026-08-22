import type { ExtensionCommandContext, ExtensionWidgetOptions, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export interface WorkflowUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setWorking(message?: string): void;
  setWidget(
    key: string,
    content: string[] | ((tui: TUI, theme: any) => Component & { dispose?(): void }) | undefined,
    options?: ExtensionWidgetOptions
  ): void;
  onTerminalInput?(handler: TerminalInputHandler): () => void;
  hasUI(): boolean;
  isRPC(): boolean;
  getTheme?(): any;
}

export function isStaleExtensionContextError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const msg = String((err as any).message || "");
  return (
    msg.includes("context is no longer active") ||
    msg.includes("session has ended") ||
    msg.includes("disposed")
  );
}

export function createWorkflowUI(ctx: ExtensionCommandContext): WorkflowUI {
  const hasUI = Boolean(ctx.hasUI && (ctx as any).ui);
  const isRPC = Boolean((ctx as any).mode === "rpc");

  return {
    hasUI: () => hasUI,
    isRPC: () => isRPC,
    getTheme: () => (hasUI ? (ctx as any).ui?.theme : undefined),
    notify: (message, type = "info") => {
      try {
        if (hasUI && typeof (ctx as any).ui?.notify === "function") {
          (ctx as any).ui.notify(message, type);
        }
      } catch (err) {
        if (!isStaleExtensionContextError(err)) throw err;
      }
    },
    setWorking: (message) => {
      try {
        if (hasUI && typeof (ctx as any).ui?.setWorkingMessage === "function") {
          (ctx as any).ui.setWorkingMessage(message);
        }
      } catch (err) {
        if (!isStaleExtensionContextError(err)) throw err;
      }
    },
    setWidget: (key, content, options = { placement: "aboveEditor" }) => {
      try {
        if (hasUI && typeof (ctx as any).ui?.setWidget === "function") {
          (ctx as any).ui.setWidget(key, content as any, options);
        }
      } catch (err) {
        if (!isStaleExtensionContextError(err)) throw err;
      }
    },
    onTerminalInput: (handler) => {
      try {
        if (hasUI && typeof (ctx as any).ui?.onTerminalInput === "function") {
          return (ctx as any).ui.onTerminalInput(handler);
        }
      } catch (err) {
        if (!isStaleExtensionContextError(err)) throw err;
      }
      return () => {};
    },
  };
}

import type { WorkflowConfig, WorkflowMode } from "../contracts/workflow.ts";

export type WorkflowRole = keyof WorkflowConfig["agents"];

export interface PreflightDiagnostic {
  agent: string;
  code?: string;
  message: string;
}

export interface PreflightCheckResult {
  ok: boolean;
  error?: string;
  diagnostics?: PreflightDiagnostic[];
  /**
   * Resolved role → agent-name mapping. Always present when `ok` is true.
   * Audit Finding 10: this is RETURNED instead of mutating `config.agents`.
   */
  agents?: Record<WorkflowRole, string>;
  /** True when pi-subagents/preflight could not be loaded in this runtime. */
  moduleUnavailable?: boolean;
}

export interface PreflightContractResult {
  ok: boolean;
  code?: string;
  message?: string;
  diagnostics?: Array<{ code?: string; message: string }>;
}

export interface PreflightModule {
  resolveSubagentLaunchContract?: (input: {
    agent: string;
    task?: string;
    context?: "fresh" | "fork";
    cwd: string;
  }) => Promise<PreflightContractResult>;
}

export type PreflightModuleImport = () => Promise<PreflightModule>;

// Kept as an opaque `string` (not a literal) so TypeScript does not follow
// the import and pull pi-subagents' internal source graph into this package's
// typecheck (the module is only loadable in the Pi runtime anyway).
const PREFLIGHT_MODULE_SPECIFIER: string = "pi-subagents/preflight";

const DEFAULT_PREFLIGHT_IMPORT: PreflightModuleImport = (): Promise<PreflightModule> =>
  import(PREFLIGHT_MODULE_SPECIFIER) as Promise<PreflightModule>;

/**
 * Node ESM module-loading error codes. Any of these means "the pi-subagents
 * preflight module is not loadable in THIS runtime" (for example plain
 * `node` refusing type stripping for files under node_modules), which is the
 * module-not-found class that §29 tolerates. Genuine resolution failures
 * (the module loaded but a role cannot launch) are surfaced, not swallowed.
 */
const MODULE_LOAD_ERROR_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_INVALID_MODULE_SPECIFIER",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_INVALID_MODULE_MANIFEST",
]);

function isModuleLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && MODULE_LOAD_ERROR_CODES.has(code);
}

const ROLE_FALLBACKS: Record<WorkflowRole, string[]> = {
  scout: ["scout", "researcher"],
  planner: ["planner", "researcher", "scout", "oracle"],
  worker: ["worker"],
  reviewer: ["reviewer"],
};

export async function validateWorkflowPreflight(
  config: WorkflowConfig,
  cwd: string,
  mode: WorkflowMode,
  importPreflightModule: PreflightModuleImport = DEFAULT_PREFLIGHT_IMPORT,
  /**
   * Overrides the mode-derived role set. The spec-driven flow (/work spec)
   * runs no scout or planner node, so it passes ["worker", "reviewer"].
   */
  requiredRoles?: WorkflowRole[]
): Promise<PreflightCheckResult> {
  const effectiveRoles: WorkflowRole[] =
    requiredRoles ?? (mode === "quick" ? ["planner", "worker", "reviewer"] : ["scout", "planner", "worker", "reviewer"]);

  const resolved: Record<WorkflowRole, string> = { ...config.agents };
  const diagnostics: PreflightDiagnostic[] = [];

  // Load the pi-subagents preflight module. Only module-loading (not-found)
  // errors are tolerated as "preflight unavailable"; anything thrown by the
  // preflight logic itself is a genuine failure and is surfaced per §29.
  let preflightMod: PreflightModule | undefined;
  try {
    preflightMod = await importPreflightModule();
  } catch (error) {
    if (isModuleLoadError(error)) {
      return {
        ok: true,
        agents: resolved,
        moduleUnavailable: true,
        diagnostics: [
          {
            agent: "*",
            code: "preflight_module_unavailable",
            message:
              `pi-subagents/preflight is not loadable in this runtime ` +
              `(${(error as NodeJS.ErrnoException).code ?? "module load error"}); agent preflight skipped.`,
          },
        ],
      };
    }
    const message = `Failed to load pi-subagents/preflight: ${error instanceof Error ? error.message : String(error)}`;
    diagnostics.push({ agent: "*", code: "preflight_module_error", message });
    return { ok: false, error: message, diagnostics };
  }

  const resolve = preflightMod?.resolveSubagentLaunchContract;
  if (typeof resolve !== "function") {
    return {
      ok: true,
      agents: resolved,
      moduleUnavailable: true,
      diagnostics: [
        {
          agent: "*",
          code: "preflight_module_unavailable",
          message: "pi-subagents/preflight does not export resolveSubagentLaunchContract; agent preflight skipped.",
        },
      ],
    };
  }

  for (const role of effectiveRoles) {
    const configuredAgent = config.agents[role];
    if (!configuredAgent || !configuredAgent.trim()) {
      diagnostics.push({
        agent: role,
        code: "missing_agent_config",
        message: `No agent configured for required workflow role: "${role}"`,
      });
      continue;
    }

    const candidates = [
      configuredAgent,
      ...(ROLE_FALLBACKS[role] ?? []).filter((c) => c !== configuredAgent),
    ];

    let lastError: { code?: string; message: string } | undefined;

    for (const candidate of candidates) {
      let result: PreflightContractResult;
      try {
        // All roles are prefetched with context "fresh": preflight validates
        // that the agent can launch at all. The planner's fork context is
        // enforced (and degraded, audit Finding 1) at execution time; without
        // a host session snapshot a fork preflight check can only report
        // host-required warnings.
        result = await resolve({ agent: candidate, task: `Preflight check for ${role}`, context: "fresh", cwd });
      } catch (error) {
        // A throw from the preflight logic is a genuine failure — not a
        // missing module (handled above) and not "this candidate is
        // unavailable" (that is reported via result.ok === false, which is
        // the only signal that may trigger a fallback). Fallback candidates
        // must not mask it: surface immediately, including non-Error throws
        // (audit Finding 10; post-remediation review M3).
        const message = `Preflight check threw for ${role} agent "${candidate}": ${error instanceof Error ? error.message : String(error)}`;
        diagnostics.push({ agent: configuredAgent, code: "preflight_error", message });
        return { ok: false, error: message, diagnostics, agents: resolved };
      }

      if (result && result.ok) {
        resolved[role] = candidate;
        lastError = undefined;
        break;
      }
      if (result) {
        lastError = { code: result.code, message: result.message ?? "Preflight check failed" };
      }
    }

    if (lastError) {
      diagnostics.push({
        agent: configuredAgent,
        code: lastError.code,
        message: `Preflight check failed for ${role} agent "${configuredAgent}": ${lastError.message}`,
      });
    }
  }

  if (diagnostics.length > 0) {
    return {
      ok: false,
      error: diagnostics.map((d) => d.message).join("\n"),
      diagnostics,
      agents: resolved,
    };
  }

  return { ok: true, agents: resolved };
}

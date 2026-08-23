import type {
  RequirementSnapshot,
  SpecPolicy,
} from "../contracts/requirement.ts";

export interface SpecRequirementPrompt {
  snapshot: RequirementSnapshot;
  snapshotPath: string;
  policy: SpecPolicy;
}

/** Render the shared immutable spec contract identically for every agent role. */
export function renderRequirementSection(
  task: string,
  requirement?: SpecRequirementPrompt
): string[] {
  if (!requirement) {
    return ["## Original Requirement", task.trim()];
  }

  const lines = [
    "## Authoritative Requirement Snapshot",
    `Original source (read-only): \`${requirement.snapshot.sourcePath}\``,
    `Immutable run snapshot (read-only): \`${requirement.snapshotPath}\``,
    `SHA-256: \`${requirement.snapshot.sha256}\``,
    "Read the immutable snapshot in full before acting. It is the authoritative requirement.",
    "Do not edit either the original source document or the immutable run snapshot.",
    "",
    "### Engine Verification Commands",
    ...requirement.policy.verification.map((item) => `- \`${item.command}\``),
  ];
  if (requirement.policy.allowedChanges) {
    lines.push(
      "",
      "### Allowed Repository Changes",
      ...requirement.policy.allowedChanges.map((allowedPath) => `- \`${allowedPath}\``)
    );
  }
  return lines;
}

/**
 * Audit Finding 13: workflow nodes are non-interactive batch agents. When the
 * host session has pi-subagents' intercom bridge active, children are injected
 * with coordination instructions and a `contact_supervisor` tool at launch
 * (outside the agent's tools allowlist). A model that makes a routine
 * `progress_update` call gets its run DETACHED — the delegation reports
 * failure even though the child completed its structured output
 * (pi-subagents subagent-executor.ts: allowIntercomDetach).
 *
 * Every workflow node prompt MUST carry this rule. It is prevention, not a
 * guarantee; the engine additionally retries detach-class failures with an
 * explicit reminder (src/policies/intercom.ts).
 */
export const AUTONOMOUS_EXECUTION_RULE =
  "Work autonomously to completion. Do NOT use contact_supervisor, intercom, " +
  "or any other coordination/progress-reporting tool — no supervisor is " +
  "waiting, and such calls detach the run and discard your result. Return " +
  "only the requested structured output.";

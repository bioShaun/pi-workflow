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

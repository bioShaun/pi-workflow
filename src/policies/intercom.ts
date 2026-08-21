/**
 * Audit Finding 13: detect the "detached for intercom coordination" failure
 * emitted by pi-subagents when a delegated child calls contact_supervisor /
 * intercom and the run detaches (subagent-executor.ts detachedReason
 * "intercom coordination"; background runner INTERCOM_DETACH_RECEIPT).
 *
 * The child typically COMPLETED its task (exitCode 0, structured output
 * persisted) but the delegation surfaces a failure, so the engine retries
 * once with an explicit prohibition reminder appended to the prompt.
 */

export function isIntercomDetachError(error: string | undefined): boolean {
  if (!error) return false;
  const msg = error.toLowerCase();
  return (
    msg.includes("detached for intercom coordination") ||
    msg.includes("intercom coordination") ||
    msg.includes("contact_supervisor")
  );
}

/** Appended to the retry prompt when a node failed via intercom detach. */
export const INTERCOM_RETRY_REMINDER = [
  "Your previous attempt was discarded because it called a coordination tool",
  "(contact_supervisor / intercom), which detached the run. No supervisor is",
  "waiting: do NOT send progress updates or questions through coordination",
  "tools. Complete the task and return only the structured result.",
].join(" ");

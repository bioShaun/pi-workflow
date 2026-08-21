/**
 * Audit Finding 14: detect a worker/fixer that completed without making any
 * edits ("Subagent completed without making edits for an implementation
 * task"). pi-subagents' fileMutation effects gate fails such runs.
 *
 * This is a deterministic outcome — the child either deliberately refused
 * (impossible/contradictory requirement) or was lazy. A verbatim retry
 * repeats it (observed in integration run wf_20260821_173021_b04d), so the
 * engine fails the node immediately instead of spending the retry budget.
 */
export function isWorkerRefusalError(error: string | undefined): boolean {
  if (!error) return false;
  const msg = error.toLowerCase();
  return (
    msg.includes("completed without making edits") ||
    msg.includes("without making edits for an implementation task") ||
    msg.includes("planning or scratchpad output instead of applying changes")
  );
}

/** Wrap a refusal-class error with actionable guidance. */
export function wrapWorkerRefusal(nodeLabel: string, error: string): string {
  return (
    `${nodeLabel} declined to modify the repository. The requirement may be ` +
    `impossible or contradictory (or the worker was lazy); its analysis is in ` +
    `the subagent artifacts. Original error: ${error}`
  );
}

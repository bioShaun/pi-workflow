/**
 * Audit Finding 1: detect the deterministic "parent session not yet
 * persisted" fork failure emitted by pi-subagents.
 *
 * The exact message comes from pi-subagents/src/shared/fork-context.ts:
 *
 *   "Failed to create forked subagent session: Parent session file does not
 *    exist: <file>. Pi has not persisted enough history to fork yet."
 *
 * plus the two related pre-checks in the same module:
 *
 *   "Forked subagent context requires a persisted parent session."
 *   "Forked subagent context requires a current leaf to fork from."
 *
 * Such failures are NOT transient agent failures. The planner degrades to a
 * fresh context instead of consuming the agent retry budget, because the
 * planner prompt is self-contained (task + optional scout summary) and a
 * fresh execution remains correct.
 */
export function isForkUnavailableError(error: string | undefined): boolean {
  if (!error) return false;
  const msg = error.toLowerCase();
  return (
    msg.includes("parent session file does not exist") ||
    msg.includes("not persisted enough history") ||
    msg.includes("requires a persisted parent session") ||
    msg.includes("requires a current leaf to fork from")
  );
}

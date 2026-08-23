import type { WorkflowMode } from "./workflow.ts";

/**
 * Spec-driven hardening contracts: immutable requirement snapshots, the
 * machine-readable spec policy, engine-executed verification, and the actual
 * change-scope gate.
 */

/** One engine-executed, engine-verified command declared by a spec. */
export interface VerificationRequirement {
  command: string;
  required: true;
}

/**
 * Machine-readable policy parsed from the optional spec front matter
 * (`work.verify` / `work.changes.allow`). `verification` is always
 * non-empty: a spec without a declared list gets the default project
 * test-suite requirement.
 */
export interface SpecPolicy {
  verification: VerificationRequirement[];
  allowedChanges?: string[];
}

/**
 * Run-state metadata for the immutable requirement snapshot. The full
 * document bytes are persisted exactly once, under the run directory
 * (`artifactPath`, run-relative and resolving beneath it); state.json never
 * carries a second copy of the document.
 */
export interface RequirementSnapshot {
  kind: "spec";
  /** Original spec path, project-relative. */
  sourcePath: string;
  /** Run-relative artifact path (e.g. "requirement.md"). */
  artifactPath: string;
  /** SHA-256 (hex) of the exact original UTF-8 bytes. */
  sha256: string;
  /** Character count of the document. */
  characters: number;
}

/**
 * The default required verification for a spec run without declared
 * `work.verify`: the project test suite.
 */
export const DEFAULT_SPEC_VERIFICATION: VerificationRequirement[] = [
  { command: "npm test", required: true },
];

/**
 * Result of one engine-executed verification command. stdout/stderr are
 * bounded by the runner; the full output is not retained in state or events.
 */
export interface VerificationExecution {
  command: string;
  status: "passed" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
}

/**
 * One persisted verification iteration, under
 * `verification/implementation.json` or `verification/fix-<round>.json`.
 * Commands keep declaration order and all results.
 */
export interface VerificationArtifact {
  label: string;
  status: "passed" | "failed";
  passed: number;
  total: number;
  completedAt: string;
  commands: VerificationExecution[];
}

/**
 * Latest verification aggregate cached on the run state — bounded metadata
 * only (no raw command output), sized for status display and the completion
 * gate. The artifact and events remain the recovery evidence.
 */
export interface VerificationAggregate {
  label: string;
  status: "passed" | "failed";
  passed: number;
  total: number;
  commands: Array<{ command: string; status: "passed" | "failed"; exitCode: number }>;
  completedAt: string;
}

/** Latest change-scope aggregate cached on the run state. */
export interface ScopeAggregate {
  label: string;
  status: "passed" | "failed";
  /** Changed paths (vs. the captured baseline) outside the declared allowlist. */
  /** Every repository path changed relative to the exact initial baseline. */
  changed: string[];
  outOfScope: string[];
  completedAt: string;
}

/** One persisted scope iteration, under `scope/implementation.json` / `scope/fix-<round>.json`. */
export interface ScopeArtifact {
  label: string;
  status: "passed" | "failed";
  changed: string[];
  outOfScope: string[];
  completedAt: string;
}

/** Result of parsing a spec document (pure; see spec-parser). */
export interface ParsedSpecDocument {
  /** Markdown body (the document without the front matter block). */
  body: string;
  policy: {
    mode?: WorkflowMode;
    verification: VerificationRequirement[];
    allowedChanges?: string[];
  };
}

import type {
  RequirementSnapshot,
  ScopeAggregate,
  VerificationAggregate,
  VerificationRequirement,
} from "./requirement.ts";
import type { ReviewResult } from "./review.ts";
import type { RepositoryBaseline } from "./workflow.ts";

export type TicketTddPolicy =
  | { policy: "required" }
  | { policy: "exempt"; reason: string };

export interface TicketDefinition {
  id: string;
  title: string;
  capability: string;
  kind: "behavioral" | "documentation" | "mechanical";
  acceptanceCriteria: string[];
  blockedBy: string[];
  testingSeam: string;
  verification: VerificationRequirement[];
  redCommand?: string;
  allowedChanges?: string[];
  tdd: TicketTddPolicy;
  covers: string[];
  wideRefactorSequence?: "expand-migrate-contract";
}

export interface TicketFinalGate {
  acceptanceCriteria: string[];
  covers: string[];
  verification: VerificationRequirement[];
}

export interface TicketGraph {
  version: 1;
  requirement: Pick<RequirementSnapshot, "artifactPath" | "sha256">;
  tickets: TicketDefinition[];
  coverage: Record<string, string[]>;
  finalGate: TicketFinalGate;
  contentHash: string;
}

export interface TicketPlanSnapshot {
  artifactPath: string;
  sha256: string;
  ticketCount: number;
  characters: number;
}

export type TicketLifecyclePhase =
  | "pending"
  | "red_authoring"
  | "red_verification"
  | "implementing"
  | "green_verification"
  | "ticket_review"
  | "ticket_fix"
  | "ticket_completed"
  | "ticket_failed";

export interface TicketRuntimeState {
  id: string;
  phase: TicketLifecyclePhase;
  title: string;
  blockedBy: string[];
  reviewRound: number;
  fixRound: number;
  startedAt?: string;
  lastActivityAt?: string;
  tokens?: number;
  toolCount?: number;
  checkpoint?: RepositoryBaseline;
  verification?: VerificationAggregate;
  scope?: ScopeAggregate;
  red?: {
    command: string;
    exitCode: number;
    expectedFailure: string;
    changedTestPaths: string[];
    existingReproduction: boolean;
    status: "passed" | "failed";
  };
  review?: ReviewResult;
  completedCheckpoint?: RepositoryBaseline;
}

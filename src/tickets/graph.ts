import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RequirementSnapshot } from "../contracts/requirement.ts";
import type {
  TicketDefinition,
  TicketFinalGate,
  TicketGraph,
  TicketPlanSnapshot,
} from "../contracts/tickets.ts";
import {
  normalizeAllowedPath,
  normalizeVerificationCommands,
  SpecFormatError,
} from "../specs/spec-parser.ts";
import type { WorkflowRun } from "../contracts/workflow.ts";
import { resolveRunArtifactPath } from "../storage/paths.ts";
import { saveArtifact } from "../storage/store.ts";

const MAX_TICKETS = 64;
const MAX_TICKET_CHARACTERS = 32_000;
const MAX_GRAPH_CHARACTERS = 512_000;
const FINAL_FILENAMES = new Set(["final.md", "_final.md"]);

export function extractRequirementCriteria(content: string): string[] {
  const section = content.match(/^## Acceptance Criteria\s*$\n([\s\S]*?)(?=^##\s|(?![\s\S]))/mi)?.[1] ?? "";
  const criteria: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const explicit = line.match(/^\s*(?:[-*]|\d+\.)\s+(AC-[A-Za-z0-9._-]+)\s*:/i)?.[1];
    const numbered = line.match(/^\s*(\d+)\.\s+\S/)?.[1];
    const id = explicit?.toUpperCase() ?? (numbered ? `AC-${numbered}` : undefined);
    if (id && !criteria.includes(id)) criteria.push(id);
  }
  return criteria;
}

export interface TicketGraphValidationIssue {
  code:
    | "duplicate_id"
    | "unknown_blocker"
    | "cycle"
    | "missing_root"
    | "missing_metadata"
    | "unknown_criterion"
    | "coverage_gap"
    | "horizontal_decomposition"
    | "unsafe_policy"
    | "path_escape"
    | "size_limit";
  message: string;
  ticketId?: string;
}

export class TicketGraphValidationError extends Error {
  public readonly issues: TicketGraphValidationIssue[];

  constructor(issues: TicketGraphValidationIssue[]) {
    super(issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
    this.name = "TicketGraphValidationError";
    this.issues = issues;
  }
}
function scalar(content: string, label: string): string | undefined {
  return content.match(new RegExp(`^${label}:\\s*(.+)$`, "mi"))?.[1].trim();
}

function commaList(value: string | undefined): string[] {
  if (!value || /^(none|n\/a)$/i.test(value)) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function bulletList(content: string, heading: string): string[] {
  const match = content.match(new RegExp(`^${heading}:?\\s*$\\n([\\s\\S]*?)(?=^#{1,3}\\s|^[A-Za-z][A-Za-z ]+:|\\s*$)`, "mi"));
  if (!match) return [];
  return [...match[1].matchAll(/^\s*-\s+(.+)$/gm)].map((item) => item[1].trim());
}

function parseTicketMarkdown(content: string, filename: string): TicketDefinition {
  const heading = content.match(/^#\s+([A-Za-z0-9._-]+)\s*:\s*(.+)$/m);
  const id = scalar(content, "Ticket") ?? heading?.[1];
  const title = scalar(content, "Title") ?? heading?.[2]?.trim();
  const capability = scalar(content, "Capability");
  const testingSeam = scalar(content, "Testing seam");
  const redCommand = scalar(content, "Red command")?.trim();
  const tddPolicy = scalar(content, "TDD")?.toLowerCase();
  const kind = scalar(content, "Kind")?.toLowerCase();
  const exemptionReason = scalar(content, "TDD exemption");
  const acceptanceCriteria = bulletList(content, "(?:##\\s+)?Acceptance Criteria");
  const verificationCommands = bulletList(content, "Verify");
  const allowedChanges = bulletList(content, "Allow");
  const missing = [
    !id && "identity",
    !title && "title",
    !capability && "capability",
    acceptanceCriteria.length === 0 && "acceptance criteria",
    !testingSeam && "testing seam",
    verificationCommands.length === 0 && "verification commands",
    !["required", "exempt"].includes(tddPolicy ?? "") && "TDD policy",
    tddPolicy === "exempt" && !exemptionReason && "TDD exemption reason",
    tddPolicy === "required" && !redCommand && "red command",
    commaList(scalar(content, "Covers")).length === 0 && "requirement coverage",
    !["behavioral", "documentation", "mechanical"].includes(kind ?? "") && "ticket kind",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new TicketGraphValidationError([{
      code: "missing_metadata",
      message: `${filename} is missing ${missing.join(", ")}`,
      ticketId: id,
    }]);
  }

  try {
    const verification = normalizeVerificationCommands(verificationCommands);
    const normalizedAllowed = allowedChanges.length > 0
      ? allowedChanges.map(normalizeAllowedPath)
      : undefined;
    if (normalizedAllowed && new Set(normalizedAllowed).size !== normalizedAllowed.length) {
      throw new SpecFormatError("allowed changes contain duplicate normalized paths");
    }
    return {
      id: id!,
      title: title!,
      capability: capability!,
      kind: kind as TicketDefinition["kind"],
      acceptanceCriteria,
      blockedBy: commaList(scalar(content, "Blocked by")),
      testingSeam: testingSeam!,
      redCommand,
      verification,
      allowedChanges: normalizedAllowed,
      tdd: tddPolicy === "required"
        ? { policy: "required" }
        : { policy: "exempt", reason: exemptionReason! },
      covers: commaList(scalar(content, "Covers")),
      ...(scalar(content, "Wide refactor") === "expand-migrate-contract"
        ? { wideRefactorSequence: "expand-migrate-contract" as const }
        : {}),
    };
  } catch (error) {
    throw new TicketGraphValidationError([{
      code: "unsafe_policy",
      message: `${filename}: ${error instanceof Error ? error.message : String(error)}`,
      ticketId: id,
    }]);
  }
}

function parseFinalGate(content: string): TicketFinalGate {
  const commands = bulletList(content, "Verify");
  return {
    acceptanceCriteria: bulletList(content, "(?:##\\s+)?Acceptance Criteria"),
    covers: commaList(scalar(content, "Covers")),
    verification: commands.length > 0 ? normalizeVerificationCommands(commands) : [],
  };
}

function contentHash(value: Omit<TicketGraph, "contentHash">): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateTicketGraph(input: {
  requirement: Pick<RequirementSnapshot, "artifactPath" | "sha256">;
  requirementCriteria: string[];
  tickets: TicketDefinition[];
  finalGate?: TicketFinalGate;
}): TicketGraph {
  const issues: TicketGraphValidationIssue[] = [];
  if (input.tickets.length === 0) {
    issues.push({ code: "missing_root", message: "ticket graph has no tickets" });
  }
  if (input.tickets.length > MAX_TICKETS) {
    issues.push({ code: "size_limit", message: `ticket count exceeds ${MAX_TICKETS}` });
  }
  for (const ticket of input.tickets) {
    if (
      !ticket.id.trim()
      || !ticket.title.trim()
      || !ticket.capability.trim()
      || !["behavioral", "documentation", "mechanical"].includes(ticket.kind)
      || (ticket.tdd.policy === "exempt" && ticket.kind === "behavioral")
      || (ticket.tdd.policy === "required" && !ticket.redCommand?.trim())
      || ticket.acceptanceCriteria.length === 0
      || ticket.acceptanceCriteria.some((criterion) => !criterion.trim())
      || !ticket.testingSeam.trim()
      || ticket.verification.length === 0
      || ticket.covers.length === 0
      || (ticket.tdd.policy === "exempt" && !ticket.tdd.reason.trim())
    ) {
      issues.push({
        code: "missing_metadata",
        message: `${ticket.id || "unknown"} is missing required ticket metadata`,
        ticketId: ticket.id,
      });
    }
    try {
      const commands = normalizeVerificationCommands(
        ticket.verification.map((requirement) => requirement.command)
      );
      if (commands.some((requirement, index) => requirement.command !== ticket.verification[index]?.command)) {
        throw new SpecFormatError("verification commands are not normalized");
      }
      if (ticket.allowedChanges) {
        const normalized = ticket.allowedChanges.map(normalizeAllowedPath);
        if (
          new Set(normalized).size !== normalized.length
          || normalized.some((allowedPath, index) => allowedPath !== ticket.allowedChanges?.[index])
        ) {
          throw new SpecFormatError("allowed paths are duplicate or not normalized");
        }
      }
    } catch (error) {
      issues.push({
        code: "unsafe_policy",
        message: `${ticket.id}: ${error instanceof Error ? error.message : String(error)}`,
        ticketId: ticket.id,
      });
    }
  }

  const byId = new Map<string, TicketDefinition>();
  for (const ticket of input.tickets) {
    if (byId.has(ticket.id)) {
      issues.push({ code: "duplicate_id", message: `duplicate ticket id ${ticket.id}`, ticketId: ticket.id });
    } else {
      byId.set(ticket.id, ticket);
    }
  }
  for (const ticket of input.tickets) {
    for (const blocker of ticket.blockedBy) {
      if (!byId.has(blocker)) {
        issues.push({ code: "unknown_blocker", message: `${ticket.id} references ${blocker}`, ticketId: ticket.id });
      }
    }
  }
  if (input.tickets.length > 0 && input.tickets.every((ticket) => ticket.blockedBy.length > 0)) {
    issues.push({ code: "missing_root", message: "ticket graph has no initially ready root" });
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issues.push({ code: "cycle", message: `cycle includes ${id}`, ticketId: id });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const blocker of byId.get(id)?.blockedBy ?? []) {
      if (byId.has(blocker)) visit(blocker);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const ticket of input.tickets) visit(ticket.id);

  const knownCriteria = new Set(input.requirementCriteria);
  const finalGate = input.finalGate ?? { acceptanceCriteria: [], covers: [], verification: [] };
  const coverage: Record<string, string[]> = Object.fromEntries(
    input.requirementCriteria.map((criterion) => [criterion, []])
  );
  for (const ticket of input.tickets) {
    for (const criterion of ticket.covers) {
      if (!knownCriteria.has(criterion)) {
        issues.push({ code: "unknown_criterion", message: `${ticket.id} covers unknown ${criterion}`, ticketId: ticket.id });
      } else {
        coverage[criterion].push(ticket.id);
      }
    }
  }
  for (const criterion of finalGate.covers) {
    if (!knownCriteria.has(criterion)) {
      issues.push({ code: "unknown_criterion", message: `final gate covers unknown ${criterion}` });
    } else {
      coverage[criterion].push("final");
    }
  }
  for (const [criterion, owners] of Object.entries(coverage)) {
    if (owners.length === 0) {
      issues.push({ code: "coverage_gap", message: `${criterion} is not mapped` });
    }
  }

  const horizontal = /^(types?|schemas?|storage|database|tests?|documentation|api)\b/i;
  if (
    input.tickets.length > 1
    && input.tickets.every((ticket) => horizontal.test(ticket.capability))
    && input.tickets.some((ticket) => ticket.wideRefactorSequence !== "expand-migrate-contract")
  ) {
    issues.push({
      code: "horizontal_decomposition",
      message: "horizontal-only tickets require an expand-migrate-contract declaration",
    });
  }

  if (issues.length > 0) throw new TicketGraphValidationError(issues);
  const withoutHash = {
    version: 1 as const,
    requirement: input.requirement,
    tickets: input.tickets,
    coverage,
    finalGate,
  };
  return { ...withoutHash, contentHash: contentHash(withoutHash) };
}

export async function importTicketGraph(input: {
  ticketDir: string;
  requirement: Pick<RequirementSnapshot, "artifactPath" | "sha256">;
  requirementCriteria: string[];
}): Promise<TicketGraph> {
  const selectedDir = path.resolve(input.ticketDir);
  let entries;
  try {
    entries = await fs.readdir(selectedDir, { withFileTypes: true });
  } catch (error) {
    throw new TicketGraphValidationError([{
      code: "path_escape",
      message: `cannot read selected ticket directory: ${error instanceof Error ? error.message : String(error)}`,
    }]);
  }
  const markdown = entries
    .filter((entry) => entry.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (markdown.length > MAX_TICKETS + 1) {
    throw new TicketGraphValidationError([{
      code: "size_limit",
      message: `ticket directory exceeds ${MAX_TICKETS} tickets`,
    }]);
  }

  const tickets: TicketDefinition[] = [];
  let finalGate: TicketFinalGate | undefined;
  let aggregateCharacters = 0;
  for (const entry of markdown) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new TicketGraphValidationError([{
        code: "path_escape",
        message: `${entry.name} is not a regular file within the selected directory`,
      }]);
    }
    const filePath = path.join(selectedDir, entry.name);
    const realPath = await fs.realpath(filePath);
    if (!realPath.startsWith(`${selectedDir}${path.sep}`)) {
      throw new TicketGraphValidationError([{
        code: "path_escape",
        message: `${entry.name} escapes the selected directory`,
      }]);
    }
    const content = await fs.readFile(realPath, "utf-8");
    aggregateCharacters += content.length;
    if (content.length > MAX_TICKET_CHARACTERS || aggregateCharacters > MAX_GRAPH_CHARACTERS) {
      throw new TicketGraphValidationError([{
        code: "size_limit",
        message: `${entry.name} or aggregate graph exceeds the configured size limit`,
      }]);
    }
    if (FINAL_FILENAMES.has(entry.name)) {
      finalGate = parseFinalGate(content);
    } else {
      tickets.push(parseTicketMarkdown(content, entry.name));
    }
  }
  return validateTicketGraph({
    requirement: input.requirement,
    requirementCriteria: input.requirementCriteria,
    tickets,
    finalGate,
  });
}

export async function freezeTicketGraph(
  baseDir: string,
  runId: string,
  graph: TicketGraph
): Promise<TicketPlanSnapshot> {
  const artifactPath = "ticket-plan.json";
  const serialized = JSON.stringify(graph, null, 2);
  await saveArtifact(baseDir, runId, artifactPath, serialized);
  return {
    artifactPath,
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
    ticketCount: graph.tickets.length,
    characters: serialized.length,
  };
}

export async function loadFrozenTicketGraph(
  baseDir: string,
  run: WorkflowRun
): Promise<TicketGraph> {
  if (!run.ticketPlan || !run.requirement) {
    throw new TicketGraphValidationError([{
      code: "missing_metadata",
      message: "ticketed run is missing immutable graph metadata",
    }]);
  }
  let serialized: string;
  try {
    serialized = await fs.readFile(
      resolveRunArtifactPath(baseDir, run.id, run.ticketPlan.artifactPath),
      "utf-8"
    );
  } catch (error) {
    throw new TicketGraphValidationError([{
      code: "path_escape",
      message: `cannot read immutable ticket plan: ${error instanceof Error ? error.message : String(error)}`,
    }]);
  }
  const actualHash = crypto.createHash("sha256").update(serialized).digest("hex");
  if (actualHash !== run.ticketPlan.sha256) {
    throw new TicketGraphValidationError([{
      code: "path_escape",
      message: "immutable ticket plan hash mismatch",
    }]);
  }
  let parsed: TicketGraph;
  try {
    parsed = JSON.parse(serialized) as TicketGraph;
  } catch {
    throw new TicketGraphValidationError([{
      code: "missing_metadata",
      message: "immutable ticket plan is malformed JSON",
    }]);
  }
  const validated = validateTicketGraph({
    requirement: parsed.requirement,
    requirementCriteria: Object.keys(parsed.coverage ?? {}),
    tickets: parsed.tickets ?? [],
    finalGate: parsed.finalGate,
  });
  if (
    validated.contentHash !== parsed.contentHash
    || parsed.requirement.sha256 !== run.requirement.sha256
  ) {
    throw new TicketGraphValidationError([{
      code: "path_escape",
      message: "ticket graph content identity does not match its requirement",
    }]);
  }
  return parsed;
}

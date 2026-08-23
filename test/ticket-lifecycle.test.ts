import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { TicketDefinition, TicketGraph, TicketRuntimeState } from "../src/contracts/tickets.ts";
import { selectTicketFrontier } from "../src/tickets/lifecycle.ts";

function definition(id: string, blockedBy: string[] = []): TicketDefinition {
  return {
    id,
    title: id,
    capability: `Users receive ${id}`,
    kind: "documentation",
    acceptanceCriteria: [`${id} works`],
    blockedBy,
    testingSeam: `Observe ${id}`,
    verification: [{ command: `verify-${id}`, required: true }],
    tdd: { policy: "exempt", reason: "Documentation-only" },
    covers: [`AC-${id}`],
  };
}

function state(id: string, phase: TicketRuntimeState["phase"] = "pending"): TicketRuntimeState {
  return { id, title: id, blockedBy: [], phase, reviewRound: 0, fixRound: 0 };
}

describe("Ticket frontier selection", () => {
  const tickets = [definition("A"), definition("B"), definition("C", ["A", "B"])];
  const graph: TicketGraph = {
    version: 1,
    requirement: { artifactPath: "requirement.md", sha256: "hash" },
    tickets,
    coverage: { "AC-A": ["A"], "AC-B": ["B"], "AC-C": ["C"] },
    finalGate: { acceptanceCriteria: [], covers: [], verification: [] },
    contentHash: "hash",
  };

  it("returns graph-ordered roots and waits for every blocker", () => {
    const states = [state("A"), state("B"), { ...state("C"), blockedBy: ["A", "B"] }];
    assert.deepEqual(selectTicketFrontier(graph, states).map((ticket) => ticket.id), ["A", "B"]);
    states[0].phase = "ticket_completed";
    assert.deepEqual(selectTicketFrontier(graph, states).map((ticket) => ticket.id), ["B"]);
    states[1].phase = "ticket_completed";
    assert.deepEqual(selectTicketFrontier(graph, states).map((ticket) => ticket.id), ["C"]);
  });

  it("never unlocks dependents from failed tickets", () => {
    const states = [
      state("A", "ticket_failed"),
      state("B", "ticket_completed"),
      { ...state("C"), blockedBy: ["A", "B"] },
    ];
    assert.deepEqual(selectTicketFrontier(graph, states), []);
  });
});

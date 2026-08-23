import type {
  TicketDefinition,
  TicketGraph,
  TicketLifecyclePhase,
  TicketRuntimeState,
} from "../contracts/tickets.ts";

const ALLOWED_TICKET_TRANSITIONS: Record<TicketLifecyclePhase, TicketLifecyclePhase[]> = {
  pending: ["red_authoring", "implementing", "ticket_failed"],
  red_authoring: ["red_verification", "ticket_failed"],
  red_verification: ["implementing", "ticket_failed"],
  implementing: ["green_verification", "ticket_failed"],
  green_verification: ["ticket_review", "ticket_fix", "ticket_failed"],
  ticket_review: ["ticket_completed", "ticket_fix", "ticket_failed"],
  ticket_fix: ["green_verification", "ticket_failed"],
  ticket_completed: [],
  ticket_failed: [],
};

export function transitionTicket(
  ticket: TicketRuntimeState,
  phase: TicketLifecyclePhase
): TicketRuntimeState {
  if (!ALLOWED_TICKET_TRANSITIONS[ticket.phase].includes(phase)) {
    throw new Error(`Invalid ticket transition ${ticket.id}: ${ticket.phase} -> ${phase}`);
  }
  return { ...ticket, phase };
}

export function selectTicketFrontier(
  graph: TicketGraph,
  states: TicketRuntimeState[]
): TicketDefinition[] {
  const stateById = new Map(states.map((state) => [state.id, state]));
  const completed = new Set(
    states.filter((state) => state.phase === "ticket_completed").map((state) => state.id)
  );
  return graph.tickets.filter((ticket) => {
    const state = stateById.get(ticket.id);
    return state?.phase === "pending" && ticket.blockedBy.every((blocker) => completed.has(blocker));
  });
}

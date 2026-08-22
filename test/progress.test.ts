import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  registerHooks,
  type ResolveFnOutput,
  type ResolveHookContext,
} from "node:module";

// pi-subagents ships raw .ts sources under node_modules and Node refuses to
// strip types there (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so this
// suite cannot load the real "pi-subagents/delegation" module. The adapter
// only needs the four event-name constants at runtime, so resolve the
// specifier to an equivalent stub. A drift in the real constants would make
// the adapter ignore every emitted event and fail the assertions below.
// These must match the constants in pi-subagents/delegation.ts.
const SUBAGENT_DELEGATION_STUB = [
  'export const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";',
  'export const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";',
  'export const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";',
  'export const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";',
].join("\n");

registerHooks({
  resolve(
    specifier: string,
    context: ResolveHookContext,
    nextResolve: (specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput
  ): ResolveFnOutput {
    if (specifier === "pi-subagents/delegation") {
      return {
        url: `data:text/javascript,${encodeURIComponent(SUBAGENT_DELEGATION_STUB)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

const { PiSubagentsExecutor } = await import("../src/agents/pi-subagents-executor.ts");
import type { AgentExecutionRequest, AgentProgressUpdate } from "../src/agents/executor.ts";
import { WorkflowEngine } from "../src/engine/engine.ts";
import type { WorkflowProgressEvent } from "../src/engine/engine.ts";
import { RetryPolicy } from "../src/policies/retry.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";

// Minimal in-memory stand-in for the Pi event bus used by the delegation
// adapter. Records every emit and exposes handler counts so tests can assert
// that listeners are unsubscribed.
class FakeEventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  public emitted: Array<{ event: string; payload: unknown }> = [];
  private failRequestEmit: boolean;

  constructor(opts: { failRequestEmit?: boolean } = {}) {
    this.failRequestEmit = opts.failRequestEmit ?? false;
  }

  on(event: string, handler: (payload: unknown) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  emit(event: string, payload: unknown): void {
    if (this.failRequestEmit && event === SUBAGENT_DELEGATION_REQUEST_EVENT) {
      throw new Error("event bus rejected the delegation request");
    }
    this.emitted.push({ event, payload });
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of [...set]) handler(payload);
    }
  }

  handlerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

function baseDelegationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req-1",
    ownerRunId: "run-1",
    nodeId: "scout",
    ...overrides,
  };
}

/**
 * Payload correlated with the delegation the executor actually emitted: the
 * adapter generates its requestId with crypto.randomUUID(), so events must
 * carry that id (from the SUBAGENT_DELEGATION_REQUEST event) to be accepted.
 */
function correlatedPayload(bus: FakeEventBus, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { requestId } = bus.emitted[0].payload as { requestId: string };
  return baseDelegationPayload({ requestId, ...overrides });
}

function baseAgentRequest(overrides: Partial<AgentExecutionRequest> = {}): AgentExecutionRequest {
  return {
    workflowRunId: "run-1",
    nodeId: "scout",
    agent: "scout",
    task: "Do the thing",
    context: "fresh",
    cwd: "/work",
    schema: { type: "object", properties: {} },
    ...overrides,
  };
}

describe("PiSubagentsExecutor delegation update forwarding", () => {
  it("forwards only updates matching the active delegation and maps update metadata", async () => {
    const bus = new FakeEventBus();
    const executor = new PiSubagentsExecutor({ events: bus } as any);
    const received: AgentProgressUpdate[] = [];

    const pending = executor.execute<{ done: boolean }>(
      baseAgentRequest({ onUpdate: (u) => received.push(u) })
    );

    // Non-matching updates are dropped: different requestId, run, or node.
    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, baseDelegationPayload({ requestId: "req-other" }));
    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, correlatedPayload(bus, { ownerRunId: "run-other" }));
    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, correlatedPayload(bus, { nodeId: "plan" }));
    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, { nodeId: "scout" }); // malformed
    assert.equal(received.length, 0);

    bus.emit(
      SUBAGENT_DELEGATION_UPDATE_EVENT,
      correlatedPayload(bus, {
        runId: "sub-77",
        currentTool: "read",
        currentToolArgs: "package.json",
        recentOutput: "line 1",
        recentOutputLines: ["line 1"],
        recentTools: [{ tool: "read", args: "package.json" }],
        model: "claude-x",
        toolCount: 3,
        durationMs: 1234,
        tokens: 456,
      })
    );

    bus.emit(
      SUBAGENT_DELEGATION_RESPONSE_EVENT,
      correlatedPayload(bus, { status: "completed", result: { kind: "structured", value: { done: true } } })
    );

    const result = await pending;
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, { done: true });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
      runId: "sub-77",
      nodeId: "scout",
      agent: "scout",
      currentTool: "read",
      currentToolArgs: "package.json",
      recentOutput: "line 1",
      recentOutputLines: ["line 1"],
      recentTools: [{ tool: "read", args: "package.json" }],
      model: "claude-x",
      toolCount: 3,
      durationMs: 1234,
      tokens: 456,
    });
  });

  it("stops forwarding updates after the response settles and unsubscribes listeners", async () => {
    const bus = new FakeEventBus();
    const executor = new PiSubagentsExecutor({ events: bus } as any);
    const received: AgentProgressUpdate[] = [];

    const pending = executor.execute<unknown>(baseAgentRequest({ onUpdate: (u) => received.push(u) }));

    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, correlatedPayload(bus, { currentTool: "bash" }));
    assert.equal(received.length, 1);

    bus.emit(
      SUBAGENT_DELEGATION_RESPONSE_EVENT,
      correlatedPayload(bus, { status: "completed", result: { kind: "text", text: "{}" } })
    );
    const result = await pending;
    assert.equal(result.status, "completed");

    // Both listeners are gone; late updates can no longer reach the callback.
    assert.equal(bus.handlerCount(SUBAGENT_DELEGATION_UPDATE_EVENT), 0);
    assert.equal(bus.handlerCount(SUBAGENT_DELEGATION_RESPONSE_EVENT), 0);

    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, correlatedPayload(bus, { currentTool: "bash" }));
    assert.equal(received.length, 1);
  });

  it("cancels the delegation and cleans up listeners on timeout", async () => {
    const bus = new FakeEventBus();
    const executor = new PiSubagentsExecutor({ events: bus } as any);
    const received: AgentProgressUpdate[] = [];

    const pending = executor.execute<unknown>(baseAgentRequest({ timeoutMs: 20, onUpdate: (u) => received.push(u) }));

    const [requestEvent] = bus.emitted;
    assert.equal(requestEvent.event, SUBAGENT_DELEGATION_REQUEST_EVENT);
    const requestId = (requestEvent.payload as { requestId: string }).requestId;

    const result = await pending;
    assert.equal(result.status, "timed_out");
    assert.match(result.error ?? "", /timed out/);

    const cancel = bus.emitted.find((e) => e.event === SUBAGENT_DELEGATION_CANCEL_EVENT);
    assert.ok(cancel, "cancel event was emitted");
    assert.deepEqual(
      cancel.payload,
      baseDelegationPayload({ requestId })
    );
    assert.equal(bus.handlerCount(SUBAGENT_DELEGATION_UPDATE_EVENT), 0);
    assert.equal(bus.handlerCount(SUBAGENT_DELEGATION_RESPONSE_EVENT), 0);

    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, baseDelegationPayload({ requestId, currentTool: "bash" }));
    assert.equal(received.length, 0);
  });

  it("resolves cancelled when the delegation response reports cancellation and cleans up", async () => {
    const bus = new FakeEventBus();
    const executor = new PiSubagentsExecutor({ events: bus } as any);
    const received: AgentProgressUpdate[] = [];

    const pending = executor.execute<unknown>(baseAgentRequest({ onUpdate: (u) => received.push(u) }));

    bus.emit(
      SUBAGENT_DELEGATION_RESPONSE_EVENT,
      correlatedPayload(bus, { status: "cancelled", error: "user abort" })
    );

    const result = await pending;
    assert.equal(result.status, "cancelled");
    assert.equal(result.error, "user abort");
    assert.equal(bus.handlerCount(SUBAGENT_DELEGATION_UPDATE_EVENT), 0);

    bus.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, correlatedPayload(bus, { currentTool: "bash" }));
    assert.equal(received.length, 0);
  });

  it("rejects and removes both listeners when the request emit throws", async () => {
    const bus = new FakeEventBus({ failRequestEmit: true });
    const executor = new PiSubagentsExecutor({ events: bus } as any);

    // A configured timeout must also be cleared: without it, the pending
    // timer would keep the process alive long after the rejection.
    const pending = executor.execute<unknown>(baseAgentRequest({ timeoutMs: 5000 }));

    await assert.rejects(pending, /event bus rejected the delegation request/);
    assert.equal(bus.handlerCount(SUBAGENT_DELEGATION_UPDATE_EVENT), 0);
    assert.equal(bus.handlerCount(SUBAGENT_DELEGATION_RESPONSE_EVENT), 0);
  });
});

describe("WorkflowEngine progress lifecycle", () => {
  let workDir: string;

  // Scratch dir under the project (not /tmp, per project policy).
  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(process.cwd(), "pi-wf-progress-test-"));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  /** Wrap a FakeAgentExecutor so every node emits one progress update mid-run. */
  function wrappingExecutor(fake: FakeAgentExecutor): FakeAgentExecutor {
    const original = fake.execute.bind(fake);
    fake.execute = async <T>(request: AgentExecutionRequest<T>) => {
      request.onUpdate?.({
        nodeId: request.nodeId,
        agent: request.agent,
        currentTool: "read",
        currentToolArgs: "package.json",
        recentOutput: "stream line",
        durationMs: 500,
        tokens: 1200,
      });
      return original(request);
    };
    return fake;
  }

  it("emits node_start, node_update, and node_end in order with timing and token metadata", async () => {
    const fake = wrappingExecutor(new FakeAgentExecutor());
    const events: WorkflowProgressEvent[] = [];
    const engine = new WorkflowEngine({
      cwd: workDir,
      executor: fake,
      sleep: async () => {},
      onProgress: (e) => events.push(e),
    });

    // quick mode skips the scout node, so only the plan node runs.
    const run = await engine.startPlan("Add a helper function", { mode: "quick" });
    assert.equal(run.state, "plan_ready");

    assert.deepEqual(
      events.map((e) => `${e.type}:${e.nodeId}`),
      ["node_start:plan", "node_update:plan", "node_end:plan"]
    );

    const [start, update, end] = events;
    assert.equal(start.agent, "planner");
    assert.match(start.action ?? "", /Formulating implementation plan/);
    assert.equal(start.run.id, run.id);

    assert.equal(update.details?.currentTool, "read");
    assert.equal(update.details?.currentToolArgs, "package.json");
    assert.equal(update.details?.recentOutput, "stream line");
    assert.equal(update.durationMs, 500);
    assert.equal(update.tokens, 1200);

    // Terminal event reports the run total: usage (200 + 100) overrides the
    // streaming token estimate from the update.
    assert.match(end.action ?? "", /Plan approved/);
    assert.equal(end.tokens, 300);
    assert.equal(typeof end.durationMs, "number");
    assert.ok((end.durationMs as number) >= 0);
  });

  it("gives every completed node exactly one terminal event and carries review verdict details", async () => {
    const fake = wrappingExecutor(
      new FakeAgentExecutor({
        review: [
          {
            verdict: "REQUEST_CHANGES",
            summary: "Missing null guard",
            findings: [
              {
                id: "finding-1",
                severity: "major",
                category: "correctness",
                description: "Missing null guard on input",
                evidence: "line 15",
                file: "src/main.ts",
              },
            ],
            testAssessment: { sufficient: true, explanation: "" },
            confidence: 0.9,
          },
          {
            verdict: "PASS",
            summary: "Guard added and covered by tests",
            findings: [],
            testAssessment: { sufficient: true, explanation: "" },
            confidence: 0.95,
          },
        ],
      })
    );
    const events: WorkflowProgressEvent[] = [];
    const engine = new WorkflowEngine({
      cwd: workDir,
      executor: fake,
      sleep: async () => {},
      onProgress: (e) => events.push(e),
    });

    const run = await engine.startAuto("Add user validation", { mode: "normal" });
    assert.equal(run.state, "completed");
    assert.equal(run.reviewRound, 2);

    const starts = events.filter((e) => e.type === "node_start");
    const ends = events.filter((e) => e.type === "node_end");
    // Explicit-mode auto run: scout before planning (§26), then implement,
    // review round 1, the fix, and review round 2.
    assert.deepEqual(
      starts.map((e) => e.nodeId),
      ["scout", "plan", "implement", "review-1", "fix-1", "review-2"]
    );
    // Exactly one terminal event per started node, in the same order.
    assert.deepEqual(ends.map((e) => e.nodeId), starts.map((e) => e.nodeId));
    for (const nodeId of starts.map((e) => e.nodeId)) {
      assert.equal(
        ends.filter((e) => e.nodeId === nodeId).length,
        1,
        `node ${nodeId} must end exactly once`
      );
    }

    const implementEnd = ends.find((e) => e.nodeId === "implement")!;
    assert.equal(implementEnd.agent, "worker");
    assert.deepEqual(implementEnd.details?.changedFiles, ["src/main.ts"]);
    assert.equal(implementEnd.details?.passedTests, 1);
    assert.equal(implementEnd.details?.totalTests, 1);

    const review1End = ends.find((e) => e.nodeId === "review-1")!;
    assert.equal(review1End.details?.verdict, "REQUEST_CHANGES");
    assert.equal(review1End.details?.findings, 1);
    assert.match(review1End.action ?? "", /REQUEST_CHANGES/);
    const findingList = review1End.details?.findingList as Array<Record<string, unknown>>;
    assert.equal(findingList.length, 1);
    assert.equal(findingList[0].description, "Missing null guard on input");
    assert.equal(findingList[0].file, "src/main.ts");

    const review2End = ends.find((e) => e.nodeId === "review-2")!;
    assert.equal(review2End.details?.verdict, "PASS");
    assert.equal(review2End.details?.findings, 0);
    assert.match(review2End.action ?? "", /Verdict: PASS/);

    const fixEnd = ends.find((e) => e.nodeId === "fix-1")!;
    assert.equal(fixEnd.agent, "worker");
    assert.deepEqual(fixEnd.details?.changedFiles, ["src/main.ts"]);
    assert.ok((fixEnd.details?.addressedFindings as string[]).includes("finding-1"));

    // Live updates must be forwarded for every started node, with the tool
    // metadata the wrapper emitted — not only the plan node.
    const updates = events.filter((e) => e.type === "node_update");
    assert.deepEqual(
      updates.map((e) => e.nodeId),
      ["scout", "plan", "implement", "review-1", "fix-1", "review-2"]
    );
    for (const update of updates) {
      assert.equal(update.details?.currentTool, "read");
      assert.equal(update.details?.currentToolArgs, "package.json");
      assert.equal(update.details?.recentOutput, "stream line");
      assert.equal(update.durationMs, 500);
      assert.equal(update.tokens, 1200);
    }
  });

  it("carries the fix worker's test outcome in the terminal fix event", async () => {
    const fake = wrappingExecutor(
      new FakeAgentExecutor({
        review: [
          {
            verdict: "REQUEST_CHANGES",
            summary: "Missing null guard",
            findings: [
              {
                id: "finding-1",
                severity: "major",
                category: "correctness",
                description: "Missing null guard on input",
                evidence: "line 15",
                file: "src/main.ts",
              },
            ],
            testAssessment: { sufficient: true, explanation: "" },
            confidence: 0.9,
          },
          {
            verdict: "PASS",
            summary: "Guard added and covered by tests",
            findings: [],
            testAssessment: { sufficient: true, explanation: "" },
            confidence: 0.95,
          },
        ],
        fix: [
          {
            summary: "Addressed the finding",
            addressedFindings: ["finding-1"],
            unaddressedFindings: [],
            changedFiles: [{ path: "src/main.ts", change: "Added guard" }],
            tests: [
              { command: "npm test", status: "passed", summary: "1 test passed" },
              { command: "npm run test:unit", status: "failed", summary: "2 tests failed" },
            ],
          },
        ],
      })
    );
    const events: WorkflowProgressEvent[] = [];
    const engine = new WorkflowEngine({
      cwd: workDir,
      executor: fake,
      sleep: async () => {},
      onProgress: (e) => events.push(e),
    });

    const run = await engine.startAuto("Add user validation", { mode: "normal" });
    // A fix whose tests still fail must not complete: the completion gate
    // routes it back to fixing until the review budget is exhausted.
    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "required_tests_failed");

    const fixEnd = events.find((e) => e.type === "node_end" && e.nodeId === "fix-1")!;
    assert.match(fixEnd.action ?? "", /1\/2 tests passed/);
    assert.equal(fixEnd.details?.passedTests, 1);
    assert.equal(fixEnd.details?.failedTests, 1);
    assert.equal(fixEnd.details?.totalTests, 2);
  });

  it("emits exactly one terminal event across a retry and covers the full node duration", async () => {
    const calls: string[] = [];
    const fake = new FakeAgentExecutor();
    fake.setHandler("scout", (req) => {
      calls.push(req.nodeId);
      if (calls.length === 1) {
        return { status: "failed" as const, error: "transient tool failure" };
      }
      return {
        status: "completed" as const,
        result: {
          summary: "Scouted after retry",
          relevantFiles: [{ path: "src/main.ts", relevance: "Entry point" }],
          contextHints: ["TypeScript project"],
        },
      };
    });

    const events: WorkflowProgressEvent[] = [];
    const engine = new WorkflowEngine({
      cwd: workDir,
      executor: fake,
      sleep: async () => {}, // skip real backoff between attempts
      onProgress: (e) => events.push(e),
    });

    const run = await engine.startPlan("Add a helper function", { mode: "normal" });
    assert.equal(run.state, "plan_ready");
    assert.equal(calls.length, 2, "scout ran twice (one retry)");

    const scoutEnds = events.filter((e) => e.type === "node_end" && e.nodeId === "scout");
    assert.equal(scoutEnds.length, 1, "retried node must end exactly once");
    assert.equal(typeof scoutEnds[0].durationMs, "number");
    assert.deepEqual(
      events
        .filter((e) => e.nodeId === "scout")
        .map((e) => e.type),
      ["node_start", "node_end"],
      "scout emits start then exactly one terminal event"
    );
    // The plan node still completed and ended exactly once as well.
    assert.equal(
      events.filter((e) => e.type === "node_end" && e.nodeId === "plan").length,
      1
    );
  });

  it("emits no terminal event for a failed node and marks the run failed", async () => {
    const fake = new FakeAgentExecutor();
    fake.setHandler("scout", () => ({
      status: "failed" as const,
      error: "scout exploded",
    }));

    const events: WorkflowProgressEvent[] = [];
    const engine = new WorkflowEngine({
      cwd: workDir,
      executor: fake,
      sleep: async () => {},
      retryPolicy: new RetryPolicy({ maxAgentRetries: 0 }),
      onProgress: (e) => events.push(e),
    });

    const run = await engine.startPlan("Broken task", { mode: "normal" });
    assert.equal(run.state, "failed");
    assert.equal(run.error?.code, "agent_execution_failed");

    assert.deepEqual(
      events.map((e) => `${e.type}:${e.nodeId}`),
      ["node_start:scout"],
      "a failed node must not emit node_end"
    );
    assert.equal(events.some((e) => e.nodeId === "plan"), false, "plan must not start after scout failure");
  });
});

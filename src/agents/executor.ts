import { assertReviewerFreshness } from "../policies/context.ts";

export interface AgentExecutionUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  durationMs?: number;
  turns?: number;
  toolCalls?: number;
}

export interface AgentProgressUpdate {
  runId?: string;
  nodeId: string;
  agent: string;
  currentTool?: string;
  currentToolArgs?: string;
  recentOutput?: string;
  recentOutputLines?: string[];
  recentTools?: Array<{ tool: string; args: string }>;
  model?: string;
  toolCount?: number;
  durationMs?: number;
  tokens?: number;
}

export interface AgentExecutionRequest<T = unknown> {
  workflowRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  context: "fresh" | "fork";
  cwd: string;
  schema: Record<string, unknown>;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  model?: string;
  onUpdate?: (update: AgentProgressUpdate) => void;
}

export interface AgentExecutionResult<T = unknown> {
  status: "completed" | "failed" | "cancelled" | "timed_out";
  result?: T;
  error?: string;
  usage?: AgentExecutionUsage;
  model?: string;
  thinking?: string;
}

export interface AgentExecutor {
  execute<T>(request: AgentExecutionRequest<T>): Promise<AgentExecutionResult<T>>;
}

/**
 * §34 Strict Reviewer Separation helper:
 * Explicitly constructs a reviewer execution request and hardcodes context: "fresh".
 */
export function createReviewerExecutionRequest<T>(params: {
  workflowRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  cwd: string;
  schema: Record<string, unknown>;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs?: number;
  model?: string;
  onUpdate?: (update: AgentProgressUpdate) => void;
}): AgentExecutionRequest<T> {
  const req: AgentExecutionRequest<T> = {
    workflowRunId: params.workflowRunId,
    nodeId: params.nodeId,
    agent: params.agent,
    task: params.task,
    context: "fresh", // HARDCODED FRESH CONTEXT - Non-negotiable invariant (§3, §8, §34)
    cwd: params.cwd,
    schema: params.schema,
    thinking: params.thinking,
    timeoutMs: params.timeoutMs,
    model: params.model,
    onUpdate: params.onUpdate,
  };

  assertReviewerFreshness({ role: "reviewer", context: req.context });
  return req;
}

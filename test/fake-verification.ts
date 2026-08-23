import type {
  VerificationExecution,
} from "../src/contracts/requirement.ts";
import type {
  VerificationCommandRunner,
} from "../src/engine/verification.ts";

export class FakeVerificationRunner implements VerificationCommandRunner {
  readonly calls: Array<{ command: string; cwd: string }> = [];
  private readonly statuses: Array<"passed" | "failed">;
  private index = 0;

  constructor(statuses: Array<"passed" | "failed"> = ["passed"]) {
    this.statuses = statuses;
  }

  async run(input: {
    command: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<VerificationExecution> {
    this.calls.push({ command: input.command, cwd: input.cwd });
    const status = this.statuses[Math.min(this.index, this.statuses.length - 1)];
    this.index++;
    const now = new Date().toISOString();
    return {
      command: input.command,
      status,
      exitCode: status === "passed" ? 0 : 1,
      stdout: status === "passed" ? "ok" : "",
      stderr: status === "failed" ? "command failed" : "",
      startedAt: now,
      completedAt: now,
    };
  }
}

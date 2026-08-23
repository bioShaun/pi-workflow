import { spawn } from "node:child_process";
import type { VerificationExecution } from "../contracts/requirement.ts";

export interface VerificationCommandRunner {
  run(input: {
    command: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<VerificationExecution>;
}

const MAX_CAPTURED_CHARACTERS = 8_192;

function appendBounded(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString("utf-8");
  return combined.length <= MAX_CAPTURED_CHARACTERS
    ? combined
    : combined.slice(-MAX_CAPTURED_CHARACTERS);
}

/** The sole production adapter: one declared command string, one configured shell. */
export class ShellVerificationCommandRunner implements VerificationCommandRunner {
  run(input: {
    command: string;
    cwd: string;
    signal?: AbortSignal;
  }): Promise<VerificationExecution> {
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const child = spawn(input.command, {
        cwd: input.cwd,
        shell: true,
        signal: input.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        const exitCode = code ?? -1;
        resolve({
          command: input.command,
          status: exitCode === 0 ? "passed" : "failed",
          exitCode,
          stdout,
          stderr,
          startedAt,
          completedAt: new Date().toISOString(),
        });
      });
    });
  }
}

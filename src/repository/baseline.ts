import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepositoryBaseline } from "../contracts/workflow.ts";

const execFileAsync = promisify(execFile);

export async function captureRepositoryBaseline(cwd: string): Promise<RepositoryBaseline> {
  const startedAt = new Date().toISOString();

  let head: string | undefined;
  let branch: string | undefined;
  const status: string[] = [];
  let dirty = false;

  try {
    const { stdout: headOut } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
    });
    head = headOut.trim();
  } catch {
    // Non-git or empty repo
  }

  try {
    const { stdout: branchOut } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf-8",
    });
    branch = branchOut.trim() || undefined;
  } catch {
    // Non-git repo
  }

  try {
    const { stdout: statusOut } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf-8",
    });
    const lines = statusOut
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);

    status.push(...lines);
    dirty = lines.length > 0;
  } catch {
    // Non-git repo
  }

  return {
    head,
    branch,
    dirty,
    status,
    startedAt,
  };
}

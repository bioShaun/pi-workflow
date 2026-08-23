import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  BaselineFileEntry,
  RepositoryBaseline,
} from "../contracts/workflow.ts";

const execFileAsync = promisify(execFile);

export async function captureWorkingTreeFiles(cwd: string): Promise<BaselineFileEntry[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }
  );
  const paths = stdout
    .toString("utf-8")
    .split("\0")
    .filter((filePath) => filePath.length > 0)
    .sort();
  const files: BaselineFileEntry[] = [];
  for (const filePath of paths) {
    try {
      const absolutePath = path.join(cwd, filePath);
      const stat = await fs.lstat(absolutePath);
      const content = stat.isSymbolicLink()
        ? Buffer.from(await fs.readlink(absolutePath), "utf-8")
        : await fs.readFile(absolutePath);
      files.push({
        path: filePath,
        hash: crypto.createHash("sha256").update(content).digest("hex"),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files.push({ path: filePath, hash: null });
    }
  }
  return files;
}

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

  let files: BaselineFileEntry[] | undefined;
  try {
    files = await captureWorkingTreeFiles(cwd);
  } catch {
    // Scope-restricted workflows fail closed when this evidence is absent.
  }

  return {
    head,
    branch,
    dirty,
    status,
    startedAt,
    files,
  };
}

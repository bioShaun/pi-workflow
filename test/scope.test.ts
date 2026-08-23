import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { RequirementSnapshot } from "../src/contracts/requirement.ts";
import { captureRepositoryBaseline } from "../src/repository/baseline.ts";
import {
  compareRepositoryScope,
  ScopeComparisonError,
} from "../src/repository/scope.ts";
import { WorkflowEngine } from "../src/engine/engine.ts";
import { FakeAgentExecutor } from "./fake-executor.ts";
import { FakeVerificationRunner } from "./fake-verification.ts";

const execFileAsync = promisify(execFile);

describe("Actual repository scope", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(process.cwd(), ".scratch", "scope-test-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await fs.writeFile(path.join(cwd, "spec.md"), "# Frozen spec\n", "utf-8");
    await fs.writeFile(path.join(cwd, "allowed.txt"), "before\n", "utf-8");
    await fs.writeFile(path.join(cwd, "old.txt"), "old\n", "utf-8");
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  function requirement(): RequirementSnapshot {
    const source = "# Frozen spec\n";
    return {
      kind: "spec",
      sourcePath: "spec.md",
      artifactPath: "requirement.md",
      sha256: crypto.createHash("sha256").update(source).digest("hex"),
      characters: source.length,
    };
  }

  it("detects real unreported changes relative to dirty and untracked inputs", async () => {
    const baseline = await captureRepositoryBaseline(cwd);
    await fs.writeFile(path.join(cwd, "allowed.txt"), "after\n", "utf-8");
    await fs.writeFile(path.join(cwd, "extra.txt"), "unreported\n", "utf-8");

    const result = await compareRepositoryScope({
      cwd,
      baseline,
      allowedChanges: ["allowed.txt"],
      requirement: requirement(),
      label: "implementation",
    });

    assert.equal(result.status, "failed");
    assert.deepEqual(result.changed, ["allowed.txt", "extra.txt"]);
    assert.deepEqual(result.outOfScope, ["extra.txt"]);
  });

  it("counts both sides of a rename and excludes workflow artifacts", async () => {
    const baseline = await captureRepositoryBaseline(cwd);
    await fs.rename(path.join(cwd, "old.txt"), path.join(cwd, "new.txt"));
    await fs.mkdir(path.join(cwd, ".pi", "workflow"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".pi", "workflow", "state.json"), "{}", "utf-8");

    const result = await compareRepositoryScope({
      cwd,
      baseline,
      allowedChanges: ["old.txt", "new.txt"],
      requirement: requirement(),
      label: "implementation",
    });

    assert.equal(result.status, "passed");
    assert.deepEqual(result.changed, ["new.txt", "old.txt"]);
  });

  it("always rejects source edits and fails closed without exact baseline files", async () => {
    const baseline = await captureRepositoryBaseline(cwd);
    await fs.writeFile(path.join(cwd, "spec.md"), "# Tampered\n", "utf-8");
    const result = await compareRepositoryScope({
      cwd,
      baseline,
      allowedChanges: ["spec.md"],
      requirement: requirement(),
      label: "implementation",
    });
    assert.deepEqual(result.outOfScope, ["spec.md"]);

    await assert.rejects(
      compareRepositoryScope({
        cwd,
        baseline: { ...baseline, files: undefined },
        allowedChanges: [],
        requirement: requirement(),
        label: "implementation",
      }),
      ScopeComparisonError
    );
  });

  it("routes an unreported scope violation through fix before verification", async () => {
    await fs.writeFile(path.join(cwd, "spec.md"), `---
work:
  verify:
    - npm test
  changes:
    allow:
      - allowed.txt
---
# Scoped spec
`, "utf-8");
    const executor = new FakeAgentExecutor();
    executor.setHandler("implement", async () => {
      await fs.writeFile(path.join(cwd, "allowed.txt"), "implemented\n", "utf-8");
      await fs.writeFile(path.join(cwd, "extra.txt"), "unreported\n", "utf-8");
      return {
        status: "completed",
        result: {
          summary: "implemented",
          changedFiles: [{ path: "allowed.txt", change: "updated" }],
          tests: [],
          unresolvedIssues: [],
          deviationsFromPlan: [],
        },
      };
    });
    executor.setHandler("fix-1", async () => {
      await fs.rm(path.join(cwd, "extra.txt"));
      return {
        status: "completed",
        result: {
          summary: "restored scope",
          addressedFindings: [],
          unaddressedFindings: [],
          changedFiles: [],
          tests: [],
        },
      };
    });
    const verificationRunner = new FakeVerificationRunner();
    const run = await new WorkflowEngine({
      cwd,
      executor,
      verificationRunner,
    }).startSpec("spec.md", { mode: "quick" });

    assert.equal(run.state, "completed");
    assert.deepEqual(executor.requests.map((request) => request.nodeId), [
      "implement",
      "fix-1",
      "review-1",
    ]);
    assert.equal(verificationRunner.calls.length, 1, "verification waits for scope to pass");
    assert.equal(run.scopeGate?.status, "passed");
    assert.match(executor.requests[1].task, /Out-of-Scope Repository Changes/);
    assert.match(executor.requests[1].task, /extra\.txt/);
  });
});

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  normalizeAllowedPath,
  parseSpecDocument,
  resolveSpecMode,
  SpecFormatError,
} from "../src/specs/spec-parser.ts";

describe("Spec policy parser", () => {
  it("keeps plain Markdown valid with default verification", () => {
    const source = "# Requirement\n\nDo the thing.\n";
    const parsed = parseSpecDocument(source);

    assert.equal(parsed.body, source);
    assert.deepEqual(parsed.policy.verification, [{ command: "npm test", required: true }]);
    assert.equal(parsed.policy.mode, undefined);
    assert.equal(parsed.policy.allowedChanges, undefined);
  });

  it("resolves mode with CLI then front matter then configuration precedence", () => {
    assert.equal(resolveSpecMode("quick", "strict", "normal"), "quick");
    assert.equal(resolveSpecMode(undefined, "strict", "normal"), "strict");
    assert.equal(resolveSpecMode(undefined, undefined, "normal"), "normal");
  });

  it("parses mode, ordered commands, and normalized allowed paths", () => {
    const parsed = parseSpecDocument(`---
work:
  mode: strict
  verify:
    - npm test
    - npm run typecheck
  changes:
    allow:
      - src/./engine/engine.ts
      - test/spec-flow.test.ts
---
# Requirement
`);

    assert.equal(parsed.policy.mode, "strict");
    assert.deepEqual(parsed.policy.verification, [
      { command: "npm test", required: true },
      { command: "npm run typecheck", required: true },
    ]);
    assert.deepEqual(parsed.policy.allowedChanges, [
      normalizeAllowedPath("src/./engine/engine.ts"),
      "test/spec-flow.test.ts",
    ]);
    assert.equal(parsed.body, "# Requirement\n");
  });

  for (const [name, frontMatter] of [
    ["unknown work key", "work:\n  mystery: true"],
    ["empty command", "work:\n  verify:\n    - '   '"],
    ["duplicate command", "work:\n  verify:\n    - npm test\n    - npm test"],
    ["empty allowlist", "work:\n  changes:\n    allow:"],
    ["duplicate normalized path", "work:\n  changes:\n    allow:\n      - src/a.ts\n      - src/./a.ts"],
    ["absolute path", "work:\n  changes:\n    allow:\n      - /etc/passwd"],
    ["traversal path", "work:\n  changes:\n    allow:\n      - ../outside.ts"],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => parseSpecDocument(`---\n${frontMatter}\n---\n# Requirement\n`),
        SpecFormatError
      );
    });
  }
});

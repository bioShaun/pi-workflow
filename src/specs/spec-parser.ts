import * as path from "node:path";
import {
  DEFAULT_SPEC_VERIFICATION,
  type ParsedSpecDocument,
  type VerificationRequirement,
} from "../contracts/requirement.ts";
import type { WorkflowMode } from "../contracts/workflow.ts";

/**
 * Deliberately narrow, pure parser for the documented `work` front matter
 * shape of a spec document:
 *
 *   ---
 *   work:
 *     mode: strict
 *     verify:
 *       - npm test
 *       - npm run typecheck
 *     changes:
 *       allow:
 *         - src/utils/truncate.ts
 *         - test/truncate.test.ts
 *   ---
 *
 * It is NOT a general YAML parser: no flow collections, anchors, multi-line
 * scalars, or comments inside values. A document without front matter is
 * valid and receives the default policy. All violations throw SpecFormatError
 * (surfaced as the `invalid_spec` workflow error before run creation).
 */

export class SpecFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecFormatError";
  }
}

const WORKFLOW_MODES: readonly WorkflowMode[] = ["quick", "normal", "strict"];

/** Resolve the documented CLI → front matter → configuration precedence. */
export function resolveSpecMode(
  explicit: WorkflowMode | undefined,
  declared: WorkflowMode | undefined,
  configured: WorkflowMode
): WorkflowMode {
  return explicit ?? declared ?? configured;
}

/** Strip a matching pair of single or double quotes from a scalar. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

interface Line {
  indent: number;
  text: string;
}

function contentLines(block: string): Line[] {
  const lines: Line[] = [];
  for (const raw of block.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    lines.push({ indent: raw.length - raw.trimStart().length, text: trimmed });
  }
  return lines;
}

/**
 * Normalize an allowed path to a project-relative form and reject anything
 * that is empty, absolute, or escapes the project root (`..` traversal).
 * After normalization such a path can never resolve outside `cwd`.
 */
export function normalizeAllowedPath(raw: string): string {
  const value = unquote(raw).trim();
  if (value.length === 0) {
    throw new SpecFormatError("work.changes.allow contains an empty path");
  }
  if (path.isAbsolute(value)) {
    throw new SpecFormatError(`work.changes.allow contains an absolute path: "${value}"`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new SpecFormatError(`work.changes.allow contains a path escaping the project root: "${value}"`);
  }
  if (normalized.split(path.sep).includes("..")) {
    throw new SpecFormatError(`work.changes.allow contains a path escaping the project root: "${value}"`);
  }
  return normalized;
}

function parseStringList(
  lines: Line[],
  keyIndex: number,
  keyPath: string
): { values: string[]; end: number } {
  const key = lines[keyIndex];
  const values: string[] = [];
  let end = keyIndex + 1;
  while (end < lines.length && lines[end].indent > key.indent) {
    const line = lines[end];
    if (line.indent !== key.indent + 2 || !line.text.startsWith("-")) {
      throw new SpecFormatError(`${keyPath} must be a block list of strings ("- <value>" lines)`);
    }
    values.push(line.text.replace(/^-\s*/, ""));
    end++;
  }
  if (values.length === 0) {
    throw new SpecFormatError(`${keyPath} must be a non-empty list when present`);
  }
  return { values, end };
}

function parseWorkBlock(lines: Line[], workIndex: number): ParsedSpecDocument["policy"] {
  const baseIndent = lines[workIndex].indent;
  // The block under `work:` runs until the next line at the same (or lesser)
  // indent — any other top-level front matter key is not part of the
  // documented shape and is ignored.
  let end = lines.length;
  for (let i = workIndex + 1; i < lines.length; i++) {
    if (lines[i].indent <= baseIndent) {
      end = i;
      break;
    }
  }
  const block = lines.slice(workIndex + 1, end);
  if (block.length === 0) {
    return { verification: [...DEFAULT_SPEC_VERIFICATION] };
  }
  const keyIndent = block[0].indent;

  let mode: WorkflowMode | undefined;
  let verify: VerificationRequirement[] | undefined;
  let allow: string[] | undefined;
  let seenMode = false;
  let seenVerify = false;
  let seenChanges = false;

  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    if (line.indent !== keyIndent || line.text.startsWith("-")) {
      throw new SpecFormatError(`work block contains an unsupported line: "${line.text}"`);
    }
    const m = line.text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/);
    if (!m) {
      throw new SpecFormatError(`work block contains an unsupported line: "${line.text}"`);
    }
    const key = m[1];
    const inline = m[2].trim();

    if (key === "mode") {
      if (seenMode) throw new SpecFormatError("work.mode is declared more than once");
      seenMode = true;
      if (inline.startsWith("-") || inline === "") {
        throw new SpecFormatError("work.mode must be a scalar: quick, normal, or strict");
      }
      const value = unquote(inline);
      if (!WORKFLOW_MODES.includes(value as WorkflowMode)) {
        throw new SpecFormatError(`work.mode has an invalid value: "${value}" (expected quick, normal, or strict)`);
      }
      mode = value as WorkflowMode;
    } else if (key === "verify") {
      if (seenVerify) throw new SpecFormatError("work.verify is declared more than once");
      seenVerify = true;
      if (inline.startsWith("-") || inline.startsWith("[")) {
        throw new SpecFormatError("work.verify must be a block list of commands");
      }
      if (inline !== "") {
        throw new SpecFormatError("work.verify must be a block list of commands (one per line, starting with '-')");
      }
      const { values: rawCommands, end } = parseStringList(block, i, "work.verify");
      const commands: string[] = [];
      for (const raw of rawCommands) {
        const command = unquote(raw).trim();
        if (command.length === 0) {
          throw new SpecFormatError("work.verify contains an empty command");
        }
        if (commands.includes(command)) {
          throw new SpecFormatError(`work.verify contains a duplicate command: "${command}"`);
        }
        commands.push(command);
      }
      verify = commands.map((command) => ({ command, required: true }));
      i = end - 1;
    } else if (key === "changes") {
      if (seenChanges) throw new SpecFormatError("work.changes is declared more than once");
      seenChanges = true;
      if (inline.startsWith("-") || inline.startsWith("[")) {
        throw new SpecFormatError("work.changes must be a block mapping with an 'allow' list");
      }
      if (inline !== "") {
        throw new SpecFormatError("work.changes must be a block mapping with an 'allow' list");
      }
      const allowIndex = i + 1;
      const allowLine = block[allowIndex];
      if (!allowLine || allowLine.indent !== keyIndent + 2) {
        throw new SpecFormatError("work.changes requires an 'allow' list of paths");
      }
      const allowMatch = allowLine.text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/);
      if (!allowMatch) {
        throw new SpecFormatError(`work.changes contains an unsupported line: "${allowLine.text}"`);
      }
      if (allowMatch[1] !== "allow") {
        throw new SpecFormatError(`work.changes contains an unknown key: "${allowMatch[1]}"`);
      }
      if (allowMatch[2].trim() !== "") {
        throw new SpecFormatError("work.changes.allow must be a block list of paths");
      }
      // Consume the allow list items.
      let j = allowIndex + 1;
      const rawPaths: string[] = [];
      while (j < block.length && block[j].indent === keyIndent + 4 && block[j].text.startsWith("-")) {
        rawPaths.push(block[j].text.replace(/^-\s*/, ""));
        j++;
      }
      if (rawPaths.length === 0) {
        throw new SpecFormatError("work.changes.allow must be a non-empty list when present");
      }
      const normalized: string[] = [];
      for (const raw of rawPaths) {
        const p = normalizeAllowedPath(raw);
        if (normalized.includes(p)) {
          throw new SpecFormatError(`work.changes.allow contains a duplicate path: "${p}"`);
        }
        normalized.push(p);
      }
      allow = normalized;
      i = j - 1; // loop increment skips the consumed list items
    } else {
      throw new SpecFormatError(`unknown key under work: "${key}"`);
    }
  }

  return {
    mode,
    verification: verify ?? [...DEFAULT_SPEC_VERIFICATION],
    allowedChanges: allow,
  };
}

/**
 * Parse a spec document: separate the optional front matter from the body
 * (verbatim — the original bytes are what get snapshotted) and extract the
 * narrow `work` policy. Pure and synchronous; throws SpecFormatError on any
 * policy violation.
 */
export function parseSpecDocument(content: string): ParsedSpecDocument {
  const frontMatch = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!frontMatch) {
    return {
      body: content,
      policy: { verification: [...DEFAULT_SPEC_VERIFICATION] },
    };
  }
  const body = content.slice(frontMatch[0].length);
  const lines = contentLines(frontMatch[1]);
  const workIndex = lines.findIndex((l) => l.indent === 0 && l.text === "work:");
  if (workIndex === -1) {
    // Front matter without a `work` block carries no policy.
    return { body, policy: { verification: [...DEFAULT_SPEC_VERIFICATION] } };
  }
  return {
    body,
    policy: parseWorkBlock(lines, workIndex),
  };
}

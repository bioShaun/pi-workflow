import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { truncateMiddle } from "../src/utils/truncate.ts";

describe("truncateMiddle", () => {
  it("returns short strings unchanged", () => {
    assert.equal(truncateMiddle("hello", 10), "hello");
    assert.equal(truncateMiddle("abc", 3), "abc");
  });

  it("returns the empty string unchanged", () => {
    assert.equal(truncateMiddle("", 5), "");
    assert.equal(truncateMiddle("", 0), "");
  });

  it("truncates an ASCII long string to exactly maxWidth keeping first and last chars", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const maxWidth = 10;
    const result = truncateMiddle(text, maxWidth);
    assert.equal(result.length, maxWidth);
    assert.equal(result[0], text[0]);
    assert.equal(result[result.length - 1], text[text.length - 1]);
    assert.ok(result.includes("…"));
  });

  it("truncates a Chinese string by code units", () => {
    // 4 chars x 1 code unit each = "测试字符串x" is 7 code units
    const text = "测试字符串xy";
    const maxWidth = 5;
    const result = truncateMiddle(text, maxWidth);
    assert.equal(result.length, maxWidth);
    assert.equal(result[0], "测");
    assert.equal(result[result.length - 1], "y");
    assert.ok(result.includes("…"));
  });

  it("applies a custom marker", () => {
    const text = "0123456789";
    const result = truncateMiddle(text, 6, "..");
    assert.equal(result.length, 6);
    assert.equal(result, "01..89");
  });

  it("uses the default marker when none is given", () => {
    const result = truncateMiddle("0123456789", 5);
    assert.equal(result.includes("…"), true);
    assert.equal(result.length, 5);
  });

  it("returns the marker (truncated) when maxWidth <= marker.length", () => {
    assert.equal(truncateMiddle("0123456789", 1), "…");
    assert.equal(truncateMiddle("0123456789", 0), "");
    assert.equal(truncateMiddle("0123456789", 2, ".."), "..");
  });

  it("does not mutate the input string", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const before = text;
    const result = truncateMiddle(text, 10);
    assert.notEqual(result, text);
    assert.equal(text, before);
  });
});

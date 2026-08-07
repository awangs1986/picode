import { describe, expect, it } from "vitest";
import { SEMANTIC_OPS, isKnownSemanticOp } from "../../src/shared/semantic-ops.ts";

const SEMANTIC_OP_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*@\d+$/;

describe("SEMANTIC_OPS", () => {
  it("values match <domain>.<op>@<n> pattern", () => {
    for (const value of Object.values(SEMANTIC_OPS)) {
      expect(value).toMatch(SEMANTIC_OP_PATTERN);
    }
  });
});

describe("isKnownSemanticOp", () => {
  it("returns true for every SEMANTIC_OPS value", () => {
    for (const value of Object.values(SEMANTIC_OPS)) {
      expect(isKnownSemanticOp(value)).toBe(true);
    }
  });

  it("returns false for unknown values", () => {
    expect(isKnownSemanticOp("fs.read@2")).toBe(false);
    expect(isKnownSemanticOp("unknown.op@1")).toBe(false);
    expect(isKnownSemanticOp("")).toBe(false);
  });
});

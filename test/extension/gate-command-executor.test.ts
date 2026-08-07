import { describe, expect, it } from "vitest";
import { parseTestCounts } from "../../src/extension/gate-command-executor.ts";

describe("parseTestCounts", () => {
  it("parses Vitest summary counts", () => {
    expect(parseTestCounts("Tests  2 failed | 17 passed (19)", 1)).toEqual({
      matchedTests: 19,
      passedTests: 17,
      failedTests: 2,
    });
  });

  it("parses cargo test summary counts", () => {
    expect(parseTestCounts("test result: FAILED. 12 passed; 1 failed; 2 ignored", 1)).toEqual({
      matchedTests: 13,
      passedTests: 12,
      failedTests: 1,
    });
  });

  it("does not invent matched tests from an exit code", () => {
    expect(parseTestCounts("compiler exploded", 1)).toEqual({
      matchedTests: 0,
      passedTests: 0,
      failedTests: 0,
    });
  });

  it("parses pytest summaries with warnings and durations around the counts", () => {
    expect(parseTestCounts("=== 2 failed, 17 passed, 3 warnings in 1.20s ===", 1)).toEqual({
      matchedTests: 19,
      passedTests: 17,
      failedTests: 2,
    });
  });
});

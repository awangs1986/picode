import { describe, expect, test } from "vitest";
import {
  buildAdvisoryDelegation,
  buildSubagentPrompt,
  type SubagentContext,
  subagentToolAllowed,
} from "./embedded-server.ts";

const context: SubagentContext = {
  parentRunId: "run-main",
  envelope: {
    goal: "find references",
    scope: ["src"],
    method: "bounded search",
    tools: ["search", "read"],
    permissions: ["workspace.read"],
    context: ["symbol=Player"],
    stopConditions: ["all matches listed"],
    expectedResult: "path and line list",
  },
};

describe("Subagent enforcement", () => {
  test("maps only declared abstract tools to the Pi core surface", () => {
    expect(subagentToolAllowed(context, "read")).toBe(true);
    expect(subagentToolAllowed(context, "grep")).toBe(true);
    expect(subagentToolAllowed(context, "bash")).toBe(false);
    expect(subagentToolAllowed(context, "edit")).toBe(false);
  });

  test("injects a deterministic soldier envelope with stop conditions", () => {
    const prompt = buildSubagentPrompt(context);
    expect(prompt).toContain("run-main");
    expect(prompt).toContain("find references");
    expect(prompt).toContain("all matches listed");
    expect(prompt).toContain("must not expand");
  });

  test("builds advisory work as a bounded read-only opinion rather than evidence", () => {
    const work = buildAdvisoryDelegation(
      "security",
      "Review the authentication boundary",
      ["src/auth"],
      ["Diff is already staged"],
      "List risks and uncertainty",
    );
    expect(work.class).toBe("advisory-review");
    expect(work.envelope.tools).toEqual(["search", "read"]);
    expect(work.envelope.permissions).toEqual(["workspace.read"]);
    expect(work.requiresWrite).toBe(false);
    expect(work.usesSecret).toBe(false);
    expect(work.destructive).toBe(false);
    expect(work.contextBytes).toBeGreaterThan(0);
  });
});

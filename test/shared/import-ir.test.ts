import { describe, expect, it } from "vitest";
import type { ForeignEvent } from "../../src/shared/import-ir.ts";
import { collectSignatures } from "../../src/shared/import-ir.ts";

describe("collectSignatures", () => {
  const events: ForeignEvent[] = [
    { kind: "user", index: 0, text: "hi" },
    { kind: "tool_call", index: 1, toolName: "Read", callId: "c1" },
    { kind: "tool_result", index: 2, callId: "c1", resultJson: "ok" },
    { kind: "tool_call", index: 3, toolName: "Read", callId: "c2" },
    { kind: "tool_call", index: 4, toolName: "Bash", callId: "c3" },
    { kind: "assistant", index: 5, text: "done" },
  ];

  it("dedupes tool names and ignores non tool_call events", () => {
    const sigs = collectSignatures("claude-code", events);
    expect(sigs).toEqual([
      { sourceAgent: "claude-code", toolName: "Read" },
      { sourceAgent: "claude-code", toolName: "Bash" },
    ]);
  });

  it("skips tool_call events without a toolName", () => {
    const sigs = collectSignatures("codex", [{ kind: "tool_call", index: 0, callId: "c1" }]);
    expect(sigs).toEqual([]);
  });

  it("carries sourceVersion only when provided", () => {
    const withVersion = collectSignatures("codex", events, "1.2.3");
    expect(withVersion[0]).toEqual({
      sourceAgent: "codex",
      toolName: "Read",
      sourceVersion: "1.2.3",
    });

    const withoutVersion = collectSignatures("codex", events);
    expect(withoutVersion[0]).toEqual({ sourceAgent: "codex", toolName: "Read" });
    expect(withoutVersion[0]).not.toHaveProperty("sourceVersion");
  });
});

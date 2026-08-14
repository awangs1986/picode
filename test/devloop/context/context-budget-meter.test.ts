import { describe, expect, it } from "vitest";
import { ContextBudgetMeter } from "../../../src/devloop/context/context-budget-meter.ts";
import type { ContextGovernorMessage } from "../../../src/devloop/context/context-governor.ts";

describe("ContextBudgetMeter", () => {
  it("anchors pressure to provider usage and applies signed surface deltas", () => {
    const meter = new ContextBudgetMeter();
    const anchor: ContextGovernorMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      usage: { input: 10_000, output: 500, cacheRead: 80_000, cacheWrite: 0, totalTokens: 90_500 },
    };
    const tail: ContextGovernorMessage = { role: "user", content: [{ type: "text", text: "x".repeat(9_000) }] };

    const measured = meter.measure({
      sessionId: "s-1",
      revision: "42",
      messages: [anchor, tail],
      systemPrompt: "system",
      tools: [],
    });

    expect(measured.providerObservedTokens).toBeGreaterThan(90_500);
    expect(measured.totalTokens).toBe(measured.providerObservedTokens);
    expect(measured.source).toBe("provider-anchor");
  });

  it("returns an equivalent detached snapshot for a replayed revision", () => {
    const meter = new ContextBudgetMeter();
    const input = {
      sessionId: "s-2",
      revision: "9:last-entry",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      systemPrompt: "system",
      tools: [{ name: "read", parameters: { type: "object" } }],
    };
    const first = meter.measure(input);
    const second = meter.measure(input);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

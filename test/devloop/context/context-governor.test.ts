import { describe, expect, it } from "vitest";
import {
  ContextGovernor,
  type ContextGovernorMessage,
} from "../../../src/devloop/context/context-governor.ts";

function user(text: string): ContextGovernorMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantWithCall(id: string): ContextGovernorMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning".repeat(2_000) },
      { type: "toolCall", id, name: "bash", arguments: { command: "test" } },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function toolResult(id: string, text: string): ContextGovernorMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  };
}

describe("ContextGovernor", () => {
  it("passes a small request without rewriting its messages", () => {
    const governor = new ContextGovernor();
    const messages = [user("inspect the repository")];

    const result = governor.prepareRequest({
      messages,
      systemPrompt: "You are Pi.",
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      declaredContextWindow: 200_000,
      maxOutputTokens: 16_384,
      thirdPartyGateway: false,
    });

    expect(result.action).toBe("pass");
    expect(result.messages).toBe(messages);
    expect(result.before.totalTokens).toBeLessThan(result.budget.triggerInputTokens);
  });

  it("uses a conservative effective window for an unverified third-party gateway", () => {
    const governor = new ContextGovernor();
    const result = governor.prepareRequest({
      messages: [user("small")],
      systemPrompt: "system",
      tools: [],
      declaredContextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      thirdPartyGateway: true,
    });

    expect(result.budget.effectiveContextWindow).toBe(320_000);
    expect(result.budget.reason).toBe("unverified-third-party-cap");
  });

  it("compacts a trace-shaped tool-output burst before the provider request", () => {
    const governor = new ContextGovernor();
    const hugeOutput = "<ui-node>large tool output</ui-node>\n".repeat(32_000);
    const messages = [
      user("continue the implementation"),
      assistantWithCall("call-1"),
      toolResult("call-1", hugeOutput),
      assistantWithCall("call-2"),
      toolResult("call-2", hugeOutput),
    ];
    const original = structuredClone(messages);

    const result = governor.prepareRequest({
      messages,
      systemPrompt: "s".repeat(12_000),
      tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
      declaredContextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      thirdPartyGateway: true,
    });

    expect(result.action).toBe("compact");
    expect(result.after.totalTokens).toBeLessThanOrEqual(result.budget.hardInputTokens);
    expect(result.stats.toolResultsCompacted).toBe(2);
    expect(JSON.stringify(result.messages)).toContain("Picode tool output compacted");
    expect((result.messages[2] as unknown as { toolCallId: string }).toolCallId).toBe("call-1");
    expect((result.messages[4] as unknown as { toolCallId: string }).toolCallId).toBe("call-2");
    expect(messages).toEqual(original);
  });

  it("counts system prompt and tool schemas in the same preflight budget", () => {
    const governor = new ContextGovernor();
    const result = governor.prepareRequest({
      messages: [user("small history")],
      systemPrompt: "policy ".repeat(30_000),
      tools: [{
        name: "large_schema",
        description: "schema ".repeat(20_000),
        parameters: { type: "object", description: "field ".repeat(20_000) },
      }],
      declaredContextWindow: 100_000,
      maxOutputTokens: 8_000,
      thirdPartyGateway: false,
    });

    expect(result.before.systemPromptTokens).toBeGreaterThan(40_000);
    expect(result.before.toolSchemaTokens).toBeGreaterThan(40_000);
    expect(result.action).toBe("blocked");
    expect(result.blockedReason).toContain("immutable prefix");
  });

  it("treats provider cacheRead usage plus new tool results as real context", () => {
    const governor = new ContextGovernor();
    const observed = assistantWithCall("observed") as ContextGovernorMessage & {
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: Record<string, number> };
    };
    observed.usage = {
      input: 18_005,
      output: 417,
      cacheRead: 328_192,
      cacheWrite: 0,
      totalTokens: 346_614,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const result = governor.prepareRequest({
      messages: [
        user("older work"),
        assistantWithCall("old"),
        toolResult("old", "old cached output\n".repeat(80_000)),
        user("work"),
        observed,
        toolResult("observed", "new tail\n".repeat(12_000)),
      ],
      systemPrompt: "Pi",
      tools: [],
      declaredContextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      thirdPartyGateway: true,
    });

    expect(result.before.providerObservedTokens).toBeGreaterThan(346_614);
    expect(result.action).toBe("compact");
    expect(result.after.totalTokens).toBeLessThanOrEqual(result.budget.hardInputTokens);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { packCapsuleWithCurrentModel } from "../../src/extension/capsule-model-packager.ts";

describe("current-session Capsule model adapter", () => {
  it("uses the active model and thinking level, redacts history, and exposes no tools", async () => {
    const complete = vi.fn(async (_model, context, options) => {
      const prompt = context.messages[0]?.content[0]?.text ?? "";
      expect(prompt).not.toContain("sk-super-secret-value");
      expect(context).not.toHaveProperty("tools");
      expect(options).toMatchObject({ cacheRetention: "none", reasoning: "high" });
      return {
        role: "assistant",
        content: [{
          type: "text",
          text: JSON.stringify({
            decisions: [{ decision: "Keep Pi JSONL", rationale: "It is authoritative" }],
            failedApproaches: [],
            nextSteps: ["Continue the adapter"],
            narrative: "Short handoff",
          }),
        }],
        stopReason: "stop",
      };
    });
    const ctx = {
      model: { provider: "openai", id: "gpt-5.6", reasoning: true },
      thinkingLevel: "high",
      signal: undefined,
      modelRegistry: { complete },
      sessionManager: {
        getBranch: () => [{
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "API_KEY=sk-super-secret-value", timestamp: Date.now() },
        }],
      },
    } as unknown as ExtensionContext;

    const result = await packCapsuleWithCurrentModel(ctx, "Continue safely");
    expect(result.ok).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ provider: "openai", id: "gpt-5.6" });
  });

  it("can repackage a child whose only conversation entry is the previous Capsule", async () => {
    const complete = vi.fn(async (_model, context) => {
      const prompt = context.messages[0]?.content[0]?.text ?? "";
      expect(prompt).toContain("Prior verified Capsule");
      expect(prompt).toContain("Continue phase five");
      return {
        role: "assistant",
        content: [{
          type: "text",
          text: JSON.stringify({
            decisions: [],
            failedApproaches: [],
            nextSteps: ["Continue phase five"],
            narrative: "",
          }),
        }],
        stopReason: "stop",
      };
    });
    const ctx = {
      model: { provider: "openai", id: "gpt-5.6", reasoning: false },
      thinkingLevel: "off",
      signal: undefined,
      modelRegistry: { complete },
      sessionManager: {
        getBranch: () => [{
          type: "custom_message",
          id: "capsule-message",
          parentId: null,
          timestamp: new Date().toISOString(),
          customType: "picode.task-capsule",
          content: "Prior verified Capsule",
          display: true,
        }],
      },
    } as unknown as ExtensionContext;

    const result = await packCapsuleWithCurrentModel(ctx, "Continue phase five");
    expect(result.ok).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
  });
});

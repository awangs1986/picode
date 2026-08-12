import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextGovernor } from "../../src/extension/context-governor.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

describe("Context Governor Pi adapter", () => {
  it("rewrites the real per-request context and schedules durable compaction after settle", async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on(name: string, handler: Handler) { handlers.set(name, handler); },
      getActiveTools: () => ["bash"],
      getAllTools: () => [{
        name: "bash",
        description: "Run commands",
        parameters: { type: "object" },
        sourceInfo: { source: "builtin" },
      }],
    } as unknown as ExtensionAPI;
    const compact = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      model: {
        id: "gpt-test",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true,
          apiKey: "redacted",
          baseUrl: "https://proxy.example/v1",
        })),
      },
      getSystemPrompt: () => "Pi base prompt",
      compact,
      ui: { setStatus },
    } as unknown as ExtensionContext;

    registerContextGovernor(pi);
    const huge = "tool log\n".repeat(160_000);
    const event = {
      type: "context",
      messages: [{
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "bash",
        content: [{ type: "text", text: huge }],
        isError: false,
        timestamp: Date.now(),
      }],
    };

    const transformed = await handlers.get("context")?.(event as never, ctx) as { messages: unknown[] };
    expect(JSON.stringify(transformed.messages).length).toBeLessThan(huge.length / 10);
    expect(setStatus).toHaveBeenCalledWith("picode-context", expect.stringContaining("compacted"));

    await handlers.get("agent_settled")?.({ type: "agent_settled" } as never, ctx);
    expect(compact).toHaveBeenCalledOnce();
  });
});

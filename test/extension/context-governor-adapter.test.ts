import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerContextGovernor } from "../../src/extension/context-governor.ts";
import type {
  ContextCompilationStorePort,
  ContextLedgerStorePort,
  EndpointContextProfileStorePort,
} from "../../src/shared/types.ts";
import { ok } from "../../src/shared/types.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

describe("Context Governor Pi adapter", () => {
  it("shows the 400K reliable ceiling instead of the larger provider capacity", async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on(name: string, handler: Handler) { handlers.set(name, handler); },
      getActiveTools: () => [],
      getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const setStatus = vi.fn();
    const ctx = {
      model: {
        id: "large-window-model",
        provider: "openai",
        api: "openai-responses",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
      modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "redacted" })) },
      getSystemPrompt: () => "Pi",
      ui: { setStatus },
    } as unknown as ExtensionContext;
    const onContextPressure = vi.fn();
    registerContextGovernor(pi, undefined, { onContextPressure });

    await handlers.get("context")?.({
      type: "context",
      messages: [{ role: "user", content: [{ type: "text", text: "small" }] }],
    } as never, ctx);

    expect(setStatus).toHaveBeenCalledWith("picode-context", expect.stringMatching(/\/ 400K$/));
    expect(onContextPressure).toHaveBeenCalledWith(expect.objectContaining({
      reliableContextCeiling: 400_000,
      percent: expect.any(Number),
    }));
  });

  it("protects a real provider even when its declared window is below 32K", async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on(name: string, handler: Handler) { handlers.set(name, handler); },
      getActiveTools: () => [],
      getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const setStatus = vi.fn();
    const ctx = {
      model: {
        id: "small-real-model",
        provider: "openai",
        api: "openai-responses",
        contextWindow: 16_000,
        maxTokens: 1_000,
      },
      modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "redacted" })) },
      getSystemPrompt: () => "Pi",
      compact: vi.fn(),
      abort: vi.fn(),
      ui: { setStatus },
    } as unknown as ExtensionContext;
    registerContextGovernor(pi);

    const transformed = await handlers.get("context")?.({
      type: "context",
      messages: [{
        role: "toolResult", toolCallId: "small-window-log", toolName: "bash", isError: false,
        content: [{ type: "text", text: "x".repeat(100_000) }],
      }],
    } as never, ctx) as { messages: unknown[] } | undefined;

    expect(transformed?.messages).toBeDefined();
    expect(setStatus).toHaveBeenCalledWith("picode-context", expect.stringContaining("compacted"));
  });

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

  it("applies endpoint evidence and persists the exact compilation manifest", async () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on(name: string, handler: Handler) { handlers.set(name, handler); },
      getActiveTools: () => [],
      getAllTools: () => [],
    } as unknown as ExtensionAPI;
    const saveContextCompilation = vi.fn(async () => ok("manifest.json"));
    const appendContextLedger = vi.fn(async () => ok(undefined));
    const saveEndpointContextProfile = vi.fn(async () => ok(undefined));
    const store: ContextCompilationStorePort & EndpointContextProfileStorePort & ContextLedgerStorePort = {
      saveContextCompilation,
      appendContextLedger,
      listContextLedger: vi.fn(async () => ok([])),
      loadEndpointContextProfile: vi.fn(async (routeKey) => ok({
        schemaVersion: "picode.endpoint-context/v1" as const,
        routeKey,
        verifiedContextWindow: 64_000,
      })),
      saveEndpointContextProfile,
    };
    const ctx = {
      model: {
        id: "gpt-test", provider: "openai", api: "openai-responses",
        baseUrl: "https://proxy.example/v1", contextWindow: 1_000_000, maxTokens: 8_000,
      },
      modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "redacted", baseUrl: "https://proxy.example/v1" })) },
      sessionManager: { getSessionId: () => "session-evidence", getBranch: () => [{ id: "leaf-7" }] },
      getSystemPrompt: () => "Pi",
      compact: vi.fn(),
      abort: vi.fn(),
      ui: { setStatus: vi.fn() },
    } as unknown as ExtensionContext;
    registerContextGovernor(pi, undefined, { store });

    const transformed = await handlers.get("context")?.({
      type: "context",
      messages: [{
        role: "toolResult", toolCallId: "large-1", toolName: "bash", isError: false,
        content: [{ type: "text", text: "x".repeat(180_000) }],
      }],
    } as never, ctx) as { messages: unknown[] };

    expect(transformed.messages).toBeDefined();
    expect(saveContextCompilation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-evidence",
      effectiveContextWindow: 64_000,
      action: "compact",
    }));
    expect(appendContextLedger).toHaveBeenCalledWith(expect.objectContaining({
      layer: "governor",
      action: "compiled",
      requestOnly: true,
    }));

    await handlers.get("agent_settled")?.({ type: "agent_settled" } as never, ctx);
    expect(appendContextLedger).toHaveBeenCalledWith(expect.objectContaining({
      layer: "durable-compaction",
      action: "scheduled",
      requestOnly: false,
    }));
    const compactOptions = (ctx.compact as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { onComplete?: () => void };
    compactOptions.onComplete?.();
    expect(appendContextLedger).toHaveBeenCalledWith(expect.objectContaining({
      layer: "durable-compaction",
      action: "completed",
    }));

    await handlers.get("after_provider_response")?.({ type: "after_provider_response", status: 200, headers: {} } as never, ctx);
    expect(saveEndpointContextProfile).toHaveBeenCalledWith(expect.objectContaining({
      verifiedContextWindow: 64_000,
      observedSuccessInputTokens: expect.any(Number),
    }));
  });
});

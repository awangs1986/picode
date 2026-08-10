import { describe, expect, it, vi } from "vitest";
import {
  capacityFromModelRecord,
  largestKnownCapacity,
  probeModelCapacity,
} from "../../src/extension/model-capacity.ts";

describe("model capacity discovery", () => {
  it("reads common direct and nested context limit fields", () => {
    expect(capacityFromModelRecord({
      context_window: 272_000,
      max_output_tokens: 64_000,
    })).toEqual({ contextWindow: 272_000, maxTokens: 64_000 });
    expect(capacityFromModelRecord({
      capabilities: { context_window: "1000000", max_output_tokens: "128000" },
    })).toEqual({ contextWindow: 1_000_000, maxTokens: 128_000 });
  });

  it("probes the selected model through the OpenAI-compatible models endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "small", context_window: 32_000 },
        { id: "selected", context_window: 1_000_000, max_output_tokens: 64_000 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await probeModelCapacity({
      baseUrl: "https://proxy.example/v1",
      accessToken: "secret",
      modelId: "selected",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, value: { contextWindow: 1_000_000, maxTokens: 64_000 } });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://proxy.example/v1/models"),
      expect.objectContaining({ headers: { authorization: "Bearer secret" } }),
    );
  });

  it("returns no capacity instead of inventing one when the catalog only lists IDs", async () => {
    const result = await probeModelCapacity({
      baseUrl: "https://proxy.example/v1",
      accessToken: "secret",
      modelId: "selected",
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "selected" }] }), { status: 200 }),
    });

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("keeps equal model IDs separated by provider", () => {
    const models = [
      { id: "shared", provider: "cursor", contextWindow: 200_000, maxTokens: 32_000 },
      { id: "shared", provider: "openai", contextWindow: 1_000_000, maxTokens: 128_000 },
    ] as never[];

    expect(largestKnownCapacity("shared", models, "cursor")).toEqual({
      contextWindow: 200_000,
      maxTokens: 32_000,
    });
  });
});

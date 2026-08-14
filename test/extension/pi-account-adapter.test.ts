import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AccountRef } from "../../src/shared/types.ts";
import { PiAccountAdapter } from "../../src/extension/pi-account-adapter.ts";

function knownModel(id: string, contextWindow: number, maxTokens: number): Model<any> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

describe("PiAccountAdapter", () => {
  it("applies a stored reverse-proxy account to an existing Pi provider", () => {
    const registerProvider = vi.fn();
    const adapter = new PiAccountAdapter({ registerProvider } as unknown as ExtensionAPI);

    const result = adapter.apply(
      {
        id: "a1",
        provider: "openai",
        label: "Codex reverse proxy",
        status: "active",
        defaultModel: "gpt-5.6-terra",
      },
      { accessToken: "cpa_secret", baseUrl: "https://proxy.example/v1" },
      true,
    );

    expect(result.ok).toBe(true);
    expect(registerProvider).toHaveBeenCalledWith("openai", {
      name: "Codex reverse proxy",
      apiKey: "cpa_secret",
      baseUrl: "https://proxy.example/v1",
    });
  });

  it("supplies the complete Cursor provider contract when replacing its model catalog", () => {
    const registerProvider = vi.fn();
    const adapter = new PiAccountAdapter({ registerProvider } as unknown as ExtensionAPI);

    const result = adapter.apply(
      {
        id: "cursor-1",
        provider: "cursor",
        label: "Cursor SDK",
        status: "active",
        authKind: "api_key",
      },
      { accessToken: "cursor-secret" },
      true,
      [],
      [{
        id: "grok-4.6",
        name: "Cursor Grok 4.6",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 16_384,
      }],
    );

    expect(result.ok).toBe(true);
    expect(registerProvider).toHaveBeenCalledWith("cursor", expect.objectContaining({
      apiKey: "cursor-secret",
      api: "cursor-sdk",
      baseUrl: "https://cursor.com",
      models: [expect.objectContaining({ id: "grok-4.6" })],
    }));
  });

  it("requires endpoint and model facts before registering an unknown custom provider", () => {
    const registerProvider = vi.fn();
    const adapter = new PiAccountAdapter({ registerProvider } as unknown as ExtensionAPI);

    const result = adapter.apply(
      { id: "d1", provider: "deepseek", label: "DeepSeek", status: "active" },
      { accessToken: "secret" },
      false,
    );

    expect(result.ok).toBe(false);
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("uses the imported model capacity instead of silently forcing every custom model to 128K", () => {
    const registerProvider = vi.fn();
    const adapter = new PiAccountAdapter({ registerProvider } as unknown as ExtensionAPI);
    const account = {
      id: "custom-1",
      provider: "my-proxy",
      label: "My proxy",
      status: "active",
      defaultModel: "large-model",
      endpoint: {
        baseUrl: "https://proxy.example/v1",
        model: "large-model",
        contextWindow: 1_000_000,
        maxTokens: 64_000,
      },
    } as AccountRef;

    const result = adapter.apply(
      account,
      { accessToken: "secret", baseUrl: "https://proxy.example/v1" },
      false,
    );

    expect(result.ok).toBe(true);
    expect(registerProvider).toHaveBeenCalledWith("my-proxy", expect.objectContaining({
      models: [expect.objectContaining({ contextWindow: 1_000_000, maxTokens: 64_000 })],
    }));
  });

  it("reuses the largest known capacity for a same-id reverse-proxy model", () => {
    const registerProvider = vi.fn();
    const adapter = new PiAccountAdapter({ registerProvider } as unknown as ExtensionAPI);
    const account = {
      id: "custom-2",
      provider: "my-proxy",
      label: "My proxy",
      status: "active",
      defaultModel: "shared-model",
    } as AccountRef;
    const applyWithCatalog = adapter.apply as unknown as (
      account: AccountRef,
      credentials: { accessToken: string; baseUrl: string },
      providerAlreadyExists: boolean,
      knownModels: readonly Model<any>[],
    ) => ReturnType<PiAccountAdapter["apply"]>;

    const result = applyWithCatalog.call(
      adapter,
      account,
      { accessToken: "secret", baseUrl: "https://proxy.example/v1" },
      false,
      [knownModel("shared-model", 128_000, 16_000), knownModel("shared-model", 1_000_000, 64_000)],
    );

    expect(result.ok).toBe(true);
    expect(registerProvider).toHaveBeenCalledWith("my-proxy", expect.objectContaining({
      models: [expect.objectContaining({ contextWindow: 1_000_000, maxTokens: 64_000 })],
    }));
  });
});

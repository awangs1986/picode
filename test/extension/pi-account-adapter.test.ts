import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PiAccountAdapter } from "../../src/extension/pi-account-adapter.ts";

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
});

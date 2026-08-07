import { describe, expect, it } from "vitest";
import { parseAccountJson } from "../../src/extension/account-source-scanner.ts";

describe("parseAccountJson", () => {
  it("extracts an official Codex OAuth snapshot without leaking tokens into its summary", () => {
    const result = parseAccountJson("codex", JSON.stringify({
      tokens: {
        access_token: "access-secret",
        refresh_token: "refresh-secret",
      },
      email: "dev@example.com",
    }), "auth.json");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider: "openai-codex",
      label: "dev@example.com",
      source: "auth.json",
    });
    expect(JSON.stringify(result[0]?.summary)).not.toContain("secret");
    expect(result[0]?.credentials.accessToken).toBe("access-secret");
  });

  it("extracts Claude OAuth and generic custom API JSON", () => {
    const claude = parseAccountJson("claude", JSON.stringify({
      claudeAiOauth: { accessToken: "claude-access", refreshToken: "claude-refresh", expiresAt: 9 },
      oauthAccount: { emailAddress: "claude@example.com" },
    }), "claude.json");
    const custom = parseAccountJson("custom", JSON.stringify({
      provider: "deepseek",
      label: "DeepSeek",
      apiKey: "deep-key",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    }), "custom.json");

    expect(claude[0]).toMatchObject({ provider: "anthropic", label: "claude@example.com" });
    expect(custom[0]).toMatchObject({ provider: "deepseek", defaultModel: "deepseek-chat" });
  });
});

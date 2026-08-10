import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAccountJson, scanLocalAccountCandidates } from "../../src/extension/account-source-scanner.ts";

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
      context_window: 128_000,
      max_output_tokens: 8_192,
    }), "custom.json");

    expect(claude[0]).toMatchObject({ provider: "anthropic", label: "claude@example.com" });
    expect(custom[0]).toMatchObject({
      provider: "deepseek",
      defaultModel: "deepseek-chat",
      endpoint: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", contextWindow: 128_000, maxTokens: 8_192 },
    });
  });

  it("imports a Codex API key together with its configured reverse-proxy endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "picode-codex-proxy-account-"));
    try {
      const codexHome = join(root, ".codex");
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "proxy-secret" }));
      writeFileSync(join(codexHome, "config.toml"), [
        'model = "gpt-5.6-terra"',
        'model_provider = "codex-proxy"',
        'openai_base_url = "https://proxy.example/v1"',
      ].join("\n"));

      const result = await scanLocalAccountCandidates({
        home: join(root, "home"),
        env: { CODEX_HOME: codexHome },
      });

      expect(result).toContainEqual(expect.objectContaining({
        provider: "openai",
        piProvider: "openai",
        defaultModel: "gpt-5.6-terra",
        endpoint: expect.objectContaining({
          baseUrl: "https://proxy.example/v1",
          model: "gpt-5.6-terra",
        }),
        credentials: expect.objectContaining({ baseUrl: "https://proxy.example/v1" }),
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores Cursor Desktop OAuth for backup but only marks SDK API keys chat compatible", () => {
    const oauth = parseAccountJson("cursor", JSON.stringify({
      accessToken: "cursor-oauth",
      refreshToken: "cursor-refresh",
      email: "dev@example.com",
    }), "cursor-auth.json");
    const sdk = parseAccountJson("cursor", JSON.stringify({
      CURSOR_API_KEY: "cursor-sdk-key",
      label: "Cursor SDK",
    }), "cursor-sdk.json");

    expect(oauth[0]).toMatchObject({
      authKind: "oauth",
      chatCompatible: false,
      piProvider: "cursor",
    });
    expect(oauth[0]?.warnings.join(" ")).toMatch(/backup/i);
    expect(sdk[0]).toMatchObject({
      authKind: "api_key",
      chatCompatible: true,
      piProvider: "cursor",
    });
  });

  it("discovers the real Windows Cursor Desktop auth location", async () => {
    const root = mkdtempSync(join(tmpdir(), "picode-cursor-account-"));
    try {
      const appData = join(root, "AppData", "Roaming");
      const cursorDir = join(appData, "Cursor");
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(join(cursorDir, "auth.json"), JSON.stringify({
        accessToken: "cursor-oauth-secret",
        refreshToken: "cursor-refresh-secret",
      }));

      const result = await scanLocalAccountCandidates({
        home: join(root, "home"),
        env: { APPDATA: appData },
      });

      expect(result.find((item) => item.provider === "cursor")).toMatchObject({
        provider: "cursor",
        authKind: "oauth",
        chatCompatible: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never offers credentials owned by Picode or its vendored Pi /login store", async () => {
    const root = mkdtempSync(join(tmpdir(), "picode-owned-account-"));
    try {
      const home = join(root, "home");
      const externalCursor = join(home, ".cursor");
      const picodeAgent = join(home, ".picode", "agent");
      const configuredAgent = join(root, "configured-agent");
      for (const directory of [externalCursor, picodeAgent, configuredAgent]) {
        mkdirSync(directory, { recursive: true });
      }
      writeFileSync(join(externalCursor, "auth.json"), JSON.stringify({
        accessToken: "external-cursor-token",
      }));
      writeFileSync(join(picodeAgent, "auth.json"), JSON.stringify({
        accessToken: "picode-login-token",
      }));
      writeFileSync(join(configuredAgent, "auth.json"), JSON.stringify({
        accessToken: "configured-pi-login-token",
      }));

      const result = await scanLocalAccountCandidates({
        home,
        env: { PI_CODING_AGENT_DIR: configuredAgent },
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.credentials.accessToken).toBe("external-cursor-token");
      expect(result[0]?.source).toBe(join(externalCursor, "auth.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

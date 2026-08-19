import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountsManager } from "../../src/store/accounts.ts";
import {
  registerSubagentProviderAdapter,
  registerSubagentWindowsShell,
} from "../../src/extension/subagent-provider-entry.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";
import { DEFAULT_CONFIG, saveConfig } from "../../src/store/config.ts";
import { saveCapabilitySettings } from "../../src/store/capabilities.ts";
import { digestManifest } from "../../src/guard/catalog.ts";
import {
  GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID,
  GOOGLE_SEARCH_SUBAGENT_MANIFEST,
} from "../../src/extension/google-search-manifest.ts";

describe("subagent provider adapter", () => {
  it("registers the Picode PowerShell tool for a Windows child session", async () => {
    const handlers = new Map<string, (event: unknown, ctx: { cwd: string }) => unknown>();
    const registerTool = vi.fn();
    const pi = {
      on: vi.fn((name: string, handler: (event: unknown, ctx: { cwd: string }) => unknown) => {
        handlers.set(name, handler);
      }),
      registerTool,
    } as unknown as ExtensionAPI;

    registerSubagentWindowsShell(pi, "win32", { registerProvider: false });
    await handlers.get("session_start")?.({}, { cwd: "D:/repo/apps/ui" });

    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "bash",
      description: expect.stringContaining("PowerShell"),
    }));
  });

  it("projects the active Picode account into a child Pi process", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const imported = await accounts.importMany([{
        stableId: "team-proxy",
        provider: "openai",
        piProvider: "openai",
        label: "Team proxy",
        authKind: "api_key",
        chatCompatible: true,
        defaultModel: "gpt-5.6-sol",
        credentials: {
          accessToken: "test-secret",
          baseUrl: "https://proxy.example/v1",
        },
      }], "team-proxy");
      expect(imported.ok).toBe(true);

      const registerProvider = vi.fn();
      await registerSubagentProviderAdapter(
        { registerProvider } as unknown as ExtensionAPI,
        { accounts, registerCursor: vi.fn(async () => {}) },
      );

      expect(registerProvider).toHaveBeenCalledWith("openai", {
        name: "Team proxy",
        apiKey: "test-secret",
        baseUrl: "https://proxy.example/v1",
      });
    });
  });

  it("loads the pinned Cursor adapter only when Cursor is the active child provider", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const imported = await accounts.importMany([{
        stableId: "cursor-api",
        provider: "cursor",
        piProvider: "cursor",
        label: "Cursor",
        authKind: "api_key",
        chatCompatible: true,
        credentials: { accessToken: "cursor-test-secret" },
      }], "cursor-api");
      expect(imported.ok).toBe(true);

      const registerCursor = vi.fn(async () => {});
      await registerSubagentProviderAdapter(
        { registerProvider: vi.fn() } as unknown as ExtensionAPI,
        { accounts, registerCursor },
      );

      expect(registerCursor).toHaveBeenCalledOnce();
    });
  });

  it("projects the configured stored Google research account without making it globally active", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const imported = await accounts.importCredentials({
        stableId: "research",
        provider: "google",
        piProvider: "google",
        label: "Research Gemini",
        credentials: { accessToken: "google-test-key" },
      });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      expect((await saveConfig({
        ...structuredClone(DEFAULT_CONFIG),
        googleSearchSubagent: {
          ...structuredClone(DEFAULT_CONFIG.googleSearchSubagent),
          accountId: imported.value.id,
          model: "google/gemini-test",
        },
      })).ok).toBe(true);
      expect((await saveCapabilitySettings([{
        id: GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID,
        enabled: true,
        trustedDigest: digestManifest(GOOGLE_SEARCH_SUBAGENT_MANIFEST),
      }])).ok).toBe(true);

      const registerProvider = vi.fn();
      await registerSubagentProviderAdapter(
        { registerProvider } as unknown as ExtensionAPI,
        { accounts, registerCursor: vi.fn(async () => {}) },
      );

      expect(registerProvider).toHaveBeenCalledWith("google", {
        name: "Research Gemini",
        apiKey: "google-test-key",
      });
    });
  });

  it("does not read or project the retained Google account while the capability is Disabled", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const imported = await accounts.importCredentials({
        stableId: "disabled-research",
        provider: "google",
        piProvider: "google",
        label: "Disabled Research Gemini",
        credentials: { accessToken: "must-not-be-projected" },
      });
      expect(imported.ok).toBe(true);
      if (!imported.ok) return;
      expect((await saveConfig({
        ...structuredClone(DEFAULT_CONFIG),
        googleSearchSubagent: {
          ...structuredClone(DEFAULT_CONFIG.googleSearchSubagent),
          accountId: imported.value.id,
          model: "google/gemini-test",
        },
      })).ok).toBe(true);
      expect((await saveCapabilitySettings([{
        id: GOOGLE_SEARCH_SUBAGENT_CAPABILITY_ID,
        enabled: false,
        trustedDigest: digestManifest(GOOGLE_SEARCH_SUBAGENT_MANIFEST),
      }])).ok).toBe(true);

      const registerProvider = vi.fn();
      await registerSubagentProviderAdapter(
        { registerProvider } as unknown as ExtensionAPI,
        { accounts, registerCursor: vi.fn(async () => {}) },
      );

      expect(registerProvider).not.toHaveBeenCalled();
    });
  });
});

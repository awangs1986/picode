import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { AccountsManager } from "../../src/store/accounts.ts";
import { registerCursorSdkAdapter } from "../../src/extension/cursor-sdk-entry.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("Picode Cursor SDK adapter", () => {
  it("does not expose the SDK fallback catalog without an active Cursor account", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const providers = new Map<string, ProviderConfig>();
      const pi = {
        registerCommand() {},
        registerProvider(name: string, config: ProviderConfig) {
          providers.set(name, { ...providers.get(name), ...config });
        },
      } as unknown as ExtensionAPI;
      const loadSdk = vi.fn(async () => async (api: ExtensionAPI) => {
        api.registerProvider("cursor", {
          name: "Cursor",
          baseUrl: "https://cursor.com",
          apiKey: "pi-cursor-sdk-cursor-api-key-placeholder",
          api: "cursor-sdk",
          models: [{
            id: "grok-fallback-must-not-leak",
            name: "Fallback model",
            api: "cursor-sdk",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 16_384,
          }],
        });
      });
      const loadModels = vi.fn(async () => ({ models: [] }));

      await registerCursorSdkAdapter(pi, { accounts, loadSdk, loadModels });

      expect(loadSdk).toHaveBeenCalledOnce();
      expect(loadModels).not.toHaveBeenCalled();
      expect(providers.get("cursor")).toMatchObject({
        api: "cursor-sdk",
        models: [],
      });
    });
  });

  it("restores the cached live catalog from the active Vault account during startup", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const imported = await accounts.importMany([{
        stableId: "cursor-sdk",
        provider: "cursor",
        piProvider: "cursor",
        label: "Cursor SDK",
        authKind: "api_key",
        chatCompatible: true,
        credentials: { accessToken: "cursor-vault-key" },
      }], "cursor-sdk");
      expect(imported.ok).toBe(true);

      const providers = new Map<string, ProviderConfig>();
      const pi = {
        registerCommand() {},
        registerProvider(name: string, config: ProviderConfig) {
          providers.set(name, { ...providers.get(name), ...config });
        },
      } as unknown as ExtensionAPI;
      const loadSdk = vi.fn(async () => async (api: ExtensionAPI) => {
        api.registerProvider("cursor", {
          name: "Cursor",
          baseUrl: "https://cursor.com",
          apiKey: "pi-cursor-sdk-cursor-api-key-placeholder",
          api: "cursor-sdk",
          models: [{
            id: "grok-4.5",
            name: "Grok 4.5",
            api: "cursor-sdk",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 16_384,
          }],
        });
      });
      const loadModels = vi.fn(async () => ({
        models: [{
          id: "grok-4.6",
          name: "Grok 4.6",
          api: "cursor-sdk" as const,
          reasoning: true,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 16_384,
        }],
      }));

      await registerCursorSdkAdapter(pi, { accounts, loadSdk, loadModels });

      expect(loadModels).toHaveBeenCalledWith("cursor-vault-key");
      expect(providers.get("cursor")).toMatchObject({
        apiKey: "cursor-vault-key",
        models: [expect.objectContaining({ id: "grok-4.6" })],
      });
    });
  });

  it("keeps one refresh command and re-registers live models with the Vault key", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const imported = await accounts.importMany([{
        stableId: "cursor-sdk",
        provider: "cursor",
        piProvider: "cursor",
        label: "Cursor SDK",
        authKind: "api_key",
        chatCompatible: true,
        credentials: { accessToken: "cursor-vault-key" },
      }], "cursor-sdk");
      expect(imported.ok).toBe(true);

      const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
      const providers = new Map<string, ProviderConfig>();
      const pi = {
        registerCommand(name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) {
          commands.set(name, command);
        },
        registerProvider(name: string, config: ProviderConfig) {
          providers.set(name, { ...providers.get(name), ...config });
        },
      } as unknown as ExtensionAPI;
      const upstreamRefresh = vi.fn(async () => {});
      const loadSdk = vi.fn(async () => async (api: ExtensionAPI) => {
        api.registerCommand("cursor-refresh-models", {
          description: "upstream refresh",
          handler: upstreamRefresh,
        });
        api.registerProvider("cursor", {
          name: "Cursor",
          apiKey: "pi-cursor-sdk-cursor-api-key-placeholder",
          api: "cursor-sdk",
          models: [],
        });
      });
      const refreshModels = vi.fn(async () => ({
        models: [{
          id: "grok-4.6",
          name: "Grok 4.6",
          api: "cursor-sdk" as const,
          reasoning: true,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 16_384,
        }],
      }));

      await registerCursorSdkAdapter(pi, {
        accounts,
        loadSdk,
        loadModels: async () => ({ models: [] }),
        refreshModels,
      });

      expect(commands.size).toBe(1);
      const notify = vi.fn();
      const ctx = {
        hasUI: true,
        ui: { notify },
        modelRegistry: {
          getAll: () => [{ id: "grok-4.5", provider: "cursor" }],
        },
      } as unknown as ExtensionCommandContext;
      await commands.get("cursor-refresh-models")?.handler("", ctx);

      expect(upstreamRefresh).not.toHaveBeenCalled();
      expect(refreshModels).toHaveBeenCalledWith("cursor-vault-key");
      expect(providers.get("cursor")).toMatchObject({
        apiKey: "cursor-vault-key",
        models: [expect.objectContaining({ id: "grok-4.6" })],
      });
      expect(notify).toHaveBeenCalledWith(
        "Cursor model catalog refreshed with 1 model.",
        "info",
      );
    });
  });
});

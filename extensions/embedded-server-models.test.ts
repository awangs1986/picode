// @vitest-environment node

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildModelCatalog,
  getAvailableModelsForRpc,
  loadProviderCatalogPolicies,
  ModelPreferencesStore,
  sanitizeHealthError,
} from "./embedded-server.ts";

describe("embedded server model listing", () => {
  it("recognizes an imported Codex reverse proxy and reads Codex's visible catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "picot-model-policy-"));
    const modelsPath = join(root, "models.json");
    const cachePath = join(root, "models_cache.json");
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          openai: {
            name: "Codex reverse proxy",
            baseUrl: "https://proxy.example/v1",
          },
        },
      }),
    );
    writeFileSync(
      cachePath,
      JSON.stringify({
        models: [
          { slug: "gpt-5.6-terra", visibility: "list" },
          { slug: "codex-auto-review", visibility: "hide" },
        ],
      }),
    );

    const policy = loadProviderCatalogPolicies(modelsPath, cachePath).get("openai");

    expect(policy?.kind).toBe("codex-proxy");
    expect(policy?.endpointLabel).toBe("proxy.example");
    expect(policy ? [...policy.recommendedModelIds].sort() : []).toEqual([
      "gpt-5.2",
      "gpt-5.6-terra",
    ]);
  });

  it("keeps newly discovered models out of the picker until the user enables them", async () => {
    const models = [{ provider: "cursor", id: "gpt-5.6" }];
    const store = new ModelPreferencesStore(
      join(mkdtempSync(join(tmpdir(), "picot-models-")), "prefs.json"),
    );

    await expect(
      getAvailableModelsForRpc(null, { getAvailable: async () => models }, store),
    ).resolves.toEqual([]);
  });

  it("keeps equal model ids independently selectable for different agent providers", async () => {
    const models = [
      { provider: "cursor", id: "gpt-5.6" },
      { provider: "openai-codex", id: "gpt-5.6" },
    ];
    const store = new ModelPreferencesStore(
      join(mkdtempSync(join(tmpdir(), "picot-models-")), "prefs.json"),
    );
    store.setVisibility("cursor", "gpt-5.6", true);
    store.setVisibility("openai-codex", "gpt-5.6", true);

    await expect(
      getAvailableModelsForRpc(null, { getAvailable: async () => models }, store),
    ).resolves.toEqual(models);
  });

  it("does not present Cursor's representative effort as part of the model name", async () => {
    const store = new ModelPreferencesStore(
      join(mkdtempSync(join(tmpdir(), "picot-models-")), "prefs.json"),
    );
    const models = [
      {
        provider: "cursor",
        id: "gpt-5.6-terra-max-fast",
        name: "GPT-5.6 Terra Max Medium Fast",
        reasoning: true,
        thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
      },
      {
        provider: "cursor",
        id: "kimi-k3-max",
        name: "Kimi K3 Max Low",
        reasoning: true,
        thinkingLevelMap: { low: "low", high: "high" },
      },
    ];
    for (const model of models) store.setVisibility(model.provider, model.id, true);
    const registry = {
      getAll: () => models,
      getAvailable: async () => models,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getProviderDisplayName: () => "Cursor",
    };

    const available = await getAvailableModelsForRpc(null, registry, store);
    const catalog = await buildModelCatalog(registry, store);

    expect(available.map((model) => model.name)).toEqual(["GPT-5.6 Terra Max Fast", "Kimi K3 Max"]);
    expect(catalog.providers[0].models.map((model) => model.name)).toEqual([
      "GPT-5.6 Terra Max Fast",
      "Kimi K3 Max",
    ]);
  });

  it("defaults Codex reverse proxies to the recommended intersection", async () => {
    const store = new ModelPreferencesStore(
      join(mkdtempSync(join(tmpdir(), "picot-models-")), "prefs.json"),
    );
    const models = [
      { provider: "openai", id: "gpt-4" },
      { provider: "openai", id: "gpt-5.2" },
      { provider: "openai", id: "gpt-5.6-terra" },
    ];
    const registry = {
      getAll: () => models,
      getAvailable: async () => models,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getProviderDisplayName: () => "Codex reverse proxy",
    };
    const policies = new Map([
      [
        "openai",
        {
          kind: "codex-proxy",
          recommendedModelIds: new Set(["gpt-5.2", "gpt-5.6-terra"]),
          endpointLabel: "awangsawangs.xyz",
        },
      ],
    ]);

    const catalog = await buildModelCatalog(registry, store, policies);

    expect(catalog.providers[0]).toMatchObject({
      provider: "openai",
      catalogMode: "recommended",
      catalogPolicy: "codex-proxy",
      endpointLabel: "awangsawangs.xyz",
    });
    expect(catalog.providers[0].models.map((model) => model.id)).toEqual([
      "gpt-5.2",
      "gpt-5.6-terra",
    ]);
  });

  it("supports all and manual Codex proxy catalog modes independently", async () => {
    const store = new ModelPreferencesStore(
      join(mkdtempSync(join(tmpdir(), "picot-models-")), "prefs.json"),
    );
    const models = [
      { provider: "openai", id: "gpt-4" },
      { provider: "openai", id: "gpt-5.6-terra" },
    ];
    const registry = {
      getAll: () => models,
      getAvailable: async () => models,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getProviderDisplayName: () => "Codex reverse proxy",
    };
    const policies = new Map([
      ["openai", { kind: "codex-proxy", recommendedModelIds: new Set(["gpt-5.6-terra"]) }],
    ]);

    store.setCatalogMode("openai", "all");
    let catalog = await buildModelCatalog(registry, store, policies);
    expect(catalog.providers[0].models.map((model) => model.id)).toEqual([
      "gpt-4",
      "gpt-5.6-terra",
    ]);

    store.setCatalogMode("openai", "manual");
    store.setManualModel("openai", "gpt-4", true);
    catalog = await buildModelCatalog(registry, store, policies);
    expect(catalog.providers[0].models.map((model) => model.id)).toEqual(["gpt-4"]);
  });

  it("uses the cached model registry when session context is unavailable", async () => {
    const models = [{ provider: "anthropic", id: "claude-sonnet-5" }];
    const registry = {
      getAvailable: async () => models,
    };
    const store = new ModelPreferencesStore(
      join(mkdtempSync(join(tmpdir(), "picot-models-")), "prefs.json"),
    );
    store.setVisibility("anthropic", "claude-sonnet-5", true);

    await expect(getAvailableModelsForRpc(null, registry, store)).resolves.toEqual(models);
  });

  it("excludes hidden models from the available model RPC list", async () => {
    const models = [
      { provider: "anthropic", id: "claude-sonnet-5" },
      { provider: "anthropic", id: "claude-opus-5" },
    ];
    const store = new ModelPreferencesStore(
      join(mkdtempSync(join(tmpdir(), "picot-models-")), "prefs.json"),
    );
    store.setVisibility("anthropic", "claude-sonnet-5", true);
    store.setVisibility("anthropic", "claude-opus-5", false);

    await expect(
      getAvailableModelsForRpc(
        null,
        {
          getAvailable: async () => models,
        },
        store,
      ),
    ).resolves.toEqual([{ provider: "anthropic", id: "claude-sonnet-5" }]);
  });

  it("builds a catalog with only auth-available models, visibility, and health", async () => {
    const store = new ModelPreferencesStore(
      join(mkdtempSync(join(tmpdir(), "picot-models-")), "prefs.json"),
    );
    store.setVisibility("anthropic", "claude-opus-5", false);
    store.setVisibility("anthropic", "claude-sonnet-5", true);
    store.setHealth("anthropic", "claude-sonnet-5", {
      status: "healthy",
      checkedAt: "2026-07-08T00:00:00.000Z",
      latencyMs: 12,
    });
    const registry = {
      getAll: () => [
        { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 200000 },
        { provider: "anthropic", id: "claude-opus-5", contextWindow: 200000 },
        { provider: "openai", id: "gpt-4.1" },
      ],
      getAvailable: async () => [
        { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 200000 },
        { provider: "openai", id: "gpt-4.1" },
      ],
      getProviderAuthStatus: (provider: string) => ({
        configured: provider !== "openai",
        source: provider === "anthropic" ? "stored" : undefined,
      }),
      getProviderDisplayName: (provider: string) =>
        provider === "anthropic" ? "Anthropic" : provider,
    };

    await expect(buildModelCatalog(registry, store)).resolves.toEqual({
      providers: [
        {
          provider: "anthropic",
          displayName: "Anthropic",
          configured: true,
          source: "stored",
          label: undefined,
          models: [
            {
              provider: "anthropic",
              id: "claude-sonnet-5",
              name: undefined,
              contextWindow: 200000,
              available: true,
              visible: true,
              health: {
                status: "healthy",
                checkedAt: "2026-07-08T00:00:00.000Z",
                latencyMs: 12,
              },
            },
          ],
        },
        {
          provider: "openai",
          displayName: "openai",
          configured: false,
          source: undefined,
          label: undefined,
          models: [
            {
              provider: "openai",
              id: "gpt-4.1",
              name: undefined,
              contextWindow: undefined,
              available: true,
              visible: false,
              health: { status: "unknown" },
            },
          ],
        },
      ],
    });
  });

  it("keeps no-key providers but omits their model rows", async () => {
    const store = new ModelPreferencesStore(
      join(mkdtempSync(join(tmpdir(), "picot-models-")), "prefs.json"),
    );
    const registry = {
      getAll: () => [
        { provider: "anthropic", id: "claude-sonnet-5" },
        { provider: "openai", id: "gpt-4.1" },
      ],
      getAvailable: async () => [{ provider: "anthropic", id: "claude-sonnet-5" }],
      getProviderAuthStatus: (provider: string) => ({
        configured: provider === "anthropic",
        source: provider === "anthropic" ? "stored" : undefined,
      }),
      getProviderDisplayName: (provider: string) => provider,
    };

    const catalog = await buildModelCatalog(registry, store);

    expect(catalog.providers.find((p) => p.provider === "openai")?.models).toEqual([]);
  });

  it("persists model visibility preferences", () => {
    const path = join(mkdtempSync(join(tmpdir(), "picot-models-")), "prefs.json");
    const first = new ModelPreferencesStore(path);
    expect(first.isVisible("anthropic", "claude-opus-5")).toBe(false);
    first.setVisibility("anthropic", "claude-opus-5", true);

    const second = new ModelPreferencesStore(path);

    expect(second.isVisible("anthropic", "claude-opus-5")).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      visibility: { "anthropic/claude-opus-5": true },
    });
  });

  it("sanitizes health errors before storing or returning them", () => {
    expect(
      sanitizeHealthError("Request failed with key sk-ant-1234567890 and bearer abcdefghij"),
    ).toBe("Request failed with key [REDACTED] and bearer [REDACTED]");
  });
});

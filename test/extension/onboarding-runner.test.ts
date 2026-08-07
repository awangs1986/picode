import { describe, expect, it, vi } from "vitest";
import { CapabilityCatalog } from "../../src/guard/catalog.ts";
import { DEFAULT_CONFIG } from "../../src/store/config.ts";
import {
  ONBOARDING_MANIFESTS,
  runOnboardingFlow,
} from "../../src/extension/onboarding-runner.ts";
import { err, ok } from "../../src/shared/types.ts";

function catalogWithOnboarding(): CapabilityCatalog {
  const catalog = new CapabilityCatalog();
  for (const manifest of ONBOARDING_MANIFESTS) catalog.register(manifest);
  return catalog;
}

describe("runOnboardingFlow", () => {
  it("asks three localized questions separately and persists the final facts", async () => {
    const catalog = catalogWithOnboarding();
    const confirm = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const persistConfig = vi.fn(async () => ok(undefined));
    const persistCapabilities = vi.fn(async () => ok(undefined));

    const result = await runOnboardingFlow({
      config: structuredClone(DEFAULT_CONFIG),
      catalog,
      confirm,
      persistConfig,
      persistCapabilities,
    });

    expect(result.ok).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(confirm.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining("mattpocock/skills"),
      expect.stringContaining("Herdr"),
      expect.stringContaining("CodebaseMemoryProvider"),
    ]);
    expect(catalog.get("mattpocock-skills")?.setting).toBe("trusted");
    expect(catalog.get("herdr")?.setting).toBe("disabled");
    expect(catalog.get("codebase-memory-provider")?.setting).toBe("trusted");
    expect(persistConfig).toHaveBeenCalledOnce();
    expect(persistCapabilities).toHaveBeenCalledWith(catalog.toJSON());
  });

  it("does not report completion when capability settings cannot be persisted", async () => {
    const result = await runOnboardingFlow({
      config: structuredClone(DEFAULT_CONFIG),
      catalog: catalogWithOnboarding(),
      confirm: async () => true,
      persistConfig: async () => ok(undefined),
      persistCapabilities: async () => err("store/write", "disk full"),
    });

    expect(result).toEqual(err("store/write", "disk full"));
  });
});

import { describe, expect, it, vi } from "vitest";
import { CapabilityCatalog } from "../../src/guard/catalog.ts";
import { runRecommendedReinstall } from "../../src/extension/reinstall-command.ts";
import { ok } from "../../src/shared/types.ts";
import { makeManifest } from "../helpers/fixtures.ts";

function installedCatalog(): CapabilityCatalog {
  const catalog = new CapabilityCatalog();
  catalog.register(makeManifest({ id: "herdr", title: "Herdr" }), "trusted");
  catalog.register(makeManifest({ id: "codebase-memory-provider", title: "CodebaseMemoryProvider" }), "trusted");
  return catalog;
}

describe("/reinstall recommended components", () => {
  it("does not prompt or write when all three recommendations are already installed", async () => {
    const confirm = vi.fn(async () => true);
    const persistCapabilities = vi.fn(async () => ok(undefined));
    const installMattPocock = vi.fn(() => ok(undefined));

    const result = await runRecommendedReinstall({
      locale: "zh",
      catalog: installedCatalog(),
      confirm,
      mattPocockInstalled: () => true,
      installMattPocock,
      persistCapabilities,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        prompted: [],
        installed: [],
        alreadyInstalled: ["mattpocock-skills", "herdr", "codebase-memory-provider"],
        declined: [],
      },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(installMattPocock).not.toHaveBeenCalled();
    expect(persistCapabilities).not.toHaveBeenCalled();
  });

  it("prompts only missing recommendations separately and applies each answer", async () => {
    const catalog = new CapabilityCatalog();
    catalog.register(makeManifest({ id: "herdr", title: "Herdr" }), "disabled");
    catalog.register(makeManifest({ id: "codebase-memory-provider", title: "CodebaseMemoryProvider" }), "disabled");
    const confirm = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const installMattPocock = vi.fn(() => ok(undefined));
    const persistCapabilities = vi.fn(async () => ok(undefined));

    const result = await runRecommendedReinstall({
      locale: "zh",
      catalog,
      confirm,
      mattPocockInstalled: () => false,
      installMattPocock,
      persistCapabilities,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        prompted: ["mattpocock-skills", "herdr", "codebase-memory-provider"],
        installed: ["mattpocock-skills", "codebase-memory-provider"],
        alreadyInstalled: [],
        declined: ["herdr"],
      },
    });
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(confirm.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining("mattpocock/skills"),
      expect.stringContaining("Herdr"),
      expect.stringContaining("CodebaseMemoryProvider"),
    ]);
    expect(installMattPocock).toHaveBeenCalledOnce();
    expect(catalog.get("herdr")?.setting).toBe("disabled");
    expect(catalog.get("codebase-memory-provider")?.setting).toBe("trusted");
    expect(persistCapabilities).toHaveBeenCalledOnce();
  });
});

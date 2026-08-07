import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SUITE_ENTRIES,
  loadSuiteForTier,
  suiteForTier,
  suiteRespectsPolicy,
} from "../../src/extension/suite.ts";
import { TIER_POLICIES } from "../../src/extension/harness.ts";

const SUITE_IDS = [
  "pi-web-access",
  "pi-landstrip",
  "pi-mcp-adapter",
  "pi-subagents",
  "pi-plan-mode",
  "pi-goal",
  "pi-cache-optimizer",
  "pi-lens",
] as const;

describe("SUITE_ENTRIES", () => {
  it("contains exactly 8 entries with expected ids", () => {
    expect(SUITE_ENTRIES).toHaveLength(8);
    const ids = SUITE_ENTRIES.map((e) => e.manifest.id).sort();
    expect(ids).toEqual([...SUITE_IDS].sort());
  });
});

describe("suiteForTier", () => {
  it("does not initialize the same vendor twice across sessions in one Pi process", async () => {
    const loaded = new Set<string>();
    const imported: string[] = [];
    const pi = { getAllTools: () => [] } as unknown as ExtensionAPI;
    const importer = async (packageName: string) => {
      imported.push(packageName);
      return { default: () => {} };
    };

    await loadSuiteForTier(pi, "simple", importer, undefined, loaded);
    await loadSuiteForTier(pi, "simple", importer, undefined, loaded);

    expect(imported).toEqual(["pi-web-access", "pi-cache-optimizer"]);
  });

  it("loads only the simple-tier vendors through their extension factories", async () => {
    const imported: string[] = [];
    const activated: string[] = [];
    await loadSuiteForTier({} as ExtensionAPI, "simple", async (packageName) => {
      imported.push(packageName);
      return { default: () => { activated.push(packageName); } };
    });
    expect(imported).toEqual(["pi-web-access", "pi-cache-optimizer"]);
    expect(activated).toEqual(imported);
  });

  it("reports the Pi tools contributed by each loaded vendor", async () => {
    const tools: string[] = ["read", "bash"];
    const mapped: Array<[string, string[]]> = [];
    const pi = {
      getAllTools: () => tools.map((name) => ({ name })),
    } as unknown as ExtensionAPI;

    await loadSuiteForTier(
      pi,
      "simple",
      async (packageName) => ({
        default: () => { tools.push(`${packageName}-tool`); },
      }),
      (entry, names) => { mapped.push([entry.manifest.id, [...names]]); },
    );

    expect(mapped).toEqual([
      ["pi-web-access", ["pi-web-access-tool"]],
      ["pi-cache-optimizer", ["pi-cache-optimizer-tool"]],
    ]);
  });

  it("simple tier loads only pi-web-access and pi-cache-optimizer", () => {
    const ids = suiteForTier("simple").map((e) => e.manifest.id).sort();
    expect(ids).toEqual(["pi-cache-optimizer", "pi-web-access"]);
  });

  it("standard tier includes landstrip, mcp-adapter, subagents, plan, goal but not lens", () => {
    const ids = new Set(suiteForTier("standard").map((e) => e.manifest.id));
    for (const id of [
      "pi-landstrip",
      "pi-mcp-adapter",
      "pi-subagents",
      "pi-plan-mode",
      "pi-goal",
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has("pi-lens")).toBe(false);
  });

  it("tdd tier includes pi-lens", () => {
    const ids = suiteForTier("tdd").map((e) => e.manifest.id);
    expect(ids).toContain("pi-lens");
  });
});

describe("suiteRespectsPolicy", () => {
  it("returns true for all TIER_POLICIES tiers", () => {
    for (const tier of ["simple", "standard", "tdd"] as const) {
      expect(suiteRespectsPolicy(tier, TIER_POLICIES[tier])).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { CapabilityCatalog } from "../../src/guard/catalog.ts";
import { DEFAULT_CONFIG } from "../../src/store/config.ts";
import {
  ONBOARDING_ITEMS,
  applyOnboarding,
  onboardingQuestions,
  reopenOnboarding,
  shouldRunOnboarding,
  skipOnboarding,
} from "../../src/extension/onboarding.ts";
import { makeManifest } from "../helpers/fixtures.ts";

const ONBOARDING_IDS = ["herdr", "codebase-memory-provider"] as const;

function registerOnboardingManifests(catalog: CapabilityCatalog): void {
  for (const id of ONBOARDING_IDS) {
    catalog.register(makeManifest({ id, title: id }), "disabled");
  }
}

describe("ONBOARDING_ITEMS", () => {
  it("has exactly two items with fixed ids", () => {
    expect(ONBOARDING_ITEMS).toHaveLength(2);
    expect(ONBOARDING_ITEMS.map((x) => x.capabilityId)).toEqual([...ONBOARDING_IDS]);
  });
});

describe("onboardingQuestions", () => {
  it("returns separate zh questions with Chinese intro text", () => {
    const qs = onboardingQuestions("zh");
    expect(qs).toHaveLength(2);
    expect(qs.map((q) => q.capabilityId)).toEqual([...ONBOARDING_IDS]);
    expect(qs[0]?.text).toContain("Herdr");
    expect(qs[1]?.text).toContain("CodebaseMemoryProvider");
  });

  it("returns separate en questions with English intro text", () => {
    const qs = onboardingQuestions("en");
    expect(qs).toHaveLength(2);
    expect(qs[0]?.text).toContain("multi-task");
    expect(qs[1]?.text).toContain("repository-level");
  });
});

describe("shouldRunOnboarding", () => {
  it("is true for default config and false after completed", () => {
    expect(shouldRunOnboarding(DEFAULT_CONFIG)).toBe(true);
    expect(
      shouldRunOnboarding({
        ...DEFAULT_CONFIG,
        onboarding: { completed: true },
      }),
    ).toBe(false);
  });
});

describe("applyOnboarding", () => {
  it("trusts both when all answers are true without mutating input config", () => {
    const catalog = new CapabilityCatalog();
    registerOnboardingManifests(catalog);
    const config = structuredClone(DEFAULT_CONFIG);

    const next = applyOnboarding(
      {
        herdr: true,
        "codebase-memory-provider": true,
      },
      catalog,
      config,
    );

    expect(config.onboarding.completed).toBe(false);
    expect(next.onboarding.completed).toBe(true);
    expect(next.onboarding.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const id of ONBOARDING_IDS) {
      expect(catalog.get(id)?.setting).toBe("trusted");
    }
  });

  it("trusts only answered yes items; unanswered treated as no", () => {
    const catalog = new CapabilityCatalog();
    registerOnboardingManifests(catalog);
    const next = applyOnboarding({ herdr: true }, catalog, DEFAULT_CONFIG);

    expect(catalog.get("herdr")?.setting).toBe("trusted");
    expect(catalog.get("codebase-memory-provider")?.setting).toBe("disabled");
    expect(next.onboarding.completed).toBe(true);
  });
});

describe("skipOnboarding", () => {
  it("marks completed without changing catalog settings", () => {
    const catalog = new CapabilityCatalog();
    registerOnboardingManifests(catalog);
    const next = skipOnboarding(DEFAULT_CONFIG);
    expect(next.onboarding.completed).toBe(true);
    for (const id of ONBOARDING_IDS) {
      expect(catalog.get(id)?.setting).toBe("disabled");
    }
  });
});

describe("reopenOnboarding", () => {
  it("allows shouldRunOnboarding to become true again", () => {
    const skipped = skipOnboarding(DEFAULT_CONFIG);
    expect(shouldRunOnboarding(skipped)).toBe(false);
    const reopened = reopenOnboarding(skipped);
    expect(shouldRunOnboarding(reopened)).toBe(true);
  });
});

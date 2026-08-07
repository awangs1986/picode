import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootRuntime,
  createRuntime,
  searchToolsHandler,
} from "../../src/extension/index.ts";
import { DEFAULT_CONFIG } from "../../src/store/config.ts";
import { dataPaths } from "../../src/shared/paths.ts";
import { makeManifest } from "../helpers/fixtures.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

const ctx = { sessionId: "s1", harnessTier: "standard" as const, currentTurn: 1 };

describe("createRuntime P1 composition", () => {
  it("default persistEvidence=false does not write evidence files after registered activation", async () => {
    await withTempPicodeDir(async () => {
      const rt = createRuntime();
      rt.guard.catalog.register(
        makeManifest({ id: "reg-cap", supportsProxyCall: false }),
        "trusted",
      );
      await rt.engine.activate("reg-cap", ctx);

      const evidenceDir = dataPaths.evidence();
      expect(existsSync(evidenceDir)).toBe(false);
    });
  });

  it("residentCapabilities routes trusted capability through resident path even with supportsProxyCall", async () => {
    const rt = createRuntime({
      config: {
        ...structuredClone(DEFAULT_CONFIG),
        residentCapabilities: ["resident-cap"],
      },
    });
    rt.guard.catalog.register(
      makeManifest({ id: "resident-cap", supportsProxyCall: true }),
      "trusted",
    );
    const r = await rt.engine.activate("resident-cap", ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.path).toBe("resident");
  });

  it("account switch increments engine epoch and cacheMeter epoch", async () => {
    await withTempPicodeDir(async () => {
      const rt = createRuntime();
      const added = await rt.accounts.addFromOAuth({
        provider: "github",
        login: async () =>
          ({ ok: true, value: { label: "A", credentials: { accessToken: "t" } } }) as const,
      });
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const epochBefore = rt.engine.currentEpoch();
      const cacheBefore = rt.cacheMeter.snapshot().cacheEpoch;
      await rt.accounts.setActive(added.value.id);
      expect(rt.engine.currentEpoch()).toBe(epochBefore + 1);
      expect(rt.cacheMeter.snapshot().cacheEpoch).toBe(cacheBefore + 1);
    });
  });

  it("harness switchTo tdd increments engine epoch", () => {
    const rt = createRuntime();
    const before = rt.engine.currentEpoch();
    rt.harness.switchTo("tdd");
    expect(rt.engine.currentEpoch()).toBe(before + 1);
    expect(rt.harness.current()).toBe("tdd");
  });

  it("searchToolsHandler end-to-end search and activate", async () => {
    const rt = createRuntime();
    rt.guard.catalog.register(
      makeManifest({
        id: "searchable-cap",
        title: "Searchable",
        keywords: ["alpha"],
        supportsProxyCall: false,
      }),
      "trusted",
    );
    const handler = searchToolsHandler(rt);

    const searchOut = await handler({ action: "search", query: "alpha" }, ctx);
    expect(searchOut).toContain("searchable-cap");

    const activateOut = await handler(
      { action: "activate", capabilityId: "searchable-cap" },
      ctx,
    );
    expect(activateOut).toContain("next turn");
  });
});

describe("bootRuntime", () => {
  it("works in temp PICODE_DIR with default config and persists evidence on activation", async () => {
    await withTempPicodeDir(async () => {
      const rt = bootRuntime();
      expect(rt.config).toEqual(DEFAULT_CONFIG);

      rt.guard.catalog.register(
        makeManifest({ id: "ev-cap", supportsProxyCall: false }),
        "trusted",
      );
      await rt.engine.activate("ev-cap", ctx);

      const evidenceDir = dataPaths.evidence();
      expect(existsSync(evidenceDir)).toBe(true);
      const files = readdirSync(evidenceDir).filter((f) => f.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThan(0);
      const content = readFileSync(join(evidenceDir, files[0]!), "utf8");
      expect(content).toContain("cache-epoch");
    });
  });
});

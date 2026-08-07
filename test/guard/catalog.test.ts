import { describe, expect, it } from "vitest";
import { CapabilityCatalog } from "../../src/guard/catalog.ts";
import { makeManifest } from "../helpers/fixtures.ts";

describe("CapabilityCatalog", () => {
  const manifest = makeManifest({
    id: "fs-tools",
    title: "File System Tools",
    summary: "Read and write files in the workspace",
    keywords: ["filesystem", "read", "write"],
  });

  it("registers with disabled by default", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(manifest);
    expect(catalog.get("fs-tools")?.setting).toBe("disabled");
  });

  it("excludes disabled from search including empty query", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(manifest);
    expect(catalog.search("")).toHaveLength(0);
    expect(catalog.search("filesystem")).toHaveLength(0);
  });

  it("includes enabled and trusted in search", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(manifest, "enabled");
    catalog.register(makeManifest({ id: "other", title: "Other" }), "trusted");
    expect(catalog.search("")).toHaveLength(2);
  });

  it("filters by keywords with multi-word AND, case insensitive", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(manifest, "trusted");
    expect(catalog.search("FILE read")).toHaveLength(1);
    expect(catalog.search("file write")).toHaveLength(1);
    expect(catalog.search("file network")).toHaveLength(0);
  });

  describe("checkActivatable", () => {
    it("returns capability-unknown for disabled and unknown ids", () => {
      const catalog = new CapabilityCatalog();
      catalog.register(manifest);
      for (const id of ["fs-tools", "nonexistent"]) {
        const r = catalog.checkActivatable(id);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("guard/capability-unknown");
      }
    });

    it("returns not-trusted when enabled but not trusted", () => {
      const catalog = new CapabilityCatalog();
      catalog.register(manifest, "enabled");
      const r = catalog.checkActivatable("fs-tools");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("guard/capability-not-trusted");
    });

    it("returns ok when trusted", () => {
      const catalog = new CapabilityCatalog();
      catalog.register(manifest, "trusted");
      expect(catalog.checkActivatable("fs-tools").ok).toBe(true);
    });
  });

  it("returns error on userSetState for unknown id", () => {
    const catalog = new CapabilityCatalog();
    const r = catalog.userSetState("missing", "enabled");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("guard/capability-unknown");
  });

  describe("resolveLive", () => {
    const fsReader = makeManifest({
      id: "fs-reader",
      semanticOperations: ["fs.read@1", "fs.glob@1"],
    });

    it("returns a trusted manifest whose semanticOperations include the query", () => {
      const catalog = new CapabilityCatalog();
      catalog.register(fsReader, "trusted");
      expect(catalog.resolveLive("fs.read@1")?.id).toBe("fs-reader");
      expect(catalog.resolveLive("fs.glob@1")?.id).toBe("fs-reader");
    });

    it("does not return enabled or disabled capabilities", () => {
      for (const setting of ["enabled", "disabled"] as const) {
        const catalog = new CapabilityCatalog();
        catalog.register(fsReader, setting);
        expect(catalog.resolveLive("fs.read@1")).toBeUndefined();
      }
    });

    it("returns undefined when no trusted capability covers the operation", () => {
      const catalog = new CapabilityCatalog();
      catalog.register(fsReader, "trusted");
      catalog.register(makeManifest({ id: "no-ops" }), "trusted");
      expect(catalog.resolveLive("process.exec@1")).toBeUndefined();
    });
  });

  it("round-trips toJSON and restoreSettings", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(manifest, "enabled");
    catalog.register(makeManifest({ id: "proxy-cap" }), "trusted");
    const saved = catalog.toJSON();
    const restored = new CapabilityCatalog();
    restored.register(manifest);
    restored.register(makeManifest({ id: "proxy-cap" }));
    restored.restoreSettings(saved);
    expect(restored.get("fs-tools")?.setting).toBe("enabled");
    expect(restored.get("proxy-cap")?.setting).toBe("trusted");
  });

  it("persists the R3 settings axis as enabled plus a pinned manifest digest", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(manifest, "trusted");

    expect(catalog.toJSON()).toEqual([
      {
        id: "fs-tools",
        enabled: true,
        trustedDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
  });

  it("retains trust while disabled but keeps the capability invisible", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(manifest, "trusted");
    const trustedDigest = catalog.toJSON()[0]?.trustedDigest;

    catalog.userSetState("fs-tools", "disabled");

    expect(catalog.toJSON()).toEqual([
      { id: "fs-tools", enabled: false, trustedDigest },
    ]);
    expect(catalog.search("")).toEqual([]);
  });

  it("invalidates an old trust digest when manifest content changes", () => {
    const original = new CapabilityCatalog();
    original.register(manifest, "trusted");
    const saved = original.toJSON();

    const changed = new CapabilityCatalog();
    changed.register({ ...manifest, summary: "changed manifest content" });
    changed.restoreSettings(saved);

    expect(changed.get("fs-tools")?.setting).toBe("enabled");
    const result = changed.checkActivatable("fs-tools");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("guard/capability-not-trusted");
  });

  it("removes task-bound capabilities without touching global suite entries", () => {
    const catalog = new CapabilityCatalog();
    catalog.register(manifest, "trusted");
    catalog.register(makeManifest({ id: "task:local", origin: "task" }), "trusted");

    catalog.removeByOrigin("task");

    expect(catalog.get("task:local")).toBeUndefined();
    expect(catalog.get("fs-tools")).toBeDefined();
  });
});

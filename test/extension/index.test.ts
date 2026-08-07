import { describe, expect, it } from "vitest";
import { createRuntime, requestActivate } from "../../src/extension/index.ts";
import { makeManifest } from "../helpers/fixtures.ts";

const ctx = { sessionId: "s1", harnessTier: "standard" as const, currentTurn: 1 };

describe("createRuntime + requestActivate", () => {
  it("wires store, guard, engine, devloop, and cacheMeter", () => {
    const rt = createRuntime();
    expect(rt.store).toBeDefined();
    expect(rt.guard).toBeDefined();
    expect(rt.engine).toBeDefined();
    expect(rt.devloop).toBeDefined();
    expect(rt.cacheMeter).toBeDefined();
    expect(rt.cacheMeter.snapshot().cacheEpoch).toBe(1);
  });

  it("returns capability-unknown for disabled capability", async () => {
    const rt = createRuntime();
    rt.guard.catalog.register(makeManifest({ id: "disabled-cap" }));
    const r = await requestActivate(rt, "disabled-cap", ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("guard/capability-unknown");
  });

  it("returns not-trusted for enabled but untrusted capability", async () => {
    const rt = createRuntime();
    rt.guard.catalog.register(makeManifest({ id: "enabled-cap" }), "enabled");
    const r = await requestActivate(rt, "enabled-cap", ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("guard/capability-not-trusted");
  });

  it("activates proxy lease for trusted capability with supportsProxyCall", async () => {
    const rt = createRuntime();
    rt.guard.catalog.register(
      makeManifest({ id: "proxy-cap", supportsProxyCall: true }),
      "trusted",
    );
    const before = rt.cacheMeter.snapshot().cacheEpoch;
    const r = await requestActivate(rt, "proxy-cap", ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("proxy");
      expect(r.value.capabilityId).toBe("proxy-cap");
    }
    expect(rt.cacheMeter.snapshot().cacheEpoch).toBe(before);
  });

  it("activates registered lease and increments cache epoch for non-proxy trusted capability", async () => {
    const rt = createRuntime();
    rt.guard.catalog.register(
      makeManifest({ id: "reg-cap", supportsProxyCall: false }),
      "trusted",
    );
    const before = rt.cacheMeter.snapshot().cacheEpoch;
    const r = await requestActivate(rt, "reg-cap", ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.path).toBe("registered");
      expect(r.value.capabilityId).toBe("reg-cap");
    }
    expect(rt.cacheMeter.snapshot().cacheEpoch).toBe(before + 1);
  });
});

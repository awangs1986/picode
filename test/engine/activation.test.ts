import { describe, expect, it, vi } from "vitest";
import {
  ActivationManager,
  choosePath,
  type ActiveToolAdapter,
} from "../../src/engine/activation.ts";
import { ok } from "../../src/shared/types.ts";
import { makeManifest } from "../helpers/fixtures.ts";

function fakeAdapter(): ActiveToolAdapter & {
  registerCalls: string[];
  deactivateCalls: string[];
} {
  const registerCalls: string[] = [];
  const deactivateCalls: string[] = [];
  return {
    registerCalls,
    deactivateCalls,
    async register(m) {
      registerCalls.push(m.id);
      return ok(undefined);
    },
    async deactivate(id) {
      deactivateCalls.push(id);
      return ok(undefined);
    },
  };
}

const ctx = { sessionId: "s1", harnessTier: "standard" as const, currentTurn: 1 };

describe("choosePath()", () => {
  it("prefers resident when preference is resident", () => {
    const m = makeManifest({ supportsProxyCall: true });
    expect(choosePath(m, "resident")).toBe("resident");
  });

  it("chooses proxy when supportsProxyCall", () => {
    const m = makeManifest({ supportsProxyCall: true });
    expect(choosePath(m, "none")).toBe("proxy");
  });

  it("chooses registered otherwise", () => {
    const m = makeManifest({ supportsProxyCall: false });
    expect(choosePath(m, "none")).toBe("registered");
  });
});

describe("ActivationManager", () => {
  it("proxy path skips register and cache reset", async () => {
    const adapter = fakeAdapter();
    const onReset = vi.fn();
    const mgr = new ActivationManager(adapter, () => "none", onReset);
    const m = makeManifest({ id: "proxy-cap", supportsProxyCall: true });
    const r = await mgr.activate(m, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.path).toBe("proxy");
    expect(adapter.registerCalls).toHaveLength(0);
    expect(onReset).not.toHaveBeenCalled();
  });

  it("registered path calls register and triggers cache reset once", async () => {
    const adapter = fakeAdapter();
    const onReset = vi.fn();
    const mgr = new ActivationManager(adapter, () => "none", onReset);
    const m = makeManifest({ id: "reg-cap", supportsProxyCall: false });
    const r = await mgr.activate(m, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.path).toBe("registered");
    expect(adapter.registerCalls).toEqual(["reg-cap"]);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("resident path calls register but does not trigger cache reset", async () => {
    const adapter = fakeAdapter();
    const onReset = vi.fn();
    const mgr = new ActivationManager(adapter, () => "resident", onReset);
    const m = makeManifest({ id: "res-cap", supportsProxyCall: false });
    const r = await mgr.activate(m, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.path).toBe("resident");
    expect(adapter.registerCalls).toEqual(["res-cap"]);
    expect(onReset).not.toHaveBeenCalled();
  });

  it("release deactivates registered leases", async () => {
    const adapter = fakeAdapter();
    const mgr = new ActivationManager(adapter, () => "none", () => {});
    const m = makeManifest({ id: "reg-cap", supportsProxyCall: false });
    const activated = await mgr.activate(m, ctx);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    const released = await mgr.release(activated.value.leaseId);
    expect(released.ok).toBe(true);
    expect(adapter.deactivateCalls).toEqual(["reg-cap"]);
  });

  it("release returns lease-unknown for unknown leaseId", async () => {
    const mgr = new ActivationManager(fakeAdapter(), () => "none", () => {});
    const r = await mgr.release("missing-lease");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("engine/lease-unknown");
  });

  describe("suggestPromotion", () => {
    it("returns true after 3 proxy activations", async () => {
      const mgr = new ActivationManager(fakeAdapter(), () => "none", () => {});
      const m = makeManifest({ id: "promo-cap", supportsProxyCall: true });
      for (let i = 0; i < 3; i++) await mgr.activate(m, ctx);
      expect(mgr.suggestPromotion("promo-cap")).toBe(true);
    });

    it("returns false after 2 proxy activations", async () => {
      const mgr = new ActivationManager(fakeAdapter(), () => "none", () => {});
      const m = makeManifest({ id: "promo-cap-2", supportsProxyCall: true });
      for (let i = 0; i < 2; i++) await mgr.activate(m, ctx);
      expect(mgr.suggestPromotion("promo-cap-2")).toBe(false);
    });
  });
});

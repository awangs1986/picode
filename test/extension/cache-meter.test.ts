import { describe, expect, it } from "vitest";
import { CacheMeter } from "../../src/extension/cache-meter.ts";
import type { PrefixSignals, TurnUsage } from "../../src/shared/types.ts";

const signals = (overrides: Partial<PrefixSignals> = {}): PrefixSignals => ({
  systemDigest: "sys-v1",
  toolSchemaDigest: "schema-v1",
  retainedHistoryAnchorDigest: "hist-v1",
  provider: "anthropic",
  model: "claude",
  ...overrides,
});

const usage = (overrides: Partial<TurnUsage> = {}): TurnUsage => ({
  inputTokens: 100,
  outputTokens: 50,
  ...overrides,
});

describe("CacheMeter", () => {
  it("reports telemetry unavailable when no cache fields", () => {
    const meter = new CacheMeter();
    meter.recordTurn({ inputTokens: 100, outputTokens: 20 });
    const snap = meter.snapshot();
    expect(snap.telemetryAvailable).toBe(false);
    expect(meter.format()).toContain("Cache telemetry unavailable");
  });

  it("computes hit rate with denominator read+input+write", () => {
    const meter = new CacheMeter();
    meter.recordTurn(usage({ cacheReadTokens: 60, cacheWriteTokens: 10, inputTokens: 30 }));
    const snap = meter.snapshot();
    expect(snap.telemetryAvailable).toBe(true);
    expect(snap.lastTurnHitRate).toBeCloseTo(60 / (60 + 30 + 10));
    expect(snap.sessionHitRate).toBeCloseTo(60 / (60 + 30 + 10));
  });

  describe("miss attribution", () => {
    it("does not attribute on first turn with signals", () => {
      const meter = new CacheMeter();
      meter.recordTurn(usage({ cacheReadTokens: 0 }), signals());
      expect(meter.snapshot().lastAttribution).toBeUndefined();
    });

    it("attributes system-drift when systemDigest changes", () => {
      const meter = new CacheMeter();
      meter.recordTurn(usage({ cacheReadTokens: 10 }), signals());
      meter.recordTurn(usage({ cacheReadTokens: 0 }), signals({ systemDigest: "sys-v2" }));
      expect(meter.snapshot().lastAttribution).toBe("system-drift");
    });

    it("attributes tool-schema-drift when toolSchemaDigest changes", () => {
      const meter = new CacheMeter();
      meter.recordTurn(usage({ cacheReadTokens: 10 }), signals());
      meter.recordTurn(usage({ cacheReadTokens: 0 }), signals({ toolSchemaDigest: "schema-v2" }));
      expect(meter.snapshot().lastAttribution).toBe("tool-schema-drift");
    });

    it("attributes history-anchor-rewrite when retainedHistoryAnchorDigest changes", () => {
      const meter = new CacheMeter();
      meter.recordTurn(usage({ cacheReadTokens: 10 }), signals());
      meter.recordTurn(
        usage({ cacheReadTokens: 0 }),
        signals({ retainedHistoryAnchorDigest: "hist-v2" }),
      );
      expect(meter.snapshot().lastAttribution).toBe("history-anchor-rewrite");
    });

    it("attributes route-drift when provider, model, or base URL changes", () => {
      const meter = new CacheMeter();
      meter.recordTurn(usage({ cacheReadTokens: 10 }), signals({ baseUrl: "https://a.example/v1" }));
      meter.recordTurn(usage({ cacheReadTokens: 0 }), signals({
        provider: "openai",
        model: "gpt-5",
        baseUrl: "https://b.example/v1",
      }));
      expect(meter.snapshot().lastAttribution).toBe("route-drift");
    });

    it("attributes cache-key-drift when prompt cache identity changes", () => {
      const meter = new CacheMeter();
      meter.recordTurn(usage({ cacheReadTokens: 10 }), signals({ promptCacheKeyHash: "key-a" }));
      meter.recordTurn(usage({ cacheReadTokens: 0 }), signals({ promptCacheKeyHash: "key-b" }));
      expect(meter.snapshot().lastAttribution).toBe("cache-key-drift");
    });

    it("attributes retention-policy-drift when provider retention changes", () => {
      const meter = new CacheMeter();
      meter.recordTurn(usage({ cacheReadTokens: 10 }), signals({ cacheRetention: "short" }));
      meter.recordTurn(usage({ cacheReadTokens: 0 }), signals({ cacheRetention: "long" }));
      expect(meter.snapshot().lastAttribution).toBe("retention-policy-drift");
    });

    it("attributes uncached-tail when stable and cacheRead > 0", () => {
      const meter = new CacheMeter();
      meter.recordTurn(usage({ cacheReadTokens: 10 }), signals());
      meter.recordTurn(usage({ cacheReadTokens: 5 }), signals());
      expect(meter.snapshot().lastAttribution).toBe("uncached-tail");
    });

    it("attributes unknown-provider-side when stable and cacheRead = 0", () => {
      const meter = new CacheMeter();
      meter.recordTurn(usage({ cacheReadTokens: 10 }), signals());
      meter.recordTurn(usage({ cacheReadTokens: 0 }), signals());
      expect(meter.snapshot().lastAttribution).toBe("unknown-provider-side");
    });
  });

  it("beginNewEpoch increments epoch and clears attribution on next turn", () => {
    const meter = new CacheMeter();
    meter.recordTurn(usage({ cacheReadTokens: 10 }), signals());
    meter.recordTurn(usage({ cacheReadTokens: 0 }), signals({ systemDigest: "sys-v2" }));
    expect(meter.snapshot().lastAttribution).toBe("system-drift");

    meter.beginNewEpoch();
    expect(meter.snapshot().cacheEpoch).toBe(2);

    meter.recordTurn(usage({ cacheReadTokens: 5 }), signals({ systemDigest: "sys-v2" }));
    expect(meter.snapshot().lastAttribution).toBeUndefined();
  });
});

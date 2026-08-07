import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendCacheMetric,
  computePrefixSignals,
} from "../../src/extension/cache-signals.ts";
import { dataPaths } from "../../src/shared/paths.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

const baseInputs = {
  systemPrompt: "You are helpful",
  toolSchemaJson: "[]",
  retainedHistoryHead: "{}",
  provider: "openai",
  model: "gpt-4",
};

describe("computePrefixSignals", () => {
  it("returns stable output for identical inputs", () => {
    const a = computePrefixSignals(baseInputs);
    const b = computePrefixSignals(baseInputs);
    expect(a).toEqual(b);
  });

  it("changes only systemDigest when systemPrompt changes", () => {
    const a = computePrefixSignals(baseInputs);
    const b = computePrefixSignals({ ...baseInputs, systemPrompt: "Different prompt" });
    expect(a.systemDigest).not.toBe(b.systemDigest);
    expect(a.toolSchemaDigest).toBe(b.toolSchemaDigest);
    expect(a.retainedHistoryAnchorDigest).toBe(b.retainedHistoryAnchorDigest);
    expect(a.provider).toBe(b.provider);
    expect(a.model).toBe(b.model);
  });

  it("omits optional keys when inputs are not provided", () => {
    const signals = computePrefixSignals(baseInputs);
    expect(signals).not.toHaveProperty("baseUrl");
    expect(signals).not.toHaveProperty("promptCacheKeyHash");
    expect(signals).not.toHaveProperty("cacheRetention");
  });

  it("hashes promptCacheKey instead of returning raw value", () => {
    const raw = "my-cache-key-secret";
    const signals = computePrefixSignals({ ...baseInputs, promptCacheKey: raw });
    expect(signals.promptCacheKeyHash).toBeDefined();
    expect(signals.promptCacheKeyHash).not.toBe(raw);
    expect(signals.promptCacheKeyHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("appendCacheMetric", () => {
  it("writes one valid JSON line to metrics/cache-YYYYMM.jsonl using record ts month", async () => {
    await withTempPicodeDir(async () => {
      const record = {
        ts: "2026-08-07T10:00:00.000Z",
        sessionId: "sess-1",
        snapshot: {
          cacheEpoch: 1,
          turns: 0,
          sessionHitRate: 0,
          lastTurnHitRate: 0,
          telemetryAvailable: false,
        },
      };
      await appendCacheMetric(record);

      const yyyymm = record.ts.slice(0, 7).replace("-", "");
      const file = join(dataPaths.metrics(), `cache-${yyyymm}.jsonl`);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!) as typeof record;
      expect(parsed.sessionId).toBe("sess-1");
      expect(parsed.snapshot.cacheEpoch).toBe(1);
    });
  });
});

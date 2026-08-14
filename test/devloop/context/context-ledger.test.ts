import { describe, expect, it } from "vitest";
import { ContextLedger } from "../../../src/devloop/index.ts";
import { Store } from "../../../src/store/index.ts";
import { withTempPicodeDir } from "../../helpers/temp-dir.ts";

describe("ContextLedger", () => {
  it("records each deterministic context transformation once", async () => {
    await withTempPicodeDir(async () => {
      const ledger = new ContextLedger(new Store());
      const input = {
        sessionId: "session-ledger",
        sessionRevision: "12:leaf-a",
        layer: "governor" as const,
        action: "compiled",
        sourceDigest: "a".repeat(64),
        outputDigest: "b".repeat(64),
        beforeTokens: 90_000,
        afterTokens: 60_000,
        cacheEpoch: 4,
        requestOnly: true,
      };

      expect((await ledger.record(input)).ok).toBe(true);
      expect((await ledger.record(input)).ok).toBe(true);
      const listed = await ledger.list("session-ledger");

      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value).toHaveLength(1);
        expect(listed.value[0]).toMatchObject(input);
        expect(listed.value[0]?.eventId).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });

  it("keeps different lifecycle layers as distinct evidence", async () => {
    await withTempPicodeDir(async () => {
      const ledger = new ContextLedger(new Store());
      const base = {
        sessionId: "session-layers",
        sessionRevision: "5:leaf",
        sourceDigest: "c".repeat(64),
        outputDigest: "d".repeat(64),
      };
      await ledger.record({ ...base, layer: "retention", action: "externalized", requestOnly: false });
      await ledger.record({ ...base, layer: "governor", action: "compiled", requestOnly: true });

      const listed = await ledger.list("session-layers");

      expect(listed.ok).toBe(true);
      if (listed.ok) expect(listed.value.map((entry) => entry.layer)).toEqual(["retention", "governor"]);
    });
  });
});

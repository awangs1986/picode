import { join } from "node:path";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StateFile } from "../../src/store/state-file.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

interface CounterState { version: 1; count: number }
const isCounter = (value: unknown): value is CounterState => {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 && typeof state.count === "number";
};

describe("StateFile<T>", () => {
  it("round-trips validated state through the public file authority", async () => {
    await withTempPicodeDir(async (dir) => {
      const state = new StateFile(join(dir, "counter.json"), isCounter);
      expect((await state.write({ version: 1, count: 7 })).ok).toBe(true);
      expect(await state.read()).toEqual({ ok: true, value: { version: 1, count: 7 } });
    });
  });

  it("quarantines a corrupt current file and recovers the last known-good state", async () => {
    await withTempPicodeDir(async (dir) => {
      const path = join(dir, "counter.json");
      const state = new StateFile(path, isCounter);
      await state.write({ version: 1, count: 9 });
      writeFileSync(path, "{broken", "utf8");

      expect(await state.read()).toEqual({ ok: true, value: { version: 1, count: 9 } });
      expect(readdirSync(dir).some((name) => name.startsWith("counter.json.quarantine-"))).toBe(true);
    });
  });

  it("seeds known-good state when reading a legacy valid file", async () => {
    await withTempPicodeDir(async (dir) => {
      const path = join(dir, "counter.json");
      writeFileSync(path, JSON.stringify({ version: 1, count: 3 }), "utf8");
      const state = new StateFile(path, isCounter);

      expect(await state.read()).toEqual({ ok: true, value: { version: 1, count: 3 } });
      expect(existsSync(`${path}.known-good`)).toBe(true);
    });
  });

  it("quarantines corrupt state even when no known-good copy exists", async () => {
    await withTempPicodeDir(async (dir) => {
      const path = join(dir, "counter.json");
      writeFileSync(path, "{broken", "utf8");
      const state = new StateFile(path, isCounter);

      const result = await state.read();
      expect(result.ok).toBe(false);
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(dir).some((name) => name.startsWith("counter.json.quarantine-"))).toBe(true);
    });
  });
});

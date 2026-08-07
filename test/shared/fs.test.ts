import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteFile, withFileLock } from "../../src/shared/fs.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("atomicWriteFile", () => {
  it("creates parent directories and writes content", async () => {
    await withTempPicodeDir(async (dir) => {
      const path = join(dir, "nested", "out.txt");
      atomicWriteFile(path, "hello");
      expect(readFileSync(path, "utf8")).toBe("hello");
    });
  });

  it("overwrites existing content", async () => {
    await withTempPicodeDir(async (dir) => {
      const path = join(dir, "file.txt");
      atomicWriteFile(path, "first");
      atomicWriteFile(path, "second");
      expect(readFileSync(path, "utf8")).toBe("second");
    });
  });
});

describe("withFileLock", () => {
  it("serializes concurrent callers", async () => {
    await withTempPicodeDir(async (dir) => {
      const lockPath = join(dir, "test.lock");
      let active = 0;
      let maxActive = 0;

      const work = async (ms: number) =>
        withFileLock(lockPath, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, ms));
          active -= 1;
        });

      await Promise.all([work(80), work(80)]);
      expect(maxActive).toBe(1);
    });
  });

  it("throws on lock timeout when lock is held", async () => {
    await withTempPicodeDir(async (dir) => {
      const lockPath = join(dir, "held.lock");
      mkdirSync(dir, { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: 99999, at: Date.now() }), "utf8");

      await expect(
        withFileLock(lockPath, () => "never", { timeoutMs: 100, retryMs: 20 }),
      ).rejects.toThrow(/file lock timeout/);
    });
  });

  it("clears stale locks older than 30s", async () => {
    await withTempPicodeDir(async (dir) => {
      const lockPath = join(dir, "stale.lock");
      mkdirSync(dir, { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: 1, at: 0 }), "utf8");
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);

      const result = await withFileLock(lockPath, () => "acquired");
      expect(result).toBe("acquired");
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});

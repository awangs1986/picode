import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  stripJsonComments,
} from "../../src/store/config.ts";
import { dataPaths } from "../../src/shared/paths.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("stripJsonComments", () => {
  it("strips line comments", () => {
    const input = `{
  "a": 1, // inline
  // full line
  "b": 2
}`;
    const out = stripJsonComments(input);
    expect(out).not.toContain("//");
    expect(out).toContain('"a": 1');
    expect(out).toContain('"b": 2');
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
  });

  it("strips block comments", () => {
    const input = `{ /* block */ "a": 1 /* trailing */ }`;
    expect(stripJsonComments(input)).toBe(`{  "a": 1  }`);
  });

  it("preserves // and /* inside strings", () => {
    const input = `{
  "url": "http://example.com",
  "note": "see /* not a comment */ here"
}`;
    expect(stripJsonComments(input)).toBe(input);
  });

  it("handles escaped quotes inside strings", () => {
    const input = `{ "msg": "say \\"hello\\" // not comment" }`;
    expect(stripJsonComments(input)).toBe(`{ "msg": "say \\"hello\\" // not comment" }`);
  });
});

describe("loadConfig", () => {
  it("returns deep-cloned DEFAULT_CONFIG when file is missing", async () => {
    await withTempPicodeDir(async () => {
      const r = loadConfig();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toEqual(DEFAULT_CONFIG);
      expect(r.value).not.toBe(DEFAULT_CONFIG);
      expect(r.value.onboarding).not.toBe(DEFAULT_CONFIG.onboarding);
      r.value.onboarding.completed = true;
      expect(DEFAULT_CONFIG.onboarding.completed).toBe(false);
    });
  });

  it("reads JSONC with comments", async () => {
    await withTempPicodeDir(async () => {
      const path = dataPaths.config();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `{
  // locale override
  "locale": "en"
}`,
        "utf8",
      );
      const r = loadConfig();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.locale).toBe("en");
      expect(r.value.version).toBe(1);
      expect(r.value.onboarding.completed).toBe(false);
      expect(r.value.googleSearchSubagent).toEqual(DEFAULT_CONFIG.googleSearchSubagent);
    });
  });

  it("returns store/config-unreadable for corrupt JSON", async () => {
    await withTempPicodeDir(async () => {
      const path = dataPaths.config();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{ not json", "utf8");
      const r = loadConfig();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("store/config-unreadable");
    });
  });

  it("merges partial fields with DEFAULT_CONFIG", async () => {
    await withTempPicodeDir(async () => {
      const path = dataPaths.config();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ residentCapabilities: ["cap-a"] }),
        "utf8",
      );
      const r = loadConfig();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.residentCapabilities).toEqual(["cap-a"]);
      expect(r.value.locale).toBe(DEFAULT_CONFIG.locale);
      expect(r.value.version).toBe(1);
    });
  });

  it("rejects unsafe Google Search Subagent concurrency", async () => {
    await withTempPicodeDir(async () => {
      const path = dataPaths.config();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({
        googleSearchSubagent: { parallelism: 11 },
      }), "utf8");
      const loaded = loadConfig();
      expect(loaded.ok).toBe(false);
    });
  });
});

describe("saveConfig + loadConfig", () => {
  it("round-trips config through disk", async () => {
    await withTempPicodeDir(async () => {
      const config = {
        ...structuredClone(DEFAULT_CONFIG),
        locale: "en" as const,
        residentCapabilities: ["x"],
        onboarding: { completed: true, answeredAt: "2026-01-01T00:00:00.000Z" },
      };
      const saved = await saveConfig(config);
      expect(saved.ok).toBe(true);
      const loaded = loadConfig();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value).toEqual(config);
    });
  });

  it("quarantines a corrupt current config and restores the last known-good config", async () => {
    await withTempPicodeDir(async (dir) => {
      const config = {
        ...structuredClone(DEFAULT_CONFIG),
        locale: "en" as const,
        onboarding: { completed: true },
      };
      expect((await saveConfig(config)).ok).toBe(true);
      writeFileSync(dataPaths.config(), "{ broken", "utf8");

      const loaded = loadConfig();

      expect(loaded).toEqual({ ok: true, value: config });
      expect(readdirSync(dir).some((name) => name.startsWith("config.json.quarantine-"))).toBe(true);
    });
  });
});

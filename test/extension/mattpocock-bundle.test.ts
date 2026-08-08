import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundledSkillNames,
  materializeMattPocockSkills,
  readMattPocockBundleManifest,
} from "../../src/extension/mattpocock-bundle.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("bundled mattpocock skills", () => {
  it("ships a pinned complete catalog without loading it into Pi", () => {
    const manifest = readMattPocockBundleManifest();
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.value.license).toBe("MIT");
    expect(manifest.value.fileCount).toBeGreaterThan(50);
    expect(bundledSkillNames()).toContain("grill-with-docs");
    expect(bundledSkillNames()).toContain("tdd");
  });

  it("materializes only the requested skill and its planning dependencies", async () => {
    await withTempPicodeDir(async (dir) => {
      const target = join(dir, "agent", "skills");
      const result = materializeMattPocockSkills(["grill-with-docs"], target);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.materialized).toEqual(["grilling", "domain-modeling", "grill-with-docs"]);
      expect(result.value.alreadyPresent).toEqual([]);
      expect(existsSync(join(target, "grill-with-docs", "SKILL.md"))).toBe(true);
      expect(existsSync(join(target, "grilling", "SKILL.md"))).toBe(true);
      expect(existsSync(join(target, "domain-modeling", "SKILL.md"))).toBe(true);
      expect(existsSync(join(target, "tdd"))).toBe(false);
      expect(readFileSync(join(target, "grill-with-docs", ".picode-bundle.json"), "utf8")).toContain("84fdeffd");
    });
  });

  it("does not overwrite a user-managed skill and remains idempotent", async () => {
    await withTempPicodeDir(async (dir) => {
      const target = join(dir, "agent", "skills");
      const first = materializeMattPocockSkills(["tdd"], target);
      expect(first.ok).toBe(true);
      const second = materializeMattPocockSkills(["tdd"], target);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.materialized).toEqual([]);
      expect(second.value.alreadyPresent).toEqual(["tdd"]);
    });
  });
});

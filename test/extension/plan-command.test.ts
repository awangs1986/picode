import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findMattPocockSkills,
  planCommandResult,
  skillRootsFor,
} from "../../src/extension/plan-command.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

function installMarker(root: string): void {
  const markerDir = join(root, "setup-matt-pocock-skills");
  mkdirSync(markerDir, { recursive: true });
  writeFileSync(join(markerDir, "SKILL.md"), "# Setup Matt Pocock's Skills\n", "utf8");
  mkdirSync(join(root, "grill-with-docs"), { recursive: true });
}

describe("mattpocock /plan compatibility", () => {
  it("searches project roots from cwd upward and user roots", () => {
    const roots = skillRootsFor("C:/repo/packages/game", {
      home: "C:/Users/dev",
      piAgent: "C:/Users/dev/.picode/agent",
    });
    expect(roots).toContain("C:\\repo\\packages\\game\\.agents\\skills");
    expect(roots).toContain("C:\\repo\\.pi\\skills");
    expect(roots).toContain("C:\\Users\\dev\\.agents\\skills");
    expect(roots).toContain("C:\\Users\\dev\\.picode\\agent\\skills");
  });

  it("recognizes the explicit setup marker", async () => {
    await withTempPicodeDir(async (dir) => {
      const skills = join(dir, "skills");
      installMarker(skills);
      const found = findMattPocockSkills(dir, { roots: [skills] });
      expect(found).toEqual({ installed: true, roots: [skills] });
    });
  });

  it("does not treat one unrelated skill as the collection", async () => {
    await withTempPicodeDir(async (dir) => {
      const skills = join(dir, "skills", "tdd");
      mkdirSync(skills, { recursive: true });
      expect(findMattPocockSkills(dir, { roots: [join(dir, "skills")] }).installed).toBe(false);
    });
  });

  it("reports a discoverability problem without asking for an external install", () => {
    const result = planCommandResult("ship feature", { installed: false, roots: [] });
    expect(result.kind).toBe("missing");
    expect(result.message).toContain("Restart or reload Picode");
    expect(result.message).not.toContain("npx skills");
  });

  it("delegates planning to the installed skill workflow", () => {
    const result = planCommandResult("ship feature", { installed: true, roots: ["C:/skills"] });
    expect(result.kind).toBe("ready");
    expect(result.message).toContain("grill-with-docs");
    expect(result.message).toContain("ship feature");
  });
});

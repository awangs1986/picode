import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
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
  writeFileSync(join(root, "grill-with-docs", "SKILL.md"), [
    "---",
    "name: grill-with-docs",
    "description: Align a design through questions.",
    "---",
    "# Grill With Docs",
    "Read the design documents before asking one question at a time.",
  ].join("\n"), "utf8");
}

describe("mattpocock /plan compatibility", () => {
  it("searches project roots from cwd upward and user roots", () => {
    const cwd = resolve("repo", "packages", "game");
    const home = resolve("home", "dev");
    const piAgent = join(home, ".picode", "agent");
    const roots = skillRootsFor(cwd, {
      home,
      piAgent,
    });
    expect(roots).toContain(join(cwd, ".agents", "skills"));
    expect(roots).toContain(join(dirname(dirname(cwd)), ".pi", "skills"));
    expect(roots).toContain(join(home, ".agents", "skills"));
    expect(roots).toContain(join(piAgent, "skills"));
    expect(roots).toContain(join(parse(cwd).root, ".agents", "skills"));
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

  it("delegates planning by injecting the installed skill body directly", async () => {
    await withTempPicodeDir(async (dir) => {
      const skills = join(dir, "skills");
      installMarker(skills);
      const result = planCommandResult("ship feature", { installed: true, roots: [skills] });
      expect(result.kind).toBe("ready");
      expect(result.message).toContain('<skill name="grill-with-docs"');
      expect(result.message).toContain("# Grill With Docs");
      expect(result.message).not.toContain("description: Align");
      expect(result.message).toContain("ship feature");
    });
  });
});

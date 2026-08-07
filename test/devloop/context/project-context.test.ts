import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTempPicodeDir } from "../../helpers/temp-dir.ts";
import {
  discoverProjectContext,
  renderProjectContext,
} from "../../../src/devloop/context/project-context.ts";

describe("Harness project context discovery", () => {
  it("loads Grok, Claude and Cursor compatible rules root-to-cwd with deeper rules last", async () => {
    await withTempPicodeDir(async (root) => {
    const child = join(root, "game", "combat");
    mkdirSync(join(root, ".grok", "rules"), { recursive: true });
    mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
    mkdirSync(join(root, "game", ".claude"), { recursive: true });
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root agents");
    writeFileSync(join(root, ".grok", "rules", "architecture.md"), "root grok");
    writeFileSync(join(root, ".cursor", "rules", "style.mdc"), "root cursor");
    writeFileSync(join(root, "game", ".claude", "CLAUDE.md"), "game claude");
    writeFileSync(join(child, "AGENTS.md"), "combat agents");

    const entries = discoverProjectContext({ repoRoot: root, cwd: child });

    expect(entries.map((entry) => entry.content)).toEqual([
      "root agents",
      "root cursor",
      "root grok",
      "game claude",
      "combat agents",
    ]);
    expect(entries.at(-1)?.priority).toBeGreaterThan(entries[0]?.priority ?? 0);
    expect(renderProjectContext(entries)).toContain("deeper files have higher priority");
    });
  });
});

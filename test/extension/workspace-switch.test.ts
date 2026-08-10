import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspaceSwitch } from "../../src/extension/workspace-switch.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("forced workspace switch", () => {
  it("writes a restart request, persists the old-workspace fence, and grounds the new AGENTS.md", async () => {
    await withTempPicodeDir(async (picodeDir) => {
      const root = mkdtempSync(join(tmpdir(), "picode-workspace-switch-"));
      try {
        const oldWorkspace = join(root, "old-project");
        const newWorkspace = join(root, "new-project");
        mkdirSync(oldWorkspace);
        mkdirSync(newWorkspace);

        const result = await prepareWorkspaceSwitch({
          launchId: "launch-test",
          fromWorkspace: oldWorkspace,
          toWorkspace: newWorkspace,
        });

        expect(result).toMatchObject({ ok: true, value: { targetWorkspace: newWorkspace } });
        expect(JSON.parse(readFileSync(join(picodeDir, "workspace-fence.json"), "utf8"))).toMatchObject({
          activeWorkspace: newWorkspace,
          deniedWriteRoots: [oldWorkspace],
        });
        expect(JSON.parse(readFileSync(join(picodeDir, "workspace-switch-launch-test.json"), "utf8"))).toMatchObject({
          launchId: "launch-test",
          fromWorkspace: oldWorkspace,
          targetWorkspace: newWorkspace,
        });
        const agents = readFileSync(join(newWorkspace, "AGENTS.md"), "utf8");
        expect(agents).toContain(`Current workspace: \`${newWorkspace}\``);
        expect(agents).toContain(`Forbidden previous workspace: \`${oldWorkspace}\``);
        expect(agents).toContain("Never create, edit, move, or delete files in any forbidden previous workspace");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

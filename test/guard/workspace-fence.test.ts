import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Guard, WorkspaceFence } from "../../src/guard/index.ts";
import { prepareWorkspaceSwitch } from "../../src/extension/workspace-switch.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("workspace write fence", () => {
  it("denies file and shell mutations that target the previous workspace even in full mode", async () => {
    await withTempPicodeDir(async () => {
      const root = mkdtempSync(join(tmpdir(), "picode-workspace-fence-"));
      try {
        const oldWorkspace = join(root, "old");
        const newWorkspace = join(root, "new");
        mkdirSync(oldWorkspace);
        mkdirSync(newWorkspace);
        await prepareWorkspaceSwitch({
          launchId: "fence-test",
          fromWorkspace: oldWorkspace,
          toWorkspace: newWorkspace,
        });
        const guard = new Guard("danger-full-access", undefined, undefined, new WorkspaceFence());

        expect(guard.decide({
          category: "fs-write",
          cwd: newWorkspace,
          targets: [join(oldWorkspace, "forbidden.txt")],
        })).toMatchObject({ verdict: "deny", reason: expect.stringContaining("previous workspace") });
        expect(guard.decide({
          category: "exec",
          cwd: newWorkspace,
          command: `Set-Content -LiteralPath '${join(oldWorkspace, "forbidden.txt")}' -Value bad`,
          targets: [],
        })).toMatchObject({ verdict: "deny" });
        expect(guard.decide({
          category: "fs-write",
          cwd: newWorkspace,
          targets: [join(newWorkspace, "allowed.txt")],
        })).toMatchObject({ verdict: "allow" });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataPaths } from "../../src/shared/paths.ts";
import { Guard, WorkspaceFence } from "../../src/guard/index.ts";
import { prepareWorkspaceSwitch } from "../../src/extension/workspace-switch.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("workspace write fence", () => {
  it("recovers the last known-good fence and quarantines later corruption", async () => {
    await withTempPicodeDir(async (dir) => {
      const path = dataPaths.workspaceFence();
      writeFileSync(path, JSON.stringify({
        version: 1,
        activeWorkspace: "D:/new",
        deniedWriteRoots: ["D:/old"],
      }), "utf8");
      expect(new WorkspaceFence(path).deniedWriteRoots()).toEqual(["D:/old"]);
      expect(existsSync(`${path}.known-good`)).toBe(true);

      writeFileSync(path, "{broken", "utf8");
      const recovered = new WorkspaceFence(path);

      expect(recovered.deniedWriteRoots()).toEqual(["D:/old"]);
      expect(recovered.decide({ category: "fs-write", cwd: "D:/old", targets: ["x"] }))
        .toMatchObject({ verdict: "deny", reason: expect.stringContaining("previous workspace") });
      expect(readdirSync(dir).some((name) => name.startsWith("workspace-fence.json.quarantine-"))).toBe(true);
    });
  });

  it("fails closed for every write when the persisted fence is corrupt", async () => {
    await withTempPicodeDir(async () => {
      writeFileSync(dataPaths.workspaceFence(), "{broken", "utf8");
      const guard = new Guard("danger-full-access", undefined, undefined, new WorkspaceFence());

      expect(guard.decide({
        category: "fs-write",
        cwd: "D:/current",
        targets: ["safe-looking.txt"],
      })).toMatchObject({ verdict: "deny", reason: expect.stringContaining("unreadable") });
      expect(guard.decide({
        category: "fs-read",
        cwd: "D:/current",
        targets: ["existing.txt"],
      })).toMatchObject({ verdict: "allow" });
    });
  });

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

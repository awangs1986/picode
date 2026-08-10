import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configureLandstripForSession } from "../../src/extension/landstrip-config.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("configureLandstripForSession", () => {
  it("does not create sandbox state for simple sessions", async () => {
    await withTempPicodeDir(async (dir) => {
      const result = await configureLandstripForSession({
        harnessTier: "simple",
        permissionTier: "auto",
        cwd: "C:/repo",
        agentDir: dir,
      });
      expect(result.ok).toBe(true);
      expect(existsSync(`${dir}/sandbox.json`)).toBe(false);
    });
  });

  it("writes a Picode-owned policy and disables landstrip's competing subagent tool", async () => {
    await withTempPicodeDir(async (dir) => {
      const result = await configureLandstripForSession({
        harnessTier: "standard",
        permissionTier: "auto",
        cwd: "C:/repo",
        agentDir: dir,
      });
      expect(result.ok).toBe(true);
      const sandbox = JSON.parse(readFileSync(`${dir}/sandbox.json`, "utf8"));
      const settings = JSON.parse(readFileSync(`${dir}/settings.json`, "utf8"));
      expect(sandbox).toMatchObject({
        enabled: process.platform !== "win32",
        network: { allowNetwork: false },
        filesystem: { allowWrite: ["C:/repo"] },
      });
      expect(sandbox.filesystem.denyWrite).toContain("**/.env");
      if (process.platform === "win32") {
        expect(sandbox.filesystem.allowRead.some((path: string) =>
          path.toLowerCase().startsWith("c:\\program files\\nodejs"),
        )).toBe(true);
      }
      expect(settings.landstrip.maxSubagents).toBe(0);
      expect(settings.landstrip.permission).toBe("allow");
    });
  });

  it("adds every forbidden previous workspace to the OS sandbox deny-write policy", async () => {
    await withTempPicodeDir(async (dir) => {
      const result = await configureLandstripForSession({
        harnessTier: "standard",
        permissionTier: "full",
        cwd: "C:/repo-new",
        agentDir: dir,
        deniedWriteRoots: ["C:/repo-old"],
      });

      expect(result.ok).toBe(true);
      const sandbox = JSON.parse(readFileSync(`${dir}/sandbox.json`, "utf8"));
      expect(sandbox.filesystem.denyWrite).toContain("C:/repo-old");
    });
  });
});

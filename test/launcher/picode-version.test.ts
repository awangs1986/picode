import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("picode product version", () => {
  it("reports the installed Picode package version instead of the vendored Pi version", () => {
    const scratch = mkdtempSync(join(tmpdir(), "picode-version-"));
    try {
      const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };
      const result = spawnSync(process.execPath, [resolve("bin/picode.mjs"), "--version"], {
        cwd: process.cwd(),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, PICODE_DIR: scratch },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(manifest.version);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

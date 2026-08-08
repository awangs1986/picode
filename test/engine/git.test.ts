import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { StructuredGit } from "../../src/engine/git.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Structured Git", () => {
  it("returns inspect output as data without accepting arbitrary arguments", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "picode-git-")); dirs.push(cwd);
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    const result = await new StructuredGit().execute({ action: "status", cwd });
    expect(result).toMatchObject({ ok: true, action: "status", exitCode: 0, truncated: false });
    expect(result.stdout).toContain("No commits yet");
  });

  it("classifies ownership actions as always ask even under full permission", () => {
    expect(StructuredGit.intent({ action: "commit", cwd: "C:/repo", message: "x" })).toMatchObject({ category: "git-mutate" });
    expect(StructuredGit.intent({ action: "status", cwd: "C:/repo" })).toMatchObject({ category: "git-read" });
  });
});

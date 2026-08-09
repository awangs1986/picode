import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseTestCounts, ShellGateExecutor } from "../../src/extension/gate-command-executor.ts";

describe("parseTestCounts", () => {
  it("parses Vitest summary counts", () => {
    expect(parseTestCounts("Tests  2 failed | 17 passed (19)", 1)).toEqual({
      matchedTests: 19,
      passedTests: 17,
      failedTests: 2,
    });
  });

  it("parses cargo test summary counts", () => {
    expect(parseTestCounts("test result: FAILED. 12 passed; 1 failed; 2 ignored", 1)).toEqual({
      matchedTests: 13,
      passedTests: 12,
      failedTests: 1,
    });
  });

  it("does not invent matched tests from an exit code", () => {
    expect(parseTestCounts("compiler exploded", 1)).toEqual({
      matchedTests: 0,
      passedTests: 0,
      failedTests: 0,
    });
  });

  it("parses pytest summaries with warnings and durations around the counts", () => {
    expect(parseTestCounts("=== 2 failed, 17 passed, 3 warnings in 1.20s ===", 1)).toEqual({
      matchedTests: 19,
      passedTests: 17,
      failedTests: 2,
    });
  });

  it("parses Node test runner TAP summaries", () => {
    expect(parseTestCounts("# tests 1\n# pass 0\n# fail 1", 1)).toEqual({
      matchedTests: 1,
      passedTests: 0,
      failedTests: 1,
    });
  });

  it("parses the Node 24 spec reporter used in non-interactive Windows runs", () => {
    expect(parseTestCounts("ℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1", 1)).toEqual({
      matchedTests: 1,
      passedTests: 0,
      failedTests: 1,
    });
  });
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopFixtureProcess(pid: number): void {
  if (!processIsAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* fixture already exited */ }
  }
}

describe("ShellGateExecutor", () => {
  it("terminates the complete command process tree when a gate times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "picode-gate-tree-"));
    const pidFile = join(root, "child.pid");
    const fixture = resolve("test/fixtures/gate-spawns-child.mjs");
    let parentPid = 0;
    let childPid = 0;
    try {
      const command = `"${process.execPath}" "${fixture}" "${pidFile}"`;
      const result = await new ShellGateExecutor(root).execute(command, 750);
      expect(result.timedOut).toBe(true);
      expect(existsSync(pidFile)).toBe(true);
      const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { parentPid: number; childPid: number };
      parentPid = pids.parentPid;
      childPid = pids.childPid;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      expect(processIsAlive(childPid)).toBe(false);
    } finally {
      if (childPid > 0) stopFixtureProcess(childPid);
      if (parentPid > 0) stopFixtureProcess(parentPid);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

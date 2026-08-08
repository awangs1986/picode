import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RpcControlDriver } from "../../src/control/rpc-driver.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function waitForStarted(child: ChildProcessWithoutNullStreams): Promise<{ sessionFile: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`interrupted child did not start\n${stderr}`)), 20_000);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { kind?: string; payload?: { sessionFile?: string } };
          if (event.kind === "run.started" && event.payload?.sessionFile !== undefined) {
            clearTimeout(timeout);
            resolve({ sessionFile: event.payload.sessionFile });
          }
        } catch {
          // Pi may emit diagnostic text before the first protocol frame.
        }
      }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`interrupted child exited ${code}\n${stderr}`));
      }
    });
  });
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

describe("interrupted real Agent Loop", () => {
  it("resumes the same Pi session after its owning process tree is killed", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "picode-interruption-"));
    const picodeDir = join(scratch, "state");
    const child = spawn(process.execPath, [
      join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      join(root, "test", "fixtures", "interrupted-run-child.mjs"),
      root,
      scratch,
      picodeDir,
    ], { cwd: scratch, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    try {
      const { sessionFile } = await waitForStarted(child);
      await new Promise((resolve) => setTimeout(resolve, 300));
      killTree(child);
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => child.once("exit", resolve));
      }

      const driver = new RpcControlDriver({
        packageRoot: root,
        piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
        cwd: scratch,
        env: { ...process.env, PICODE_DIR: picodeDir },
        extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")],
      });
      const events = [];
      for await (const event of driver.send({
        session: sessionFile,
        message: "resume after interruption",
        nonInteractive: true,
      })) events.push(event);
      expect(events.at(-1)).toMatchObject({ kind: "run.completed", payload: { text: "scripted-ok" } });
    } finally {
      if (child.exitCode === null) killTree(child);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});

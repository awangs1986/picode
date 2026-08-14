import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { GateExecution, GateExecutor } from "../devloop/verify/gate-runner.ts";
import { parseTestCounts } from "../devloop/verify/test-counts.ts";

export class ShellGateExecutor implements GateExecutor {
  constructor(private readonly cwd: string) {}

  execute(command: string, timeoutMs: number): Promise<GateExecution> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: this.cwd,
        shell: true,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let timedOut = false;
      let settled = false;
      const append = (chunk: Buffer | string): void => {
        if (output.length < 10 * 1024 * 1024) output += chunk.toString();
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
      }, timeoutMs);
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const counts = parseTestCounts(output, exitCode);
        resolve({
          disposition: "executed",
          exitCode: exitCode ?? 1,
          ...counts,
          timedOut,
        });
      };
      child.once("error", () => finish(1));
      child.once("close", (code) => finish(code));
    });
  }
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* process already exited */ }
  }
}

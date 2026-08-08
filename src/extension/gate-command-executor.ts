import { exec } from "node:child_process";
import type { GateExecution, GateExecutor } from "../devloop/verify/gate-runner.ts";

export interface TestCounts {
  matchedTests: number;
  passedTests: number;
  failedTests: number;
}

function numberBefore(text: string, word: string): number {
  const match = text.match(new RegExp(`(\\d+)\\s+${word}`, "i"));
  return match === null ? 0 : Number(match[1]);
}

export function parseTestCounts(output: string, _exitCode: number | null): TestCounts {
  const vitestTotal = output.match(/Tests\s+[^\r\n]*\((\d+)\)/i);
  if (vitestTotal !== null) {
    return {
      matchedTests: Number(vitestTotal[1]),
      passedTests: numberBefore(vitestTotal[0], "passed"),
      failedTests: numberBefore(vitestTotal[0], "failed"),
    };
  }
  const cargo = output.match(/test result:\s+[^.]+\.\s+(\d+) passed;\s+(\d+) failed;/i);
  if (cargo !== null) {
    const passedTests = Number(cargo[1]);
    const failedTests = Number(cargo[2]);
    return { matchedTests: passedTests + failedTests, passedTests, failedTests };
  }
  const dotnet = output.match(/Total tests:\s*(\d+)[\s\S]*?Passed:\s*(\d+)[\s\S]*?Failed:\s*(\d+)/i);
  if (dotnet !== null) {
    return {
      matchedTests: Number(dotnet[1]),
      passedTests: Number(dotnet[2]),
      failedTests: Number(dotnet[3]),
    };
  }
  const tapTests = output.match(/# tests\s+(\d+)/i);
  if (tapTests !== null) {
    const passedTests = Number(output.match(/# pass\s+(\d+)/i)?.[1] ?? 0);
    const failedTests = Number(output.match(/# fail\s+(\d+)/i)?.[1] ?? 0);
    return { matchedTests: Number(tapTests[1]), passedTests, failedTests };
  }
  // Node 22+ selects the spec reporter for non-interactive terminals. Its
  // summary is semantically equivalent to TAP, but uses the information
  // symbol instead of '#'. Treat it as first-class test evidence so projects
  // do not have to rewrite their test command merely for Picode.
  const nodeSpecTests = output.match(/(?:ℹ|\u2139)\s*tests\s+(\d+)/iu);
  if (nodeSpecTests !== null) {
    const passedTests = Number(output.match(/(?:ℹ|\u2139)\s*pass\s+(\d+)/iu)?.[1] ?? 0);
    const failedTests = Number(output.match(/(?:ℹ|\u2139)\s*fail\s+(\d+)/iu)?.[1] ?? 0);
    return { matchedTests: Number(nodeSpecTests[1]), passedTests, failedTests };
  }
  const pytestFailed = numberBefore(output, "failed");
  const pytestPassed = numberBefore(output, "passed");
  if (/\d+\s+(?:failed|passed)\b/i.test(output)) {
    const failedTests = pytestFailed;
    const passedTests = pytestPassed;
    return { matchedTests: passedTests + failedTests, passedTests, failedTests };
  }
  return { matchedTests: 0, passedTests: 0, failedTests: 0 };
}

export class ShellGateExecutor implements GateExecutor {
  constructor(private readonly cwd: string) {}

  execute(command: string, timeoutMs: number): Promise<GateExecution> {
    return new Promise((resolve) => {
      exec(command, {
        cwd: this.cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        const output = `${stdout}\n${stderr}`;
        const counts = parseTestCounts(output, exitCode);
        resolve({
          disposition: "executed",
          exitCode,
          ...counts,
          timedOut: error !== null && (error.killed === true || error.signal !== null),
        });
      });
    });
  }
}

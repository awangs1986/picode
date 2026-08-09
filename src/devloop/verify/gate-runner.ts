export interface GateContract {
  gateId: string;
  command: string;
  timeoutMs: number;
  /** Test gates fail closed on zero matches; smoke/build gates may be exit-code contracts. */
  requiresTests?: boolean;
  redProbe?: { command: string };
}

export interface GateExecution {
  disposition?: "executed" | "skipped" | "not_run";
  exitCode: number | null;
  matchedTests: number;
  passedTests: number;
  failedTests: number;
  timedOut: boolean;
}

export interface GateExecutor {
  execute(command: string, timeoutMs: number): Promise<GateExecution>;
}

export interface GateEvidence {
  gateId: string;
  command: string;
  status: "passed" | "failed" | "not_run";
  reason: string;
  matchedTests: number;
  passedTests: number;
  failedTests: number;
  timedOut: boolean;
  ranAt: string;
  redProbe?: {
    command: string;
    status: "proved-red" | "unexpected-pass";
    matchedTests: number;
  };
}

export class GateRunner {
  constructor(
    private readonly executor: GateExecutor,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(contract: GateContract): Promise<GateEvidence> {
    const execution = await this.executor.execute(contract.command, contract.timeoutMs);
    const disposition = execution.disposition ?? "executed";
    const zeroTestsMatched = (contract.requiresTests ?? true) && execution.matchedTests === 0;
    const commandFailed = execution.exitCode !== 0 || execution.failedTests > 0;
    let status: GateEvidence["status"] =
      disposition !== "executed"
        ? "not_run"
        : zeroTestsMatched || commandFailed
          ? "failed"
          : "passed";
    let reason =
      disposition !== "executed"
        ? disposition
        : execution.timedOut
          ? "timeout"
          : zeroTestsMatched
          ? "zero-tests-matched"
          : commandFailed
            ? "command-failed"
            : "completed";
    const redProbe = contract.redProbe
      ? await this.executor.execute(contract.redProbe.command, contract.timeoutMs)
      : undefined;
    const redProbeProved =
      redProbe !== undefined &&
      redProbe.matchedTests > 0 &&
      !redProbe.timedOut &&
      (redProbe.exitCode !== 0 || redProbe.failedTests > 0);
    if (status === "passed" && contract.redProbe && !redProbeProved) {
      status = "failed";
      reason = "red-probe-did-not-fail";
    }
    return {
      gateId: contract.gateId,
      command: contract.command,
      status,
      reason,
      matchedTests: execution.matchedTests,
      passedTests: execution.passedTests,
      failedTests: execution.failedTests,
      timedOut: execution.timedOut,
      ranAt: this.now(),
      ...(contract.redProbe && redProbe
        ? {
            redProbe: {
              command: contract.redProbe.command,
              status:
                redProbeProved ? ("proved-red" as const) : ("unexpected-pass" as const),
              matchedTests: redProbe.matchedTests,
            },
          }
        : {}),
    };
  }
}

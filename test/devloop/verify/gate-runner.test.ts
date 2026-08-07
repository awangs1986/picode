import { describe, expect, it } from "vitest";
import { GateRunner, type GateExecutor } from "../../../src/devloop/verify/gate-runner.ts";

describe("GateRunner", () => {
  it("fails when the command exits successfully but matches no tests", async () => {
    const executor: GateExecutor = {
      execute: async () => ({
        exitCode: 0,
        matchedTests: 0,
        passedTests: 0,
        failedTests: 0,
        timedOut: false,
      }),
    };
    const runner = new GateRunner(executor, () => "2026-08-07T00:00:00.000Z");

    const evidence = await runner.run({
      gateId: "unit",
      command: "npm test -- missing-filter",
      timeoutMs: 30_000,
    });

    expect(evidence).toEqual({
      gateId: "unit",
      command: "npm test -- missing-filter",
      status: "failed",
      reason: "zero-tests-matched",
      matchedTests: 0,
      passedTests: 0,
      failedTests: 0,
      timedOut: false,
      ranAt: "2026-08-07T00:00:00.000Z",
    });
  });

  it("fails when a matched test command exits non-zero", async () => {
    const executor: GateExecutor = {
      execute: async () => ({
        exitCode: 1,
        matchedTests: 2,
        passedTests: 1,
        failedTests: 1,
        timedOut: false,
      }),
    };
    const runner = new GateRunner(executor, () => "2026-08-07T00:01:00.000Z");

    const evidence = await runner.run({ gateId: "unit", command: "npm test", timeoutMs: 30_000 });

    expect(evidence.status).toBe("failed");
    expect(evidence.reason).toBe("command-failed");
    expect(evidence.matchedTests).toBe(2);
    expect(evidence.failedTests).toBe(1);
  });

  it("reports a skipped command as not run instead of passed", async () => {
    const executor: GateExecutor = {
      execute: async () => ({
        disposition: "skipped",
        exitCode: 0,
        matchedTests: 1,
        passedTests: 1,
        failedTests: 0,
        timedOut: false,
      }),
    };
    const runner = new GateRunner(executor, () => "2026-08-07T00:02:00.000Z");

    const evidence = await runner.run({ gateId: "package", command: "package-smoke", timeoutMs: 1 });

    expect(evidence.status).toBe("not_run");
    expect(evidence.reason).toBe("skipped");
  });

  it("reports an executed timeout as a failure", async () => {
    const executor: GateExecutor = {
      execute: async () => ({
        exitCode: null,
        matchedTests: 1,
        passedTests: 0,
        failedTests: 0,
        timedOut: true,
      }),
    };
    const runner = new GateRunner(executor, () => "2026-08-07T00:03:00.000Z");

    const evidence = await runner.run({ gateId: "integration", command: "npm test", timeoutMs: 1 });

    expect(evidence.status).toBe("failed");
    expect(evidence.reason).toBe("timeout");
  });

  it("passes a completion gate only when its controlled red probe fails", async () => {
    const executions = [
      { exitCode: 0, matchedTests: 2, passedTests: 2, failedTests: 0, timedOut: false },
      { exitCode: 1, matchedTests: 1, passedTests: 0, failedTests: 1, timedOut: false },
    ];
    const executor: GateExecutor = {
      execute: async () => executions.shift()!,
    };
    const runner = new GateRunner(executor, () => "2026-08-07T00:04:00.000Z");

    const evidence = await runner.run({
      gateId: "completion",
      command: "npm test",
      timeoutMs: 30_000,
      redProbe: { command: "npm test -- controlled-fault" },
    });

    expect(evidence.status).toBe("passed");
    expect(evidence.redProbe).toEqual({
      command: "npm test -- controlled-fault",
      status: "proved-red",
      matchedTests: 1,
    });
  });

  it("fails a completion gate when its controlled red probe stays green", async () => {
    const green = { exitCode: 0, matchedTests: 1, passedTests: 1, failedTests: 0, timedOut: false };
    const executor: GateExecutor = { execute: async () => green };
    const runner = new GateRunner(executor, () => "2026-08-07T00:05:00.000Z");

    const evidence = await runner.run({
      gateId: "completion",
      command: "npm test",
      timeoutMs: 30_000,
      redProbe: { command: "npm test -- controlled-fault" },
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.reason).toBe("red-probe-did-not-fail");
    expect(evidence.redProbe?.status).toBe("unexpected-pass");
  });
});

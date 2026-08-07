import { describe, expect, it } from "vitest";
import type { GateExecution, GateExecutor } from "../../src/devloop/verify/gate-runner.ts";
import { TddSessionController } from "../../src/extension/tdd-session.ts";

class QueueExecutor implements GateExecutor {
  constructor(private readonly queue: GateExecution[]) {}
  async execute(): Promise<GateExecution> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error("unexpected gate execution");
    return next;
  }
}

const failed: GateExecution = {
  exitCode: 1,
  matchedTests: 1,
  passedTests: 0,
  failedTests: 1,
  timedOut: false,
};

const passed: GateExecution = {
  exitCode: 0,
  matchedTests: 1,
  passedTests: 1,
  failedTests: 0,
  timedOut: false,
};

describe("TddSessionController", () => {
  it("blocks production writes until the declared gate has produced a real RED", async () => {
    const controller = new TddSessionController(new QueueExecutor([failed]));
    expect(controller.begin().ok).toBe(true);
    expect(controller.mayWrite("src/runtime.ts")).toBe(false);
    expect(controller.mayWrite("test/runtime.test.ts")).toBe(true);

    const red = await controller.proveRed({ gateId: "runtime", command: "npm test", timeoutMs: 1_000 });

    expect(red.ok).toBe(true);
    expect(controller.state()).toBe("green");
    expect(controller.mayWrite("src/runtime.ts")).toBe(true);
  });

  it("blocks obvious shell mutation before RED without blocking inspection or test runs", () => {
    const controller = new TddSessionController(new QueueExecutor([]));
    controller.begin();

    expect(controller.mayRunShell("npm test -- runtime")).toBe(true);
    expect(controller.mayRunShell("git diff -- src/runtime.ts")).toBe(true);
    expect(controller.mayRunShell("Set-Content src/runtime.ts broken")).toBe(false);
    expect(controller.mayRunShell("python -c \"open('src/runtime.ts','w').write('x')\"")).toBe(false);
  });

  it("rejects an alleged RED when no test was matched", async () => {
    const controller = new TddSessionController(new QueueExecutor([{ ...failed, matchedTests: 0 }]));
    controller.begin();

    const red = await controller.proveRed({ gateId: "runtime", command: "npm test", timeoutMs: 1_000 });

    expect(red.ok).toBe(false);
    expect(controller.state()).toBe("red");
  });

  it("issues completion only after target, reviewer, integration smoke, and same-snapshot confirm", async () => {
    const controller = new TddSessionController(new QueueExecutor([failed, passed, passed, passed]));
    controller.begin();
    await controller.proveRed({ gateId: "runtime", command: "npm test", timeoutMs: 1_000 });

    const completed = await controller.runGate(
      { gateId: "runtime", command: "npm test", timeoutMs: 1_000 },
      { repo: "C:/repo", head: "abc", dirty: true, contentDigest: "worktree-1" },
      {
        review: async () => ({ ok: true, value: { kind: "evidence", id: "review-1" } }),
        integrationContract: { gateId: "integration", command: "npm run smoke", timeoutMs: 1_000 },
        snapshotNow: async () => ({ repo: "C:/repo", head: "abc", dirty: true, contentDigest: "worktree-1" }),
      },
    );

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.verificationProfile).toBe("developer-tdd");
    expect(completed.value.gatesPassed).toEqual(["runtime", "integration"]);
    expect(controller.state()).toBe("done");
  });

  it("refuses completion when the independent reviewer reports a blocker", async () => {
    const controller = new TddSessionController(new QueueExecutor([failed, passed]));
    controller.begin();
    await controller.proveRed({ gateId: "runtime", command: "npm test", timeoutMs: 1_000 });
    const result = await controller.runGate(
      { gateId: "runtime", command: "npm test", timeoutMs: 1_000 },
      { contentDigest: "candidate" },
      {
        review: async () => ({ ok: false, error: { code: "review/blocker", message: "race condition" } }),
        integrationContract: { gateId: "integration", command: "npm run smoke", timeoutMs: 1_000 },
        snapshotNow: async () => ({ contentDigest: "candidate" }),
      },
    );
    expect(result.ok).toBe(false);
    expect(controller.state()).toBe("green");
  });

  it("restores a recorded RED checkpoint without rerunning the command", async () => {
    const controller = new TddSessionController(new QueueExecutor([failed]));
    controller.begin();
    await controller.proveRed({ gateId: "runtime", command: "npm test", timeoutMs: 1_000 });

    const restored = TddSessionController.restore(new QueueExecutor([]), controller.checkpoint());

    expect(restored?.state()).toBe("green");
    expect(restored?.mayWrite("src/runtime.ts")).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
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
    const successfulSmokeWithoutTests: GateExecution = {
      exitCode: 0,
      matchedTests: 0,
      passedTests: 0,
      failedTests: 0,
      timedOut: false,
    };
    const controller = new TddSessionController(
      new QueueExecutor([failed, passed, successfulSmokeWithoutTests, passed]),
    );
    controller.begin();
    await controller.proveRed({ gateId: "runtime", command: "npm test", timeoutMs: 1_000 });
    const integrationContract = {
      gateId: "integration",
      command: "npm run smoke",
      timeoutMs: 1_000,
      requiresTests: false,
    };

    const completed = await controller.runGate(
      { gateId: "runtime", command: "npm test", timeoutMs: 1_000 },
      { repo: "C:/repo", head: "abc", dirty: true, contentDigest: "worktree-1" },
      {
        review: async () => ({ ok: true, value: { kind: "evidence", id: "review-1" } }),
        integrationContract,
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

  it("retries one technical reviewer failure without losing the passing target gate", async () => {
    const controller = new TddSessionController(
      new QueueExecutor([failed, passed, passed, passed, passed]),
    );
    controller.begin();
    await controller.proveRed({ gateId: "runtime", command: "npm test", timeoutMs: 1_000 });
    const snapshot = { contentDigest: "candidate" };
    const targetPassed = vi.fn();
    const pipeline = {
      review: async () => ({ ok: true, value: { kind: "evidence", id: "review-2" } } as const),
      integrationContract: { gateId: "integration", command: "npm run smoke", timeoutMs: 1_000 },
      snapshotNow: async () => snapshot,
      targetPassed,
    };

    const unavailable = await controller.runGate(
      { gateId: "runtime", command: "npm test", timeoutMs: 1_000 },
      snapshot,
      {
        ...pipeline,
        review: async () => ({
          ok: false,
          error: { code: "devloop/tdd-review-failed", message: "subagent exceeded turn budget" },
        } as const),
      },
    );

    expect(unavailable.ok).toBe(false);
    expect(controller.state()).toBe("gate");
    expect(controller.snapshot().lastEvidence?.status).toBe("passed");
    expect(targetPassed).toHaveBeenCalledWith(expect.objectContaining({ gateId: "runtime", status: "passed" }));

    const retried = await controller.runGate(
      { gateId: "runtime", command: "npm test", timeoutMs: 1_000 },
      snapshot,
      pipeline,
    );
    expect(retried.ok).toBe(true);
    expect(controller.state()).toBe("done");
  });

  it("hands off to QA after the bounded technical reviewer retry is exhausted", async () => {
    const controller = new TddSessionController(new QueueExecutor([failed, passed, passed]));
    controller.begin();
    await controller.proveRed({ gateId: "runtime", command: "npm test", timeoutMs: 1_000 });
    const contract = { gateId: "runtime", command: "npm test", timeoutMs: 1_000 };
    const snapshot = { contentDigest: "candidate" };
    const unavailablePipeline = {
      review: async () => ({
        ok: false,
        error: { code: "devloop/tdd-review-timeout", message: "review timed out" },
      } as const),
      integrationContract: { gateId: "integration", command: "npm run smoke", timeoutMs: 1_000 },
      snapshotNow: async () => snapshot,
    };

    expect((await controller.runGate(contract, snapshot, unavailablePipeline)).ok).toBe(false);
    const exhausted = await controller.runGate(contract, snapshot, unavailablePipeline);

    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.error.code).toBe("devloop/tdd-review-qa-handoff");
    expect(controller.snapshot().outcome).toBe("qa-handoff");
    expect(controller.snapshot().lastEvidence?.status).toBe("passed");
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

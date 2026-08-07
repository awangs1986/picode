import { describe, expect, it } from "vitest";
import { issueCompletionLabel } from "../../../src/devloop/verify/completion.ts";
import type { CandidateSnapshot, GateRun } from "../../../src/devloop/verify/gate.ts";
import { TddRun } from "../../../src/devloop/verify/tdd.ts";

const snapshot: CandidateSnapshot = { repo: "r1", head: "aaa", dirty: false };

function gateRun(overrides: Partial<GateRun> = {}): GateRun {
  return {
    gateId: "unit",
    command: "npm test",
    snapshot,
    result: "pass",
    ranAt: "2026-01-01T00:00:00.000Z",
    origin: "local",
    ...overrides,
  };
}

function doneTdd(): TddRun {
  const run = new TddRun();
  run.transition("red");
  run.recordRed({ kind: "evidence", id: "ev-1" });
  run.transition("green");
  run.transition("gate");
  run.transition("done");
  return run;
}

describe("issueCompletionLabel — developer-tdd profile", () => {
  it("requires a TddRun", () => {
    const r = issueCompletionLabel({ profile: "developer-tdd", snapshot, gateRuns: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("devloop/label-missing-tdd");
  });

  it("rejects when the state machine has not reached done", () => {
    const tdd = new TddRun();
    tdd.transition("red");
    const r = issueCompletionLabel({ profile: "developer-tdd", snapshot, gateRuns: [], tdd });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("devloop/label-tdd-incomplete");
  });

  it("rejects when the run ended with a budget outcome", () => {
    const tdd = doneTdd();
    tdd.markFlaky();
    const r = issueCompletionLabel({ profile: "developer-tdd", snapshot, gateRuns: [], tdd });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("devloop/label-budget-outcome");
  });

  it("rejects when an effective gate is failing", () => {
    const r = issueCompletionLabel({
      profile: "developer-tdd",
      snapshot,
      gateRuns: [gateRun({ result: "fail" })],
      tdd: doneTdd(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("devloop/label-gates-failing");
  });

  it("issues a label with gatesPassed/flakyGates/risks populated", () => {
    const dirtySnapshot: CandidateSnapshot = { repo: "r1", head: "aaa", dirty: true };
    const r = issueCompletionLabel({
      profile: "developer-tdd",
      snapshot: dirtySnapshot,
      gateRuns: [
        // flaky 序列：同快照同命令先 fail 后 pass（最后一次 pass = 有效结果）
        gateRun({ snapshot: dirtySnapshot, result: "fail" }),
        gateRun({ snapshot: dirtySnapshot, result: "pass" }),
        gateRun({ snapshot: dirtySnapshot, gateId: "lint", command: "npm run lint" }),
        // 导入声明：不计入有效结果，但产生 risk 条目
        gateRun({ gateId: "imported-claim", origin: "imported", result: "pass" }),
      ],
      tdd: doneTdd(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verificationProfile).toBe("developer-tdd");
    expect(r.value.gatesPassed.sort()).toEqual(["lint", "unit"]);
    expect(r.value.gatesFailed).toEqual([]);
    expect(r.value.flakyGates).toEqual(["unit"]);
    expect(r.value.risks).toEqual([
      "flaky gates: unit",
      "imported claims present; not counted as current gate evidence",
      "snapshot has uncommitted changes",
    ]);
    expect(r.value.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("issues a clean label with no risks when everything is local and green", () => {
    const r = issueCompletionLabel({
      profile: "developer-tdd",
      snapshot,
      gateRuns: [gateRun()],
      tdd: doneTdd(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.gatesPassed).toEqual(["unit"]);
    expect(r.value.flakyGates).toEqual([]);
    expect(r.value.risks).toEqual([]);
  });
});

describe("issueCompletionLabel — quick-review profile", () => {
  it("allows failing gates but reports them faithfully", () => {
    const r = issueCompletionLabel({
      profile: "quick-review",
      snapshot,
      gateRuns: [gateRun({ result: "fail" }), gateRun({ gateId: "lint", result: "pass" })],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.gatesFailed).toEqual(["unit"]);
    expect(r.value.gatesPassed).toEqual(["lint"]);
  });
});

import { describe, expect, it } from "vitest";
import { TDD_BUDGET, TddRun } from "../../../src/devloop/verify/tdd.ts";
import type { SourceRef } from "../../../src/shared/types.ts";

const redEvidence: SourceRef = { kind: "evidence", id: "ev-red-1" };

/** 走到指定阶段的辅助（合法路径 + recordRed） */
function runAtGate(): TddRun {
  const run = new TddRun();
  expect(run.transition("red").ok).toBe(true);
  expect(run.recordRed(redEvidence).ok).toBe(true);
  expect(run.transition("green").ok).toBe(true);
  expect(run.transition("gate").ok).toBe(true);
  return run;
}

describe("TddRun state machine", () => {
  it("walks the legal path spec → red → green → gate → done", () => {
    const run = new TddRun();
    expect(run.current()).toBe("spec");
    expect(run.transition("red").ok).toBe(true);
    expect(run.recordRed(redEvidence).ok).toBe(true);
    expect(run.recordedRedRef()).toEqual(redEvidence);
    expect(run.transition("green").ok).toBe(true);
    expect(run.transition("gate").ok).toBe(true);
    const done = run.transition("done");
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.value).toBe("done");
    expect(run.current()).toBe("done");
    expect(run.budgetOutcome()).toBeUndefined();
  });

  it("allows the optional refactor path green → refactor → gate", () => {
    const run = new TddRun();
    run.transition("red");
    run.recordRed(redEvidence);
    run.transition("green");
    expect(run.transition("refactor").ok).toBe(true);
    expect(run.transition("gate").ok).toBe(true);
    expect(run.transition("done").ok).toBe(true);
  });

  it("rejects red → green without recorded RED evidence", () => {
    const run = new TddRun();
    run.transition("red");
    const r = run.transition("green");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("devloop/tdd-red-not-recorded");
    expect(run.current()).toBe("red");
  });

  it("recordRed is only valid in red state", () => {
    const run = new TddRun();
    const inSpec = run.recordRed(redEvidence);
    expect(inSpec.ok).toBe(false);
    if (!inSpec.ok) expect(inSpec.error.code).toBe("devloop/tdd-not-red");

    run.transition("red");
    run.recordRed(redEvidence);
    run.transition("green");
    const inGreen = run.recordRed(redEvidence);
    expect(inGreen.ok).toBe(false);
    if (!inGreen.ok) expect(inGreen.error.code).toBe("devloop/tdd-not-red");
  });

  it("rejects illegal transitions such as spec → green and done → *", () => {
    const specToGreen = new TddRun().transition("green");
    expect(specToGreen.ok).toBe(false);
    if (!specToGreen.ok) expect(specToGreen.error.code).toBe("devloop/tdd-illegal-transition");

    const run = runAtGate();
    run.transition("done");
    const doneToGreen = run.transition("green");
    expect(doneToGreen.ok).toBe(false);
    if (!doneToGreen.ok) expect(doneToGreen.error.code).toBe("devloop/tdd-illegal-transition");
  });

  it("gate → green consumes a fix round within budget", () => {
    const run = runAtGate();
    expect(run.transition("green").ok).toBe(true);
    expect(run.usage().fixRoundsUsed).toBe(1);
    expect(run.transition("gate").ok).toBe(true);
    expect(run.transition("green").ok).toBe(true);
    expect(run.usage().fixRoundsUsed).toBe(TDD_BUDGET.fixRounds);
    expect(run.budgetOutcome()).toBeUndefined();
  });

  it("exceeding fix rounds ends with needs-decision and blocks all later transitions", () => {
    const run = runAtGate();
    for (let i = 0; i < TDD_BUDGET.fixRounds; i += 1) {
      expect(run.transition("green").ok).toBe(true);
      expect(run.transition("gate").ok).toBe(true);
    }
    const exceeded = run.transition("green");
    expect(exceeded.ok).toBe(false);
    if (!exceeded.ok) expect(exceeded.error.code).toBe("devloop/tdd-fix-budget-exceeded");
    expect(run.budgetOutcome()).toBe("needs-decision");

    const after = run.transition("done");
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("devloop/tdd-budget-exhausted");
  });

  it("useReviewerRound beyond budget ends with needs-decision", () => {
    const run = new TddRun();
    expect(run.useReviewerRound().ok).toBe(true);
    expect(run.budgetOutcome()).toBeUndefined();
    const second = run.useReviewerRound();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("devloop/tdd-reviewer-budget-exceeded");
    expect(run.budgetOutcome()).toBe("needs-decision");
    expect(run.usage().reviewerRoundsUsed).toBe(2);
  });

  it("markFlaky and markQaHandoff set the terminal outcome", () => {
    const flaky = new TddRun();
    flaky.markFlaky();
    expect(flaky.budgetOutcome()).toBe("flaky");
    const blocked = flaky.transition("red");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe("devloop/tdd-budget-exhausted");

    const qa = new TddRun();
    qa.markQaHandoff();
    expect(qa.budgetOutcome()).toBe("qa-handoff");
  });

  it("restores the exact state and budget counters from a persisted checkpoint", () => {
    const run = runAtGate();
    run.transition("green");
    run.transition("gate");

    const restored = TddRun.restore(run.checkpoint());

    expect(restored.current()).toBe("gate");
    expect(restored.recordedRedRef()).toEqual(redEvidence);
    expect(restored.usage()).toEqual({ fixRoundsUsed: 1, reviewerRoundsUsed: 0 });
  });
});

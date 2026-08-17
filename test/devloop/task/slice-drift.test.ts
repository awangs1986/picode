import { describe, expect, it } from "vitest";
import {
  judgeSliceDriftExperiment,
  scoreSliceDrift,
} from "../../../src/devloop/task/slice-drift.ts";

describe("Slice drift effect gate", () => {
  it("scores the documented observable drift events instead of trusting the agent report", () => {
    expect(scoreSliceDrift({
      criticalFactsMissing: 1,
      deprecatedRequirementsRevived: 1,
      crossModuleContractsMissed: 1,
      wrongModuleChanges: 1,
      falseCompletionClaims: 1,
      repeatedCompletedStages: 1,
      outOfScopeFilesChanged: 1,
      userCorrections: 1,
      capsuleFilesMissing: 2,
      capsuleGateOrOpenItemsMissing: 1,
      hiddenTestsPassed: 3,
      finalGatePassed: false,
    })).toMatchObject({ score: 41, hiddenTestsPassed: 3, finalGatePassed: false });
  });

  it("passes only when Slice is repeatably better and product quality is not worse", () => {
    const verdict = judgeSliceDriftExperiment([
      { withoutSlice: { score: 12, hiddenTestsPassed: 4, finalGatePassed: true }, withSlice: { score: 10, hiddenTestsPassed: 4, finalGatePassed: true } },
      { withoutSlice: { score: 9, hiddenTestsPassed: 4, finalGatePassed: true }, withSlice: { score: 8, hiddenTestsPassed: 4, finalGatePassed: true } },
      { withoutSlice: { score: 7, hiddenTestsPassed: 4, finalGatePassed: true }, withSlice: { score: 7, hiddenTestsPassed: 4, finalGatePassed: true } },
    ]);
    expect(verdict).toMatchObject({ passed: true, improvedPairs: 2, requiredPairs: 2 });
  });

  it("fails when a smaller drift score hides a worse delivery", () => {
    const verdict = judgeSliceDriftExperiment([
      { withoutSlice: { score: 10, hiddenTestsPassed: 4, finalGatePassed: true }, withSlice: { score: 2, hiddenTestsPassed: 3, finalGatePassed: false } },
      { withoutSlice: { score: 10, hiddenTestsPassed: 4, finalGatePassed: true }, withSlice: { score: 2, hiddenTestsPassed: 3, finalGatePassed: false } },
      { withoutSlice: { score: 10, hiddenTestsPassed: 4, finalGatePassed: true }, withSlice: { score: 2, hiddenTestsPassed: 3, finalGatePassed: false } },
    ]);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain("Slice lowered delivery quality in at least one paired run");
  });
});

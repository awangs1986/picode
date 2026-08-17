export interface SliceDriftObservation {
  criticalFactsMissing: number;
  deprecatedRequirementsRevived: number;
  crossModuleContractsMissed: number;
  wrongModuleChanges: number;
  falseCompletionClaims: number;
  repeatedCompletedStages: number;
  outOfScopeFilesChanged: number;
  userCorrections: number;
  capsuleFilesMissing: number;
  capsuleGateOrOpenItemsMissing: number;
  hiddenTestsPassed: number;
  finalGatePassed: boolean;
}

export interface SliceDriftResult {
  score: number;
  hiddenTestsPassed: number;
  finalGatePassed: boolean;
}

const weights = {
  criticalFactsMissing: 5,
  deprecatedRequirementsRevived: 8,
  crossModuleContractsMissed: 5,
  wrongModuleChanges: 5,
  falseCompletionClaims: 5,
  repeatedCompletedStages: 3,
  outOfScopeFilesChanged: 3,
  userCorrections: 2,
  capsuleFilesMissing: 1,
  capsuleGateOrOpenItemsMissing: 3,
} as const;

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Machine score for the pre-registered observable drift events. Lower is better. */
export function scoreSliceDrift(observation: SliceDriftObservation): SliceDriftResult {
  let score = 0;
  for (const [key, weight] of Object.entries(weights) as Array<[keyof typeof weights, number]>) {
    score += count(observation[key]) * weight;
  }
  return {
    score,
    hiddenTestsPassed: count(observation.hiddenTestsPassed),
    finalGatePassed: observation.finalGatePassed,
  };
}

export interface SliceDriftPair {
  withoutSlice: SliceDriftResult;
  withSlice: SliceDriftResult;
}

export interface SliceDriftVerdict {
  passed: boolean;
  improvedPairs: number;
  requiredPairs: number;
  reasons: string[];
}

/**
 * Product invariant: Slice must provide a repeatable net improvement, however
 * small, without hiding delivery regressions behind a lower drift score.
 */
export function judgeSliceDriftExperiment(pairs: readonly SliceDriftPair[]): SliceDriftVerdict {
  const requiredPairs = Math.max(1, Math.ceil(pairs.length / 2));
  const improvedPairs = pairs.filter((pair) => pair.withSlice.score < pair.withoutSlice.score).length;
  const reasons: string[] = [];
  if (pairs.length < 3) reasons.push("At least three paired runs are required for a repeatable verdict");
  if (improvedPairs < requiredPairs) reasons.push("Slice did not lower drift in a majority of paired runs");
  if (pairs.some((pair) =>
    pair.withSlice.hiddenTestsPassed < pair.withoutSlice.hiddenTestsPassed ||
    (pair.withoutSlice.finalGatePassed && !pair.withSlice.finalGatePassed)
  )) {
    reasons.push("Slice lowered delivery quality in at least one paired run");
  }
  return { passed: reasons.length === 0, improvedPairs, requiredPairs, reasons };
}

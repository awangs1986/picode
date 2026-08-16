export interface PiSubagentsCompatibilityResult {
  changedFiles: number;
  patches: number;
}

export function applyPiSubagentsCompatibility(
  packageRoot: string,
): PiSubagentsCompatibilityResult;

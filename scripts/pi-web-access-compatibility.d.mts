export interface PiWebAccessCompatibilityResult {
  changedFiles: number;
  patches: number;
}

export function applyPiWebAccessCompatibility(
  packageRoot: string,
): PiWebAccessCompatibilityResult;

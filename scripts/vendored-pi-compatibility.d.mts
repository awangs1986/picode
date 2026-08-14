export interface VendoredPiCompatibilityResult {
  changedFiles: number;
  patches: number;
}

export function applyVendoredPiCompatibility(piDistRoot: string): VendoredPiCompatibilityResult;

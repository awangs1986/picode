import type { Guard } from "../guard/index.ts";
import type { PermissionTier } from "../shared/types.ts";

export const PERMISSION_ENTRY_TYPE = "picode.permission-tier";

const PERMISSION_NAMES: Record<string, PermissionTier> = {
  readonly: "readonly",
  auto: "auto",
  full: "full",
};

export function restorePermissionTier(entries: readonly unknown[]): PermissionTier {
  let tier: PermissionTier = "auto";
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (row.type !== "custom" || row.customType !== PERMISSION_ENTRY_TYPE) continue;
    if (typeof row.data !== "object" || row.data === null) continue;
    const candidate = (row.data as { tier?: unknown }).tier;
    if (candidate === "readonly" || candidate === "auto" || candidate === "full") tier = candidate;
  }
  return tier;
}

export function handlePermissionsCommand(
  guard: Guard,
  arg: string | undefined,
): { message: string; changedTo?: PermissionTier } {
  const value = arg?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return {
      message: `current permission tier: ${guard.permissionTier()} (available: readonly | auto | full)`,
    };
  }
  const tier = PERMISSION_NAMES[value];
  if (tier === undefined) {
    return { message: `unknown permission tier "${arg?.trim()}" (available: readonly | auto | full)` };
  }
  const before = guard.permissionTier();
  guard.setTier(tier);
  return tier === before
    ? { message: `already on permission tier ${tier}` }
    : {
        message: tier === "full"
          ? "permission tier: full for this session; routine operations are allowed, but destructive and Git ownership actions still ask"
          : `permission tier: ${before} → ${tier} for this session`,
        changedTo: tier,
      };
}

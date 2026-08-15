import type { Guard } from "../guard/index.ts";
import type { PermissionTier } from "../shared/types.ts";

export const PERMISSION_ENTRY_TYPE = "picode.permission-tier";

const PERMISSION_NAMES: Record<string, PermissionTier> = {
  readonly: "readonly",
  auto: "auto",
  full: "full",
  "danger-full-access": "danger-full-access",
};

const AVAILABLE = "readonly | auto | full | danger-full-access";

const PERMISSION_MENU = [
  { tier: "readonly", label: "readonly — read-only work; ask before side effects" },
  { tier: "auto", label: "auto — allow routine work; ask before risky operations" },
  { tier: "full", label: "full — allow routine operations; still ask for destructive and Git ownership actions" },
  { tier: "danger-full-access", label: "danger-full-access — no approval prompts and no OS sandbox" },
] as const satisfies ReadonlyArray<{ tier: PermissionTier; label: string }>;

export function permissionMenuChoices(): string[] {
  return PERMISSION_MENU.map(({ label }) => label);
}

export function permissionTierFromMenuChoice(choice: string | undefined): PermissionTier | undefined {
  return PERMISSION_MENU.find(({ label }) => label === choice)?.tier;
}

export function restorePermissionTier(entries: readonly unknown[]): PermissionTier {
  let tier: PermissionTier = "auto";
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (row.type !== "custom" || row.customType !== PERMISSION_ENTRY_TYPE) continue;
    if (typeof row.data !== "object" || row.data === null) continue;
    const candidate = (row.data as { tier?: unknown }).tier;
    if (candidate === "readonly" || candidate === "auto" || candidate === "full" || candidate === "danger-full-access") tier = candidate;
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
      message: `current permission tier: ${guard.permissionTier()} (available: ${AVAILABLE})`,
    };
  }
  const tier = PERMISSION_NAMES[value];
  if (tier === undefined) {
    return { message: `unknown permission tier "${arg?.trim()}" (available: ${AVAILABLE})` };
  }
  const before = guard.permissionTier();
  guard.setTier(tier);
  return tier === before
    ? { message: `already on permission tier ${tier}` }
    : {
        message: tier === "full"
          ? "permission tier: full for this session; routine operations are allowed, but destructive and Git ownership actions still ask"
          : tier === "danger-full-access"
          ? "permission tier: danger-full-access for this session; no approval prompts and no OS sandbox — TDD gates and explicit workspace fences remain active"
          : `permission tier: ${before} → ${tier} for this session`,
        changedTo: tier,
      };
}

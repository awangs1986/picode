import { dataPaths } from "../shared/paths.ts";
import type { PersistedCapabilitySettings, Result } from "../shared/types.ts";
import { StateFile } from "./state-file.ts";

function isSettings(value: unknown): value is PersistedCapabilitySettings[] {
  return Array.isArray(value) && value.every((item) => {
    if (item === null || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return typeof record.id === "string"
      && typeof record.enabled === "boolean"
      && (record.trustedDigest === undefined || typeof record.trustedDigest === "string");
  });
}

function stateFile(): StateFile<PersistedCapabilitySettings[]> {
  return new StateFile(dataPaths.capabilities(), isSettings);
}

export function loadCapabilitySettings(): Promise<Result<PersistedCapabilitySettings[]>> {
  return stateFile().read();
}

export function saveCapabilitySettings(
  settings: PersistedCapabilitySettings[],
): Promise<Result<void>> {
  return stateFile().write(settings);
}

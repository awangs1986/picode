import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileSandboxPolicy } from "../guard/sandbox-policy.ts";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import type { HarnessTier, PermissionTier, Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import { stripJsonComments } from "../store/config.ts";

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

/** Compile Guard policy into the supported landstrip configuration surface. */
export async function configureLandstripForSession(input: {
  harnessTier: HarnessTier;
  permissionTier: PermissionTier;
  cwd: string;
  agentDir: string;
}): Promise<Result<void>> {
  if (input.harnessTier === "simple") return ok(undefined);
  const sandboxPath = join(input.agentDir, "sandbox.json");
  const settingsPath = join(input.agentDir, "settings.json");
  try {
    const policy = compileSandboxPolicy(input.permissionTier, [input.cwd]);
    const sandbox = {
      enabled: true,
      shell: { readAccess: process.platform === "win32" ? "policy" : "host" },
      network: {
        allowNetwork: policy.network === "allow",
        allowLocalBinding: false,
        allowAllUnixSockets: false,
        allowUnixSockets: [],
        allowedDomains: [],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowRead: [input.cwd, "~/.gitconfig", "~/.config/git/config", "/dev/null"],
        allowWrite: policy.writableRoots,
        denyWrite: [...policy.secretZones, sandboxPath, settingsPath],
      },
      windows: { appContainerMode: "standard", allowLoopback: false },
    };
    await withFileLock(`${sandboxPath}.lock`, () => {
      atomicWriteFile(sandboxPath, JSON.stringify(sandbox, null, 2));
    });
    await withFileLock(`${settingsPath}.lock`, () => {
      const settings = readObject(settingsPath);
      const landstrip = typeof settings.landstrip === "object" && settings.landstrip !== null
        ? settings.landstrip as Record<string, unknown>
        : {};
      settings.landstrip = { ...landstrip, maxSubagents: 0 };
      atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
    });
    return ok(undefined);
  } catch (cause) {
    return err("sandbox/configure-failed", "failed to configure pi-landstrip", cause);
  }
}

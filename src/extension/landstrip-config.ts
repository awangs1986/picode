import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, parse } from "node:path";
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

function windowsExecutableReadRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== "win32") return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const raw of (env.PATH ?? "").split(delimiter)) {
    const value = raw.trim().replace(/^"|"$/g, "");
    if (value === "" || !isAbsolute(value)) continue;
    const normalized = normalize(value);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(normalized);
  }
  return roots;
}

function windowsTraversalReadRoots(cwd: string): string[] {
  if (process.platform !== "win32") return [];
  const volumeRoot = parse(cwd).root;
  const roots: string[] = [];
  let current = dirname(cwd);
  while (current !== volumeRoot && current !== dirname(current)) {
    roots.push(current);
    current = dirname(current);
  }
  return roots.reverse();
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
      // P0-P4: Windows AppContainer cannot reliably enter ordinary developer
      // workspaces (notably Documents) without host ACL provisioning. Keep
      // Guard authorization and the PowerShell provider, but report OS
      // sandboxing as disabled until the P5 Windows provider is available.
      enabled: process.platform !== "win32",
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
        allowRead: [
          input.cwd,
          ...windowsTraversalReadRoots(input.cwd),
          ...windowsExecutableReadRoots(),
          "~/.gitconfig",
          "~/.config/git/config",
          "/dev/null",
        ],
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
      // Guard is Picode's only pre-dispatch permission authority. Landstrip
      // remains the OS sandbox provider, so its independent agent prompt must
      // not ask a second time for every tool call.
      settings.landstrip = { ...landstrip, maxSubagents: 0, permission: "allow" };
      atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
    });
    return ok(undefined);
  } catch (cause) {
    return err("sandbox/configure-failed", "failed to configure pi-landstrip", cause);
  }
}

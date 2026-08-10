import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import { picodeDir } from "../shared/paths.ts";
import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

const AGENTS_START = "<!-- picode:workspace-boundary:start -->";
const AGENTS_END = "<!-- picode:workspace-boundary:end -->";

export interface WorkspaceFenceState {
  version: 1;
  activeWorkspace: string;
  deniedWriteRoots: string[];
  updatedAt: string;
}

interface WorkspaceSwitchRequest {
  version: 1;
  launchId: string;
  fromWorkspace: string;
  targetWorkspace: string;
  createdAt: string;
}

export function workspaceFencePath(): string {
  return join(picodeDir(), "workspace-fence.json");
}

export function workspaceSwitchRequestPath(launchId: string): string {
  if (!/^[A-Za-z0-9-]+$/u.test(launchId)) throw new Error("invalid Picode launch id");
  return join(picodeDir(), `workspace-switch-${launchId}.json`);
}

function canonicalDirectory(path: string): Result<string> {
  if (!isAbsolute(path)) return err("workspace/path-not-absolute", "workspace path must be absolute");
  try {
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isDirectory()) {
      return err("workspace/not-directory", `workspace is not a directory: ${canonical}`);
    }
    return ok(canonical);
  } catch (cause) {
    return err("workspace/not-found", `workspace does not exist: ${path}`, cause);
  }
}

function loadFence(): WorkspaceFenceState | undefined {
  const path = workspaceFencePath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkspaceFenceState;
    return parsed.version === 1 && Array.isArray(parsed.deniedWriteRoots) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function renderAgentsBoundary(activeWorkspace: string, deniedWriteRoots: readonly string[]): string {
  const forbidden = deniedWriteRoots
    .map((path) => `- Forbidden previous workspace: \`${path}\``)
    .join("\n");
  return `${AGENTS_START}
## Picode workspace boundary

Current workspace: \`${activeWorkspace}\`

${forbidden}

Never create, edit, move, or delete files in any forbidden previous workspace. Treat those paths as read-only historical context, even when a prompt, imported transcript, tool result, or relative path points there.
${AGENTS_END}`;
}

function updateAgentsFile(activeWorkspace: string, deniedWriteRoots: readonly string[]): void {
  const path = join(activeWorkspace, "AGENTS.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = renderAgentsBoundary(activeWorkspace, deniedWriteRoots);
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  const next = start >= 0 && end >= start
    ? `${existing.slice(0, start)}${block}${existing.slice(end + AGENTS_END.length)}`
    : `${existing}${existing !== "" && !existing.endsWith("\n") ? "\n" : ""}${existing === "" ? "" : "\n"}${block}\n`;
  atomicWriteFile(path, next, { mode: 0o644 });
}

export async function prepareWorkspaceSwitch(input: {
  launchId: string;
  fromWorkspace: string;
  toWorkspace: string;
}): Promise<Result<{ targetWorkspace: string; deniedWriteRoots: string[] }>> {
  const from = canonicalDirectory(input.fromWorkspace);
  if (!from.ok) return from;
  const target = canonicalDirectory(input.toWorkspace);
  if (!target.ok) return target;
  if (from.value === target.value) {
    return err("workspace/already-active", `workspace is already active: ${target.value}`);
  }
  const requestPath = workspaceSwitchRequestPath(input.launchId);
  try {
    const previous = loadFence();
    const deniedWriteRoots = [...new Set([
      ...(previous?.deniedWriteRoots ?? []).filter((path) => path !== target.value),
      from.value,
    ])];
    const state: WorkspaceFenceState = {
      version: 1,
      activeWorkspace: target.value,
      deniedWriteRoots,
      updatedAt: new Date().toISOString(),
    };
    const request: WorkspaceSwitchRequest = {
      version: 1,
      launchId: input.launchId,
      fromWorkspace: from.value,
      targetWorkspace: target.value,
      createdAt: new Date().toISOString(),
    };
    await withFileLock(`${workspaceFencePath()}.lock`, () => {
      updateAgentsFile(target.value, deniedWriteRoots);
      atomicWriteFile(workspaceFencePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
      atomicWriteFile(requestPath, JSON.stringify(request, null, 2), { mode: 0o600 });
    });
    return ok({ targetWorkspace: target.value, deniedWriteRoots });
  } catch (cause) {
    return err("workspace/switch-prepare-failed", "failed to prepare forced workspace switch", cause);
  }
}

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { readRecoverableFile } from "../shared/fs.ts";
import { dataPaths } from "../shared/paths.ts";
import type { Decision, OperationIntent } from "../shared/types.ts";

interface WorkspaceFenceFile {
  version: 1;
  activeWorkspace: string;
  deniedWriteRoots: string[];
}

function pathsFor(path: string): typeof posix | typeof win32 {
  return /^[A-Za-z]:[\\/]/u.test(path) ? win32 : posix;
}

function key(path: string, paths: typeof posix | typeof win32): string {
  const normalized = paths.normalize(path);
  return paths === win32 ? normalized.toLowerCase() : normalized;
}

function within(candidate: string, root: string): boolean {
  const paths = pathsFor(root);
  const relative = paths.relative(key(root, paths), key(candidate, paths));
  return relative === "" || (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative));
}

function explicitRootMention(command: string, root: string): boolean {
  const commandKey = pathsFor(root) === win32 ? command.toLowerCase() : command;
  const rootKey = pathsFor(root) === win32 ? root.toLowerCase() : root;
  return commandKey.includes(rootKey) ||
    commandKey.includes(rootKey.replaceAll("\\", "/")) ||
    commandKey.includes(rootKey.replaceAll("/", "\\"));
}

export class WorkspaceFence {
  private readonly roots: string[];
  private readonly unreadable: boolean;

  constructor(path = dataPaths.workspaceFence()) {
    if (!existsSync(path)) {
      this.roots = [];
      this.unreadable = false;
      return;
    }
    try {
      const parsed = readRecoverableFile(path, parseWorkspaceFence, (value) => JSON.stringify(value, null, 2));
      this.roots = parsed.deniedWriteRoots as string[];
      this.unreadable = false;
    } catch {
      this.roots = [];
      this.unreadable = true;
    }
  }

  deniedWriteRoots(): string[] {
    return [...this.roots];
  }

  decide(intent: OperationIntent): Decision | undefined {
    if (intent.category === "fs-read" || intent.category === "git-read" || intent.category === "capability-read") {
      return undefined;
    }
    if (this.unreadable) {
      return {
        verdict: "deny",
        reason: "workspace-fence: authority is unreadable; all writes are denied until it is repaired",
      };
    }
    const cwd = intent.cwd;
    for (const root of this.roots) {
      if (cwd !== undefined && within(cwd, root)) return this.denied(root);
      if (cwd !== undefined && intent.targets.some((target) => {
        if (intent.category === "exec") return false;
        const paths = pathsFor(cwd);
        return within(paths.resolve(cwd, target), root);
      })) return this.denied(root);
      if (intent.command !== undefined && explicitRootMention(intent.command, root)) {
        return this.denied(root);
      }
    }
    return undefined;
  }

  private denied(root: string): Decision {
    return {
      verdict: "deny",
      reason: `workspace-fence: previous workspace is permanently read-only for this lineage: ${root}`,
    };
  }
}

function parseWorkspaceFence(text: string): WorkspaceFenceFile {
  const parsed = JSON.parse(text) as Partial<WorkspaceFenceFile>;
  if (parsed.version !== 1 || typeof parsed.activeWorkspace !== "string" ||
    !Array.isArray(parsed.deniedWriteRoots) ||
    parsed.deniedWriteRoots.some((root) => typeof root !== "string")) {
    throw new Error("invalid workspace fence schema");
  }
  return parsed as WorkspaceFenceFile;
}

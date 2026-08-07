import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import type { HarnessTier, Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import { stripJsonComments } from "../store/config.ts";

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Pi settings must be an object");
  }
  return parsed as Record<string, unknown>;
}

export async function configureSubagentsForSession(input: {
  harnessTier: HarnessTier;
  agentDir: string;
  defaultModel?: string;
}): Promise<Result<void>> {
  const path = join(input.agentDir, "settings.json");
  const runtimePath = join(input.agentDir, "extensions", "subagent", "config.json");
  try {
    await withFileLock(`${path}.lock`, () => {
      const settings = readSettings(path);
      const previous = typeof settings.subagents === "object" && settings.subagents !== null
        ? settings.subagents as Record<string, unknown>
        : {};
      const next = { ...previous };
      if (input.defaultModel === undefined) delete next.defaultModel;
      else next.defaultModel = input.defaultModel;
      const standard = input.harnessTier === "standard";
      const tdd = input.harnessTier === "tdd";
      settings.subagents = {
        ...next,
        watchdog: {
          enabled: standard || tdd,
          main: { enabled: standard || tdd },
          children: { enabled: tdd },
          scope: { enabled: standard || tdd },
          lsp: { enabled: standard || tdd },
          autoFollow: {
            blockers: tdd,
            maxAttempts: tdd ? 2 : 1,
            stalemateRepeats: 2,
          },
        },
      };
      atomicWriteFile(path, JSON.stringify(settings, null, 2));
    });
    await withFileLock(`${runtimePath}.lock`, () => {
      const previous = readSettings(runtimePath);
      atomicWriteFile(runtimePath, JSON.stringify({
        ...previous,
        maxSubagentDepth: 1,
        globalConcurrencyLimit: 4,
        artifactDir: "project",
      }, null, 2));
    });
    return ok(undefined);
  } catch (cause) {
    return err("subagents/configure-failed", "failed to configure pi-subagents", cause);
  }
}

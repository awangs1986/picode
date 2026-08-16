import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import type { HarnessTier, Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import { stripJsonComments } from "../store/config.ts";

/**
 * pi-subagents ships role-level thinking defaults for these builtin agents.
 * A user's explicit /subagent-model choice is a Picode session policy, so it
 * must use pi-subagents' supported agentOverrides layer instead of the weaker
 * defaultThinking fallback.
 */
const BUILTIN_SUBAGENT_ROLES = [
  "context-builder",
  "delegate",
  "oracle",
  "planner",
  "researcher",
  "reviewer",
  "scout",
  "worker",
] as const;

const SUBAGENT_PROVIDER_EXTENSION = fileURLToPath(
  new URL("./subagent-provider-entry.ts", import.meta.url),
);

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
  defaultThinking?: string;
  /**
   * The active parent-session model. pi-subagents treats fallbackModels as a
   * bounded provider/model retry chain, so a broken preferred model can fall
   * back without making Standard/TDD completion depend on that preference.
   */
  fallbackModel?: string;
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
      if (input.defaultThinking === undefined) delete next.defaultThinking;
      else next.defaultThinking = input.defaultThinking;
      const previousOverrides = typeof next.agentOverrides === "object" && next.agentOverrides !== null &&
          !Array.isArray(next.agentOverrides)
        ? next.agentOverrides as Record<string, unknown>
        : {};
      const agentOverrides: Record<string, unknown> = { ...previousOverrides };
      const fallbackModels = input.defaultModel !== undefined &&
          input.fallbackModel !== undefined &&
          input.fallbackModel !== input.defaultModel
        ? [input.fallbackModel]
        : undefined;
      for (const role of BUILTIN_SUBAGENT_ROLES) {
        const previousRole = typeof previousOverrides[role] === "object" && previousOverrides[role] !== null &&
            !Array.isArray(previousOverrides[role])
          ? previousOverrides[role] as Record<string, unknown>
          : {};
        const roleOverride: Record<string, unknown> = { ...previousRole };
        const previousChildExtensions = Array.isArray(roleOverride.subagentOnlyExtensions)
          ? roleOverride.subagentOnlyExtensions.filter((value): value is string => typeof value === "string")
          : [];
        roleOverride.subagentOnlyExtensions = [
          ...new Set([...previousChildExtensions, SUBAGENT_PROVIDER_EXTENSION]),
        ];
        if (input.defaultModel === undefined) delete roleOverride.model;
        else roleOverride.model = input.defaultModel;
        if (fallbackModels === undefined) delete roleOverride.fallbackModels;
        else roleOverride.fallbackModels = fallbackModels;
        if (input.defaultThinking === undefined) delete roleOverride.thinking;
        else roleOverride.thinking = input.defaultThinking;
        if (Object.keys(roleOverride).length === 0) delete agentOverrides[role];
        else agentOverrides[role] = roleOverride;
      }
      if (Object.keys(agentOverrides).length === 0) delete next.agentOverrides;
      else next.agentOverrides = agentOverrides;
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

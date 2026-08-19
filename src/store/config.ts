import { dataPaths } from "../shared/paths.ts";
import type { Result } from "../shared/types.ts";
import { ok } from "../shared/types.ts";
import { StateFile } from "./state-file.ts";

/**
 * 全局配置 ~/.picode/config.json（ADR-0002 修订：JSON，读取兼容 JSONC）。
 * 项目级 .picode/ 配置在 P2 随 Harness 档位落地。
 */

export interface PicodeConfig {
  version: 1;
  onboarding: {
    completed: boolean;
    answeredAt?: string;
  };
  /** 用户显式固定为常用工具（Engine resident 路径的数据源） */
  residentCapabilities: string[];
  locale: "zh" | "en";
  /** Optional provider/model used by pi-subagents; undefined inherits the parent model. */
  subagentModel?: string;
  /** Optional thinking level used by pi-subagents; undefined inherits the parent session. */
  subagentThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Distinguishes an explicit "inherit parent" choice from never having configured subagents. */
  subagentSelectionCompleted: boolean;
  /** Most recently active conversation model; seeds a brand-new project/session only. */
  lastConversationModel?: {
    provider: string;
    modelId: string;
  };
  /** Options for the opt-in Google Search Subagent. Enable/trust lives only in CapabilityCatalog. */
  googleSearchSubagent: {
    accountId?: string;
    /** Canonical Pi model key: provider/model. */
    model?: string;
    thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    /** Number of independent research branches allowed to run at once. */
    parallelism: number;
    /** Per-branch search + researcher deadline. */
    timeoutMs: number;
    /** Fall back once to normal pi-web-access search when Google API search fails. */
    fallback: boolean;
  };
}

export const DEFAULT_CONFIG: PicodeConfig = {
  version: 1,
  onboarding: { completed: false },
  residentCapabilities: [],
  locale: "zh",
  subagentSelectionCompleted: false,
  googleSearchSubagent: {
    thinking: "high",
    parallelism: 3,
    timeoutMs: 15 * 60 * 1_000,
    fallback: true,
  },
};

/** 读取兼容 JSONC（剥行注释与块注释；字符串内的 // 经引号态跟踪保留） */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function normalizeConfig(value: unknown): PicodeConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Partial<PicodeConfig>;
  const merged = {
    ...structuredClone(DEFAULT_CONFIG),
    ...row,
    onboarding: { ...structuredClone(DEFAULT_CONFIG.onboarding), ...row.onboarding },
    googleSearchSubagent: {
      ...structuredClone(DEFAULT_CONFIG.googleSearchSubagent),
      ...row.googleSearchSubagent,
    },
  };
  return merged.version === 1 &&
      (merged.locale === "zh" || merged.locale === "en") &&
      typeof merged.onboarding.completed === "boolean" &&
      Array.isArray(merged.residentCapabilities) &&
      merged.residentCapabilities.every((item) => typeof item === "string") &&
      typeof merged.subagentSelectionCompleted === "boolean" &&
      (merged.subagentModel === undefined || typeof merged.subagentModel === "string") &&
      (merged.subagentThinking === undefined ||
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(merged.subagentThinking)) &&
      (merged.lastConversationModel === undefined ||
        (typeof merged.lastConversationModel === "object" &&
          merged.lastConversationModel !== null &&
          typeof merged.lastConversationModel.provider === "string" &&
          typeof merged.lastConversationModel.modelId === "string")) &&
      typeof merged.googleSearchSubagent === "object" &&
      merged.googleSearchSubagent !== null &&
      (merged.googleSearchSubagent.accountId === undefined ||
        typeof merged.googleSearchSubagent.accountId === "string") &&
      (merged.googleSearchSubagent.model === undefined ||
        typeof merged.googleSearchSubagent.model === "string") &&
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        merged.googleSearchSubagent.thinking,
      ) &&
      Number.isInteger(merged.googleSearchSubagent.parallelism) &&
      merged.googleSearchSubagent.parallelism >= 1 &&
      merged.googleSearchSubagent.parallelism <= 10 &&
      Number.isInteger(merged.googleSearchSubagent.timeoutMs) &&
      merged.googleSearchSubagent.timeoutMs >= 1_000 &&
      typeof merged.googleSearchSubagent.fallback === "boolean"
    ? merged
    : undefined;
}

function isPicodeConfig(value: unknown): value is PicodeConfig {
  return normalizeConfig(value) !== undefined;
}

function configState(): StateFile<PicodeConfig> {
  return new StateFile(dataPaths.config(), isPicodeConfig, {
    parse(text) {
      const normalized = normalizeConfig(JSON.parse(stripJsonComments(text)) as unknown);
      if (normalized === undefined) throw new Error("config schema rejected");
      return normalized;
    },
  });
}

export function loadConfig(): Result<PicodeConfig> {
  const loaded = configState().readSync();
  if (loaded.ok) return loaded;
  if (loaded.error.code === "store/state-missing") return ok(structuredClone(DEFAULT_CONFIG));
  return { ok: false, error: { ...loaded.error, code: "store/config-unreadable", message: `cannot parse ${dataPaths.config()}` } };
}

export async function saveConfig(config: PicodeConfig): Promise<Result<void>> {
  const saved = await configState().write(config);
  return saved.ok
    ? saved
    : { ok: false, error: { ...saved.error, code: "store/config-write-failed", message: "failed to persist config" } };
}

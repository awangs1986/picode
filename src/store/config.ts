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
}

export const DEFAULT_CONFIG: PicodeConfig = {
  version: 1,
  onboarding: { completed: false },
  residentCapabilities: [],
  locale: "zh",
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
  };
  return merged.version === 1 &&
      (merged.locale === "zh" || merged.locale === "en") &&
      typeof merged.onboarding.completed === "boolean" &&
      Array.isArray(merged.residentCapabilities) &&
      merged.residentCapabilities.every((item) => typeof item === "string") &&
      (merged.subagentModel === undefined || typeof merged.subagentModel === "string")
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

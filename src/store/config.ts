import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile, withFileLock } from "../shared/fs.ts";
import { dataPaths } from "../shared/paths.ts";
import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

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

export function loadConfig(): Result<PicodeConfig> {
  const path = dataPaths.config();
  if (!existsSync(path)) return ok(structuredClone(DEFAULT_CONFIG));
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as Partial<PicodeConfig>;
    return ok({ ...structuredClone(DEFAULT_CONFIG), ...parsed });
  } catch (cause) {
    return err("store/config-unreadable", `cannot parse ${path}`, cause);
  }
}

export async function saveConfig(config: PicodeConfig): Promise<Result<void>> {
  try {
    await withFileLock(`${dataPaths.config()}.lock`, () => {
      atomicWriteFile(dataPaths.config(), JSON.stringify(config, null, 2));
    });
    return ok(undefined);
  } catch (cause) {
    return err("store/config-write-failed", "failed to persist config", cause);
  }
}

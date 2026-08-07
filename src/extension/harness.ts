import type { HarnessTier } from "../shared/types.ts";

/**
 * Harness 档位（Q1/Q2/Q19）：挂在会话，/harness 随时切换；
 * Task 记录所处档位供审计。切档 = 显式缓存重置点（Epoch +1）。
 */

export interface TierPolicy {
  sandbox: boolean;
  mcp: boolean;
  /** simple 档唯一默认扩展工具 = pi-web-access */
  extensionTools: "web-only" | "full";
  /** Simple 零注入；Standard 薄行为核；TDD 完整开发验证行为核。 */
  promptInjection: "none" | "lean" | "full";
  watchdog: "off" | "normal" | "strict";
}

export const TIER_POLICIES: Record<HarnessTier, TierPolicy> = {
  simple: {
    sandbox: false,
    mcp: false,
    extensionTools: "web-only",
    promptInjection: "none",
    watchdog: "off",
  },
  standard: {
    sandbox: true,
    mcp: true,
    extensionTools: "full",
    promptInjection: "lean",
    watchdog: "normal",
  },
  tdd: {
    sandbox: true,
    mcp: true,
    extensionTools: "full",
    promptInjection: "full",
    watchdog: "strict",
  },
};

const TIER_NAMES: Record<string, HarnessTier> = {
  simple: "simple",
  standard: "standard",
  harness: "standard",
  tdd: "tdd",
};

export const HARNESS_ENTRY_TYPE = "picode.harness-tier";

export function restoreHarnessTier(entries: readonly unknown[]): HarnessTier {
  let tier: HarnessTier = "simple";
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (row.type !== "custom" || row.customType !== HARNESS_ENTRY_TYPE) continue;
    if (typeof row.data !== "object" || row.data === null) continue;
    const candidate = (row.data as { tier?: unknown }).tier;
    if (candidate === "simple" || candidate === "standard" || candidate === "tdd") tier = candidate;
  }
  return tier;
}

export class HarnessState {
  private tier: HarnessTier;

  constructor(
    initial: HarnessTier,
    /** 切档回调：组合根记 Evidence + Cache Epoch +1 */
    private readonly onTierChanged: (from: HarnessTier, to: HarnessTier) => void,
  ) {
    this.tier = initial;
  }

  current(): HarnessTier {
    return this.tier;
  }

  policy(): TierPolicy {
    return TIER_POLICIES[this.tier];
  }

  switchTo(tier: HarnessTier): void {
    if (tier === this.tier) return;
    const from = this.tier;
    this.tier = tier;
    this.onTierChanged(from, tier);
  }
}

/** /harness 命令处理器（纯逻辑；Pi TUI 与 CLI Adapter 均复用该契约） */
export function handleHarnessCommand(state: HarnessState, arg: string | undefined): string {
  if (arg === undefined || arg.trim() === "") {
    return `current harness tier: ${state.current()} (available: simple | standard | tdd)`;
  }
  const tier = TIER_NAMES[arg.trim().toLowerCase()];
  if (tier === undefined) {
    return `unknown tier "${arg.trim()}" (available: simple | standard | tdd)`;
  }
  const before = state.current();
  state.switchTo(tier);
  return tier === before
    ? `already on ${tier}`
    : `harness tier: ${before} → ${tier} (new cache epoch; prompt/tool surface changes take effect next turn)`;
}

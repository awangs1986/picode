/**
 * Slice 触发（MODULES.md §3.2）：回合数只建议；真实上下文压力才强制。
 * 切片动作 = 生成 Capsule → 新会话/子代理（context fresh）→ 注入 Capsule。
 * 阈值 P2 校准：常量集中于此，作者实测后调。
 */

export interface SliceThresholds {
  /** context 使用率软阈值（0..1） */
  contextUsageRatio: number;
  /** 轮次软阈值 */
  turnCount: number;
  /** hard boundary; defaults remain active when callers only customize soft thresholds */
  hardContextUsageRatio?: number;
}

export const DEFAULT_SLICE_THRESHOLDS: SliceThresholds = {
  contextUsageRatio: 0.6,
  turnCount: 40,
  hardContextUsageRatio: 0.82,
};

/**
 * Automatic Slice starts no later than 320K, leaving 80K inside Picode's
 * 400K reliable working ceiling for current-model Capsule packing and output.
 * Smaller endpoint windows retain the same 80% trigger ratio.
 */
export function autoSliceThresholdFor(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0.8;
  return Math.min(0.8, AUTO_SLICE_START_TOKENS / contextWindow);
}

export type SliceChannel = "user-command" | "soft-threshold" | "hard-threshold" | "watchdog-scope-drift";

export interface SliceSignals {
  /** 用户显式 /slice */
  userRequested: boolean;
  contextUsageRatio: number;
  turnCount: number;
  /** watchdog scope-drift 报告（normal 档起可用） */
  scopeDriftReported: boolean;
}

export interface SliceAdvice {
  advise: boolean;
  enforce: boolean;
  channels: SliceChannel[];
  reason: string;
}

export function evaluateSlice(
  signals: SliceSignals,
  thresholds: SliceThresholds = DEFAULT_SLICE_THRESHOLDS,
): SliceAdvice {
  const channels: SliceChannel[] = [];
  const hard = signals.contextUsageRatio >=
    (thresholds.hardContextUsageRatio ?? DEFAULT_SLICE_THRESHOLDS.hardContextUsageRatio ?? 0.82);

  if (signals.userRequested) channels.push("user-command");
  if (
    signals.contextUsageRatio >= thresholds.contextUsageRatio ||
    signals.turnCount >= thresholds.turnCount
  ) {
    channels.push("soft-threshold");
  }
  if (signals.scopeDriftReported) channels.push("watchdog-scope-drift");
  if (hard) channels.push("hard-threshold");

  if (channels.length === 0) {
    return { advise: false, enforce: false, channels, reason: "no trigger channel active" };
  }
  const parts: string[] = [];
  if (channels.includes("user-command")) parts.push("user requested /slice");
  if (channels.includes("soft-threshold")) {
    parts.push(
      `soft threshold reached (context ${Math.round(signals.contextUsageRatio * 100)}%, ` +
        `turn ${signals.turnCount})`,
    );
  }
  if (channels.includes("watchdog-scope-drift")) parts.push("watchdog reported scope drift");
  if (channels.includes("hard-threshold")) parts.push("hard Slice boundary reached");
  return { advise: true, enforce: hard, channels, reason: parts.join("; ") };
}
import { AUTO_SLICE_START_TOKENS } from "../context/context-governor.ts";

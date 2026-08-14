import type { CacheMeterSnapshot, MissAttribution, PrefixSignals, TurnUsage } from "../shared/types.ts";

/**
 * 缓存命中率部件的累计逻辑（纯计算，可测）。
 * 渲染到 pi TUI 的部分在 index.ts（Spike 1：部件 API）。
 * 设计出处：PICODE-V3-DESIGN.md §3.3（R3 校正版）。
 */
export class CacheMeter {
  private turns = 0;
  private epoch = 1;
  private totalRead = 0;
  private totalDenominator = 0;
  private lastTurnRate = 0;
  private telemetrySeen = false;
  private lastSignals: PrefixSignals | undefined;
  private lastAttribution: MissAttribution | undefined;

  /**
   * signals 缺省时跳过归因（P0 允许；P1 起由扩展逐轮提供）。
   * 真实性规则：Provider 未返回 cache 字段 → telemetryAvailable=false，
   * UI 显示 "Cache telemetry unavailable"，不显示裸 0%。
   */
  recordTurn(usage: TurnUsage, signals?: PrefixSignals): void {
    this.turns += 1;

    const hasTelemetry =
      usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined;
    if (hasTelemetry) this.telemetrySeen = true;

    const read = usage.cacheReadTokens ?? 0;
    const write = usage.cacheWriteTokens ?? 0;
    // 命中率分母 = 本可缓存的输入总量（cache read + 未命中 input + cache write）
    const denominator = read + usage.inputTokens + write;
    this.totalRead += read;
    this.totalDenominator += denominator;
    this.lastTurnRate = denominator === 0 ? 0 : read / denominator;

    if (signals !== undefined) {
      this.lastAttribution = this.attribute(signals, read);
      this.lastSignals = signals;
    }
  }

  /**
   * miss 归因五类（§3.3）。前缀信号逐项比对；全稳定但 read 为 0 时
   * 不强行归类——记 unknown/provider-side（缓存是 Provider 侧 best-effort）。
   */
  private attribute(signals: PrefixSignals, cacheRead: number): MissAttribution | undefined {
    const prev = this.lastSignals;
    if (prev === undefined) return undefined; // 首轮天然全新前缀，不算 miss 事件
    if (prev.systemDigest !== signals.systemDigest) return "system-drift";
    if (prev.toolSchemaDigest !== signals.toolSchemaDigest) return "tool-schema-drift";
    if (prev.retainedHistoryAnchorDigest !== signals.retainedHistoryAnchorDigest) {
      return "history-anchor-rewrite";
    }
    if (prev.provider !== signals.provider || prev.model !== signals.model || prev.baseUrl !== signals.baseUrl) {
      return "route-drift";
    }
    if (prev.promptCacheKeyHash !== signals.promptCacheKeyHash) return "cache-key-drift";
    if (prev.cacheRetention !== signals.cacheRetention) return "retention-policy-drift";
    if (cacheRead > 0) return "uncached-tail";
    return "unknown-provider-side";
  }

  /**
   * 稳定前缀或历史锚点发生替换即递增（R3）：换档/换账号等刻意重置，
   * 也包括 pi auto-compact 等非用户触发的历史重写（Spike 14 探测）。
   */
  beginNewEpoch(): void {
    this.epoch += 1;
    this.lastSignals = undefined;
  }

  snapshot(): CacheMeterSnapshot {
    const base = {
      turns: this.turns,
      cacheEpoch: this.epoch,
      telemetryAvailable: this.telemetrySeen,
      sessionHitRate: this.totalDenominator === 0 ? 0 : this.totalRead / this.totalDenominator,
      lastTurnHitRate: this.lastTurnRate,
    };
    return this.lastAttribution === undefined
      ? base
      : { ...base, lastAttribution: this.lastAttribution };
  }

  format(): string {
    const s = this.snapshot();
    if (!s.telemetryAvailable) {
      return `Cache telemetry unavailable · reported cached tokens: 0 · epoch ${s.cacheEpoch}`;
    }
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const attribution = s.lastAttribution === undefined ? "" : ` · ${s.lastAttribution}`;
    return `cache ${pct(s.sessionHitRate)} (last ${pct(s.lastTurnHitRate)})${attribution} · epoch ${s.cacheEpoch}`;
  }
}

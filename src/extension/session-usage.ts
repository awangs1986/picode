import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

interface UsageTotals extends UsageLike {
  latestCacheHit?: number;
}

const emptyTotals = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { total: 0 },
});

function entryUsage(entry: SessionEntry): UsageLike | undefined {
  if (entry.type === "message") {
    const message = entry.message as { role?: string; usage?: UsageLike };
    if (message.role === "assistant" || message.role === "toolResult") return message.usage;
    return undefined;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return entry.usage as UsageLike | undefined;
  }
  return undefined;
}

export function collectSessionUsage(entries: readonly SessionEntry[]): UsageTotals {
  const totals = emptyTotals();
  for (const entry of entries) {
    const usage = entryUsage(entry);
    if (usage === undefined) continue;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost.total += usage.cost.total;
    const denominator = usage.input + usage.cacheRead + usage.cacheWrite;
    if (denominator > 0) totals.latestCacheHit = usage.cacheRead / denominator;
  }
  return totals;
}

export function formatUsageTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatContext(context: ContextUsage | undefined): string {
  if (context === undefined) return "unavailable";
  const tokens = context.tokens === null ? "?" : formatUsageTokens(context.tokens);
  const percent = context.percent === null ? "?" : `${context.percent.toFixed(1)}%`;
  return `${tokens}/${formatUsageTokens(context.contextWindow)} (${percent})`;
}

export function renderSessionUsage(
  entries: readonly SessionEntry[],
  context: ContextUsage | undefined,
): string {
  const usage = collectSessionUsage(entries);
  const denominator = usage.input + usage.cacheRead + usage.cacheWrite;
  const sessionHit = denominator === 0 ? undefined : usage.cacheRead / denominator;
  const hit = sessionHit === undefined
    ? "unavailable"
    : `${(sessionHit * 100).toFixed(1)}%${usage.latestCacheHit === undefined ? "" : ` (last ${(usage.latestCacheHit * 100).toFixed(1)}%)`}`;
  return [
    "Session usage",
    `Input: ${formatUsageTokens(usage.input)}`,
    `Output: ${formatUsageTokens(usage.output)}`,
    `Cache read: ${formatUsageTokens(usage.cacheRead)}`,
    `Cache write: ${formatUsageTokens(usage.cacheWrite)}`,
    `Cache hit: ${hit}`,
    `Estimated cost: $${usage.cost.total.toFixed(3)}`,
    `Current context: ${formatContext(context)}`,
  ].join("\n");
}

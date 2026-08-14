import { createHash } from "node:crypto";

export interface ContextMeterMessage {
  role: string;
  [key: string]: unknown;
}

export interface ContextMeterTool {
  name: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: unknown;
}

export interface ContextBudgetMeasurement {
  systemPromptTokens: number;
  toolSchemaTokens: number;
  messageTokens: number;
  providerObservedTokens?: number;
  totalTokens: number;
  source: "estimated" | "provider-anchor";
}

export interface ContextBudgetMeterInput {
  sessionId: string;
  revision: string;
  messages: readonly ContextMeterMessage[];
  systemPrompt: string;
  tools: readonly ContextMeterTool[];
}

export function stableContextJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableContextJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableContextJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function contextDigest(value: unknown): string {
  return createHash("sha256").update(stableContextJson(value)).digest("hex");
}

export function estimateContextTextTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}

export class ContextBudgetMeter {
  private readonly messageTokenCache = new WeakMap<object, number>();
  private readonly revisionCache = new Map<string, { key: string; value: ContextBudgetMeasurement }>();

  messageTokens(message: ContextMeterMessage): number {
    const object = message as object;
    const cached = this.messageTokenCache.get(object);
    if (cached !== undefined) return cached;
    const tokens = estimateContextTextTokens(stableContextJson(message));
    this.messageTokenCache.set(object, tokens);
    return tokens;
  }

  measure(input: ContextBudgetMeterInput): ContextBudgetMeasurement {
    const envelopeDigest = contextDigest({ systemPrompt: input.systemPrompt, tools: input.tools });
    const cacheKey = `${input.revision}\0${envelopeDigest}`;
    const cached = this.revisionCache.get(input.sessionId);
    if (cached?.key === cacheKey) return structuredClone(cached.value);

    const systemPromptTokens = estimateContextTextTokens(input.systemPrompt);
    const toolSchemaTokens = input.tools.length === 0
      ? 0
      : estimateContextTextTokens(stableContextJson(input.tools));
    const messageTokens = input.messages.reduce((sum, message) => sum + this.messageTokens(message), 0);
    let providerObservedTokens: number | undefined;
    for (let index = input.messages.length - 1; index >= 0; index -= 1) {
      const message = input.messages[index] as {
        role?: unknown;
        stopReason?: unknown;
        usage?: { totalTokens?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
      } | undefined;
      if (message?.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
      const usage = message.usage;
      if (usage === undefined) continue;
      const componentTotal = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
        .reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
      const total = typeof usage.totalTokens === "number" && usage.totalTokens > 0
        ? usage.totalTokens
        : componentTotal;
      if (total <= 0) continue;
      const delta = input.messages.slice(index + 1)
        .reduce((sum, item) => sum + this.messageTokens(item), 0);
      providerObservedTokens = total + delta;
      break;
    }
    const staticTotal = systemPromptTokens + toolSchemaTokens + messageTokens;
    const value: ContextBudgetMeasurement = {
      systemPromptTokens,
      toolSchemaTokens,
      messageTokens,
      ...(providerObservedTokens === undefined ? {} : { providerObservedTokens }),
      totalTokens: Math.max(staticTotal, providerObservedTokens ?? 0),
      source: providerObservedTokens === undefined ? "estimated" : "provider-anchor",
    };
    this.revisionCache.set(input.sessionId, { key: cacheKey, value: structuredClone(value) });
    return structuredClone(value);
  }
}

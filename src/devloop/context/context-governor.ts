import { createHash } from "node:crypto";

export interface ContextGovernorMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export interface ContextGovernorTool {
  name: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: unknown;
}

export interface ContextBudgetBreakdown {
  systemPromptTokens: number;
  toolSchemaTokens: number;
  messageTokens: number;
  providerObservedTokens?: number;
  totalTokens: number;
}

export interface ContextGovernorBudget {
  declaredContextWindow: number;
  effectiveContextWindow: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  triggerInputTokens: number;
  hardInputTokens: number;
  targetInputTokens: number;
  reason: "declared-window" | "verified-endpoint-window" | "unverified-third-party-cap";
}

export interface ContextGovernorStats {
  toolResultsCompacted: number;
  reasoningBlocksRemoved: number;
  historyMessagesCompacted: number;
  tokensRemoved: number;
}

export interface ContextGovernorResult {
  action: "pass" | "compact" | "blocked";
  messages: ContextGovernorMessage[];
  before: ContextBudgetBreakdown;
  after: ContextBudgetBreakdown;
  budget: ContextGovernorBudget;
  stats: ContextGovernorStats;
  blockedReason?: string;
}

export interface ContextGovernorInput {
  messages: ContextGovernorMessage[];
  systemPrompt: string;
  tools: readonly ContextGovernorTool[];
  declaredContextWindow: number;
  verifiedContextWindow?: number;
  maxOutputTokens: number;
  thirdPartyGateway: boolean;
}

const UNVERIFIED_THIRD_PARTY_WINDOW = 320_000;
const MAX_OUTPUT_RESERVE = 16_384;
const TRIGGER_RATIO = 0.80;
const TARGET_RATIO = 0.65;
const TOOL_HEAD_CHARS = 1_200;
const TOOL_TAIL_CHARS = 1_200;
const HISTORY_HEAD_CHARS = 800;
const HISTORY_TAIL_CHARS = 800;

function textTokens(text: string): number {
  // Three UTF-8 bytes per token is deliberately conservative for mixed CJK,
  // source code, JSON, and logs. Provider tokenizers remain the final truth.
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function messageTokens(message: ContextGovernorMessage): number {
  return textTokens(canonicalJson(message));
}

function measure(
  messages: readonly ContextGovernorMessage[],
  systemPrompt: string,
  tools: ContextGovernorInput["tools"],
): ContextBudgetBreakdown {
  const systemPromptTokens = textTokens(systemPrompt);
  const toolSchemaTokens = tools.length === 0 ? 0 : textTokens(canonicalJson(tools));
  const historyTokens = messages.reduce((sum, message) => sum + messageTokens(message), 0);
  let providerObservedTokens: number | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as unknown as {
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
    const delta = messages.slice(index + 1).reduce((sum, item) => sum + messageTokens(item), 0);
    providerObservedTokens = total + delta;
    break;
  }
  const staticTotal = systemPromptTokens + toolSchemaTokens + historyTokens;
  const totalTokens = Math.max(staticTotal, providerObservedTokens ?? 0);
  return {
    systemPromptTokens,
    toolSchemaTokens,
    messageTokens: historyTokens,
    ...(providerObservedTokens === undefined ? {} : { providerObservedTokens }),
    totalTokens,
  };
}

function resolveBudget(input: ContextGovernorInput): ContextGovernorBudget {
  const declared = Math.max(16_384, Math.floor(input.declaredContextWindow));
  let effectiveContextWindow = declared;
  let reason: ContextGovernorBudget["reason"] = "declared-window";
  if (input.verifiedContextWindow !== undefined) {
    effectiveContextWindow = Math.min(declared, Math.max(16_384, Math.floor(input.verifiedContextWindow)));
    reason = "verified-endpoint-window";
  } else if (input.thirdPartyGateway) {
    effectiveContextWindow = Math.min(declared, UNVERIFIED_THIRD_PARTY_WINDOW);
    reason = "unverified-third-party-cap";
  }
  const outputReserveTokens = Math.min(
    Math.max(2_048, Math.floor(input.maxOutputTokens)),
    MAX_OUTPUT_RESERVE,
  );
  const safetyMarginTokens = Math.max(8_192, Math.floor(effectiveContextWindow * 0.05));
  const hardInputTokens = Math.max(
    8_192,
    effectiveContextWindow - outputReserveTokens - safetyMarginTokens,
  );
  return {
    declaredContextWindow: declared,
    effectiveContextWindow,
    outputReserveTokens,
    safetyMarginTokens,
    triggerInputTokens: Math.min(hardInputTokens, Math.floor(effectiveContextWindow * TRIGGER_RATIO)),
    hardInputTokens,
    targetInputTokens: Math.min(hardInputTokens, Math.floor(effectiveContextWindow * TARGET_RATIO)),
    reason,
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => (
      part !== null && typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("\n");
}

function boundedText(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text;
  return `${text.slice(0, headChars)}\n…\n${text.slice(-tailChars)}`;
}

function compactToolResult(message: ContextGovernorMessage): ContextGovernorMessage | undefined {
  const row = message as unknown as Record<string, unknown>;
  if (row.role !== "toolResult") return undefined;
  const text = contentText(row.content);
  const serialized = canonicalJson(row.content);
  if (serialized.length <= TOOL_HEAD_CHARS + TOOL_TAIL_CHARS + 512) return undefined;
  const digest = createHash("sha256").update(serialized).digest("hex");
  const preview = text === "" ? "[non-text tool content omitted from active context]" : text;
  const envelope = [
    `[Picode tool output compacted before provider request]`,
    `tool=${String(row.toolName ?? "unknown")} originalChars=${serialized.length} sha256=${digest}`,
    `The complete result remains in the session transcript.`,
    "<retained-head-tail>",
    boundedText(preview, TOOL_HEAD_CHARS, TOOL_TAIL_CHARS),
    "</retained-head-tail>",
  ].join("\n");
  return {
    ...message,
    content: [{ type: "text", text: envelope }],
  } as ContextGovernorMessage;
}

function removeReasoning(message: ContextGovernorMessage): ContextGovernorMessage | undefined {
  const row = message as unknown as Record<string, unknown>;
  if (row.role !== "assistant" || !Array.isArray(row.content)) return undefined;
  const content = row.content as Array<Record<string, unknown>>;
  if (!content.some((part) => part.type === "thinking")) return undefined;
  return {
    ...message,
    content: content.filter((part) => part.type !== "thinking"),
  } as unknown as ContextGovernorMessage;
}

function compactNarrative(message: ContextGovernorMessage): ContextGovernorMessage | undefined {
  const row = message as unknown as Record<string, unknown>;
  if (row.role !== "user" && row.role !== "assistant" && row.role !== "custom") return undefined;
  if (row.role === "assistant" && Array.isArray(row.content) && row.content.some(
    (part) => part !== null && typeof part === "object" && (part as { type?: unknown }).type === "toolCall",
  )) return undefined;
  const original = contentText(row.content);
  if (original.length <= HISTORY_HEAD_CHARS + HISTORY_TAIL_CHARS + 512) return undefined;
  const digest = createHash("sha256").update(original).digest("hex");
  return {
    ...message,
    content: [{
      type: "text",
      text: `[Picode older narrative compacted; full text remains in transcript; originalChars=${original.length}; sha256=${digest}]\n${boundedText(original, HISTORY_HEAD_CHARS, HISTORY_TAIL_CHARS)}`,
    }],
  } as ContextGovernorMessage;
}

function foldOldHistory(
  messages: ContextGovernorMessage[],
  lastUserIndex: number,
): ContextGovernorMessage[] | undefined {
  if (lastUserIndex <= 0) return undefined;
  const omitted = messages.slice(0, lastUserIndex);
  const digest = createHash("sha256").update(canonicalJson(omitted)).digest("hex");
  return [{
    role: "user",
    content: [{
      type: "text",
      text: `[Picode emergency active-context compaction omitted ${omitted.length} older messages; the full transcript remains on disk; sha256=${digest}. Continue from the retained current turn and authoritative project/task files.]`,
    }],
    timestamp: Date.now(),
  }, ...messages.slice(lastUserIndex)];
}

/**
 * Deterministic request-boundary governor. It never mutates the persisted Pi
 * transcript; it compiles a bounded active context for this provider request.
 */
export class ContextGovernor {
  prepareRequest(input: ContextGovernorInput): ContextGovernorResult {
    const budget = resolveBudget(input);
    const before = measure(input.messages, input.systemPrompt, input.tools);
    const emptyStats: ContextGovernorStats = {
      toolResultsCompacted: 0,
      reasoningBlocksRemoved: 0,
      historyMessagesCompacted: 0,
      tokensRemoved: 0,
    };
    if (before.totalTokens < budget.triggerInputTokens) {
      return {
        action: "pass",
        messages: input.messages,
        before,
        after: before,
        budget,
        stats: emptyStats,
      };
    }

    const messages = structuredClone(input.messages);
    const lastUserIndex = messages.findLastIndex((message) => (
      (message as unknown as { role?: unknown }).role === "user"
    ));
    const stats = { ...emptyStats };
    let current = before;
    const remeasure = (): ContextBudgetBreakdown => {
      const measured = measure(messages, input.systemPrompt, input.tools);
      if (before.providerObservedTokens === undefined) return measured;
      const removedMessageTokens = Math.max(0, before.messageTokens - measured.messageTokens);
      const providerObservedTokens = Math.max(0, before.providerObservedTokens - removedMessageTokens);
      return {
        ...measured,
        providerObservedTokens,
        totalTokens: Math.max(
          measured.systemPromptTokens + measured.toolSchemaTokens + measured.messageTokens,
          providerObservedTokens,
        ),
      };
    };
    const applyCandidates = (
      transform: (message: ContextGovernorMessage) => ContextGovernorMessage | undefined,
      increment: keyof Pick<ContextGovernorStats, "toolResultsCompacted" | "reasoningBlocksRemoved" | "historyMessagesCompacted">,
    ): void => {
      const candidates = messages
        .map((message, index) => ({ index, message, tokens: messageTokens(message) }))
        .sort((left, right) => right.tokens - left.tokens);
      for (const candidate of candidates) {
        if (current.totalTokens <= budget.targetInputTokens) break;
        const original = messages[candidate.index];
        if (original === undefined) continue;
        const replacement = transform(original);
        if (replacement === undefined) continue;
        messages[candidate.index] = replacement;
        stats[increment] += 1;
        current = remeasure();
      }
    };

    applyCandidates(compactToolResult, "toolResultsCompacted");
    applyCandidates(removeReasoning, "reasoningBlocksRemoved");
    const compactOlderNarrative = (message: ContextGovernorMessage): ContextGovernorMessage | undefined => {
      if (messages.indexOf(message) === lastUserIndex) return undefined;
      return compactNarrative(message);
    };
    applyCandidates(compactOlderNarrative, "historyMessagesCompacted");
    if (current.totalTokens > budget.targetInputTokens) {
      const folded = foldOldHistory(messages, lastUserIndex);
      if (folded !== undefined) {
        const removed = messages.length - folded.length;
        messages.splice(0, messages.length, ...folded);
        stats.historyMessagesCompacted += Math.max(1, removed);
        current = remeasure();
      }
    }
    stats.tokensRemoved = Math.max(0, before.totalTokens - current.totalTokens);

    if (current.totalTokens > budget.hardInputTokens) {
      return {
        action: "blocked",
        messages,
        before,
        after: current,
        budget,
        stats,
        blockedReason: current.systemPromptTokens + current.toolSchemaTokens > budget.hardInputTokens
          ? "immutable prefix (system prompt plus tool schemas) exceeds the safe input budget"
          : "active context cannot be reduced below the safe provider budget",
      };
    }
    return {
      action: "compact",
      messages,
      before,
      after: current,
      budget,
      stats,
    };
  }
}

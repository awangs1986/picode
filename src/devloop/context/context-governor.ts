import { createHash } from "node:crypto";
import type { ContextCompilationManifest, ContextReplacementRecord } from "../../shared/types.ts";
import {
  ContextBudgetMeter,
  contextDigest,
  estimateContextTextTokens,
  stableContextJson,
} from "./context-budget-meter.ts";

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
  source: "estimated" | "provider-anchor";
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
  manifest?: ContextCompilationManifest;
}

export interface ContextGovernorInput {
  sessionId?: string;
  sessionRevision?: string;
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
  const serialized = stableContextJson(row.content);
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
  if (isProtectedContext(message)) return undefined;
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

function isProtectedContext(message: ContextGovernorMessage): boolean {
  const row = message as unknown as Record<string, unknown>;
  if (row.customType === "picode.context-event" || row.customType === "picode.task-capsule") return true;
  const text = contentText(row.content);
  return /<picode_(?:task_state|tdd_state)>|# Task Capsule \(/.test(text);
}

function foldOldHistory(
  messages: ContextGovernorMessage[],
  lastUserIndex: number,
): ContextGovernorMessage[] | undefined {
  if (lastUserIndex <= 0) return undefined;
  const omitted = messages.slice(0, lastUserIndex);
  const digest = createHash("sha256").update(stableContextJson(omitted)).digest("hex");
  const protectedMessages = omitted.filter(isProtectedContext);
  return [{
    role: "user",
    content: [{
      type: "text",
      text: `[Picode emergency active-context compaction omitted ${omitted.length} older messages; the full transcript remains on disk; sha256=${digest}. Continue from the retained current turn and authoritative project/task files.]`,
    }],
  }, ...protectedMessages, ...messages.slice(lastUserIndex)];
}

/**
 * Deterministic request-boundary governor. It never mutates the persisted Pi
 * transcript; it compiles a bounded active context for this provider request.
 */
export class ContextGovernor {
  constructor(private readonly meter: ContextBudgetMeter = new ContextBudgetMeter()) {}

  prepareRequest(input: ContextGovernorInput): ContextGovernorResult {
    const budget = resolveBudget(input);
    const sessionId = input.sessionId ?? "unknown-session";
    const sessionRevision = input.sessionRevision ?? `messages:${input.messages.length}:${contextDigest(input.messages.at(-1) ?? null)}`;
    const before = this.meter.measure({
      sessionId,
      revision: sessionRevision,
      messages: input.messages,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
    });
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
    const replacements: ContextReplacementRecord[] = [];
    let measureGeneration = 0;
    let current = before;
    const remeasure = (): ContextBudgetBreakdown => {
      measureGeneration += 1;
      const measured = this.meter.measure({
        sessionId,
        revision: `${sessionRevision}:compile:${measureGeneration}`,
        messages,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
      });
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
      kind: ContextReplacementRecord["kind"],
    ): void => {
      const candidates = messages
        .map((message, index) => ({ index, message, tokens: this.meter.messageTokens(message) }))
        .sort((left, right) => right.tokens - left.tokens);
      for (const candidate of candidates) {
        if (current.totalTokens <= budget.targetInputTokens) break;
        const original = messages[candidate.index];
        if (original === undefined) continue;
        const replacement = transform(original);
        if (replacement === undefined) continue;
        messages[candidate.index] = replacement;
        const toolCallId = typeof (original as { toolCallId?: unknown }).toolCallId === "string"
          ? String((original as unknown as { toolCallId: string }).toolCallId)
          : undefined;
        replacements.push({
          kind,
          sourceIndex: candidate.index,
          ...(toolCallId === undefined ? {} : { toolCallId }),
          beforeDigest: contextDigest(original),
          afterDigest: contextDigest(replacement),
        });
        stats[increment] += 1;
        current = remeasure();
      }
    };

    applyCandidates(compactToolResult, "toolResultsCompacted", "tool-result");
    applyCandidates(removeReasoning, "reasoningBlocksRemoved", "reasoning");
    const compactOlderNarrative = (message: ContextGovernorMessage): ContextGovernorMessage | undefined => {
      if (messages.indexOf(message) === lastUserIndex) return undefined;
      return compactNarrative(message);
    };
    applyCandidates(compactOlderNarrative, "historyMessagesCompacted", "narrative");
    if (current.totalTokens > budget.targetInputTokens) {
      const folded = foldOldHistory(messages, lastUserIndex);
      if (folded !== undefined) {
        const beforeFold = messages.slice(0, Math.max(0, lastUserIndex));
        const removed = messages.length - folded.length;
        messages.splice(0, messages.length, ...folded);
        replacements.push({
          kind: "history-fold",
          sourceIndex: 0,
          ...(lastUserIndex <= 0 ? {} : { sourceEndIndex: lastUserIndex - 1 }),
          beforeDigest: contextDigest(beforeFold),
          afterDigest: contextDigest(folded.slice(0, folded.length - (input.messages.length - lastUserIndex))),
        });
        stats.historyMessagesCompacted += Math.max(1, removed);
        current = remeasure();
      }
    }
    stats.tokensRemoved = Math.max(0, before.totalTokens - current.totalTokens);

    const manifestFor = (action: "compact" | "blocked"): ContextCompilationManifest => ({
      schemaVersion: "picode.context-compilation/v1",
      compilerVersion: 1,
      sessionId,
      sessionRevision,
      action,
      inputDigest: contextDigest(input.messages),
      outputDigest: contextDigest(messages),
      beforeTokens: before.totalTokens,
      afterTokens: current.totalTokens,
      effectiveContextWindow: budget.effectiveContextWindow,
      replacements,
    });

    if (current.totalTokens > budget.hardInputTokens) {
      return {
        action: "blocked",
        messages,
        before,
        after: current,
        budget,
        stats,
        manifest: manifestFor("blocked"),
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
      manifest: manifestFor("compact"),
    };
  }
}

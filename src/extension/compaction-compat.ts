import {
  convertToLlm,
  estimateTokens,
  serializeConversation,
  type CompactionResult,
  type ExtensionAPI,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { contentText, type Context, type Usage } from "@earendil-works/pi-ai";

type AgentMessage = Parameters<typeof convertToLlm>[0][number];

const DEFAULT_SUMMARIZATION_CHUNK_TOKENS = 48_000;

export interface SummarizationChunk {
  messages: AgentMessage[];
  estimatedTokens: number;
}

/**
 * Keep custom compaction requests below the provider's effective context limit.
 * Imported model metadata is not authoritative for third-party gateways (a model
 * may advertise 1M while the proxy accepts substantially less), so long histories
 * are summarized in bounded, chronological batches.
 */
export function buildSummarizationChunks(
  messages: AgentMessage[],
  maxTokens: number = DEFAULT_SUMMARIZATION_CHUNK_TOKENS,
): SummarizationChunk[] {
  const budget = Math.max(1_024, Math.floor(maxTokens));
  const chunks: SummarizationChunk[] = [];
  let current: AgentMessage[] = [];
  let estimatedTokens = 0;
  for (const message of messages) {
    const tokens = Math.max(1, estimateTokens(message));
    if (current.length > 0 && estimatedTokens + tokens > budget) {
      chunks.push({ messages: current, estimatedTokens });
      current = [];
      estimatedTokens = 0;
    }
    current.push(message);
    estimatedTokens += tokens;
  }
  if (current.length > 0) chunks.push({ messages: current, estimatedTokens });
  return chunks;
}

/** Remove fields that mean "reasoning off" but are rejected by some gateways. */
export function reasoningFreeFetch(baseFetch: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body !== "string") return baseFetch(input, init);
    try {
      const payload = JSON.parse(init.body) as Record<string, unknown>;
      delete payload.reasoning;
      delete payload.include;
      return baseFetch(input, { ...init, body: JSON.stringify(payload) });
    } catch {
      return baseFetch(input, init);
    }
  };
}

/** Third-party Responses gateways may reject encrypted reasoning on summaries. */
export function isThirdPartyOpenAiResponses(model: { api?: string; baseUrl?: string } | undefined): boolean {
  if (model?.api !== "openai-responses" || !model.baseUrl) return false;
  try {
    return new URL(model.baseUrl).hostname.toLowerCase() !== "api.openai.com";
  } catch {
    return false;
  }
}

function fileFacts(preparation: SessionBeforeCompactEvent["preparation"]): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const read = [...preparation.fileOps.read].filter(
    (file) => !preparation.fileOps.edited.has(file) && !preparation.fileOps.written.has(file),
  ).sort();
  const modified = [...new Set([...preparation.fileOps.edited, ...preparation.fileOps.written])].sort();
  return { readFiles: read, modifiedFiles: modified };
}

function appendFileFacts(summary: string, facts: ReturnType<typeof fileFacts>): string {
  const sections: string[] = [];
  if (facts.readFiles.length > 0) sections.push(`<read-files>\n${facts.readFiles.join("\n")}\n</read-files>`);
  if (facts.modifiedFiles.length > 0) sections.push(`<modified-files>\n${facts.modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length === 0 ? summary : `${summary}\n\n${sections.join("\n\n")}`;
}

/** Install the narrow third-party compaction compatibility seam. */
export function registerCompactionCompatibility(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!model || model.api !== "openai-responses") return;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return;
    const effectiveBaseUrl = auth.baseUrl ?? model.baseUrl;
    if (!isThirdPartyOpenAiResponses({ ...model, baseUrl: effectiveBaseUrl })) return;
    const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    ctx.ui.setStatus("picode-compaction", "gateway-compatible");
    const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
    try {
      const completeSummary = async (prompt: string, maxTokens: number) => {
        const context: Context = {
          systemPrompt: "You produce concise, faithful coding-session summaries.",
          messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
        };
        const result = await ctx.modelRegistry.complete(requestModel, context, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          fetch: reasoningFreeFetch(),
          signal: event.signal,
          maxTokens,
        });
        if (result.stopReason === "error" || result.stopReason === "aborted") {
          throw new Error(result.errorMessage ?? "gateway summary failed");
        }
        return result;
      };

      const chunks = buildSummarizationChunks(messages);
      const chunkSummaries: string[] = [];
      let usage: Usage | undefined;
      let result;
      if (chunks.length <= 1) {
        result = await completeSummary(
          `${event.preparation.previousSummary ? `Previous summary:\n${event.preparation.previousSummary}\n\n` : ""}${event.customInstructions ? `Focus:\n${event.customInstructions}\n\n` : ""}<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\nSummarize the coding session. Preserve exact paths, decisions, errors, pending work, and verification state. Do not continue the conversation.`,
          Math.min(event.preparation.settings.reserveTokens, 8192),
        );
      } else {
        for (const [index, chunk] of chunks.entries()) {
          const conversation = serializeConversation(convertToLlm(chunk.messages));
          const part = await completeSummary(
            `<conversation-part ${index + 1} of ${chunks.length}>\n${conversation}\n</conversation-part>\n\nSummarize this part of a coding session. Preserve exact paths, decisions, errors, pending work, and verification state. Do not continue the conversation.`,
            Math.min(event.preparation.settings.reserveTokens, 4096),
          );
          chunkSummaries.push(contentText(part.content));
          usage = part.usage;
        }
        result = await completeSummary(
          `${event.preparation.previousSummary ? `Previous summary:\n${event.preparation.previousSummary}\n\n` : ""}${event.customInstructions ? `Focus:\n${event.customInstructions}\n\n` : ""}<conversation-parts>\n${chunkSummaries.join("\n\n---\n\n")}\n</conversation-parts>\n\nCreate one concise coding-session summary from these ordered parts. Preserve exact paths, decisions, errors, pending work, and verification state. Do not continue the conversation.`,
          Math.min(event.preparation.settings.reserveTokens, 8192),
        );
      }
      const facts = fileFacts(event.preparation);
      const compaction: CompactionResult = {
        summary: appendFileFacts(contentText(result.content), facts),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: result.usage ?? usage,
        details: {
          ...facts,
          compatibility: "third-party-openai-responses-reasoning-off",
        },
      };
      return { compaction };
    } catch {
      ctx.ui.setStatus("picode-compaction", "gateway-fallback-failed");
      return undefined;
    }
  });
}

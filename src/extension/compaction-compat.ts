import {
  convertToLlm,
  serializeConversation,
  type CompactionResult,
  type ExtensionAPI,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { contentText, type Context } from "@earendil-works/pi-ai";

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
      const conversation = serializeConversation(convertToLlm(messages));
      const prompt = `${event.preparation.previousSummary ? `Previous summary:\n${event.preparation.previousSummary}\n\n` : ""}${event.customInstructions ? `Focus:\n${event.customInstructions}\n\n` : ""}<conversation>\n${conversation}\n</conversation>\n\nSummarize the coding session. Preserve exact paths, decisions, errors, pending work, and verification state. Do not continue the conversation.`;
      const context: Context = {
        systemPrompt: "You produce concise, faithful coding-session summaries.",
        messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      };
      const result = await ctx.modelRegistry.complete(requestModel, context, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        fetch: reasoningFreeFetch(),
        signal: event.signal,
        maxTokens: Math.min(event.preparation.settings.reserveTokens, 8192),
      });
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        throw new Error(result.errorMessage ?? "gateway summary failed");
      }
      const facts = fileFacts(event.preparation);
      const compaction: CompactionResult = {
        summary: appendFileFacts(contentText(result.content), facts),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: result.usage,
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

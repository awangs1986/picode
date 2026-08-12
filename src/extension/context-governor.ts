import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { ContextGovernor } from "../devloop/context/context-governor.ts";
import type { ContextGovernorMessage } from "../devloop/context/context-governor.ts";
import { isThirdPartyOpenAiResponses } from "./compaction-compat.ts";

const STATUS_KEY = "picode-context";

async function effectiveBaseUrl(ctx: ExtensionContext): Promise<string | undefined> {
  const model = ctx.model;
  if (model === undefined) return undefined;
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    return auth.ok ? (auth.baseUrl ?? model.baseUrl) : model.baseUrl;
  } catch {
    return model.baseUrl;
  }
}

function activeTools(pi: ExtensionAPI): ToolInfo[] {
  if (typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function") return [];
  const names = new Set(pi.getActiveTools());
  return pi.getAllTools().filter((tool) => names.has(tool.name));
}

/**
 * Register the request-boundary safety governor. This deliberately remains
 * active when Pi's optional automatic compaction setting is disabled: it is the
 * final protection against sending a known-over-budget request and wedging the
 * conversation.
 */
export function registerContextGovernor(
  pi: ExtensionAPI,
  governor: ContextGovernor = new ContextGovernor(),
): void {
  let durableCompactionPending = false;
  let durableCompactionRunning = false;

  pi.on("context", async (event, ctx) => {
    const model = ctx.model;
    if (model === undefined) return undefined;
    // Tiny/custom fixture models often declare a synthetic window smaller than
    // Pi's own immutable prompt. There is no history budget for Picode to
    // govern in that situation, so leave the custom provider contract intact.
    if (model.contextWindow < 32_768) return undefined;
    const baseUrl = await effectiveBaseUrl(ctx);
    const result = governor.prepareRequest({
      messages: event.messages as unknown as ContextGovernorMessage[],
      systemPrompt: ctx.getSystemPrompt(),
      tools: activeTools(pi),
      declaredContextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      thirdPartyGateway: isThirdPartyOpenAiResponses({
        api: model.api,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      }),
    });
    if (result.action === "pass") {
      ctx.ui.setStatus(STATUS_KEY, `${Math.round(result.before.totalTokens / 1_000)}K / ${Math.round(result.budget.effectiveContextWindow / 1_000)}K`);
      return undefined;
    }
    durableCompactionPending = true;
    if (result.action === "blocked") ctx.abort();
    ctx.ui.setStatus(
      STATUS_KEY,
      result.action === "blocked"
        ? `safety compact blocked: ${Math.round(result.after.totalTokens / 1_000)}K`
        : `compacted ${Math.round(result.before.totalTokens / 1_000)}K→${Math.round(result.after.totalTokens / 1_000)}K`,
    );
    // Returning a replacement here prevents the original oversized messages
    // from reaching the provider. The persisted JSONL remains append-only.
    return { messages: result.messages as never };
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!durableCompactionPending || durableCompactionRunning) return;
    durableCompactionPending = false;
    durableCompactionRunning = true;
    ctx.compact({
      customInstructions: "Preserve exact goals, decisions, paths, errors, pending work, and verification state. Large raw tool outputs already remain in the transcript and should be summarized, not copied.",
      onComplete: () => {
        durableCompactionRunning = false;
        ctx.ui.setStatus(STATUS_KEY, "durable compaction complete");
      },
      onError: () => {
        durableCompactionRunning = false;
        durableCompactionPending = true;
        ctx.ui.setStatus(STATUS_KEY, "active context protected; durable compaction retry pending");
      },
    });
  });
}

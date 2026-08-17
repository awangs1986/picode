import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { ContextGovernor } from "../devloop/context/context-governor.ts";
import { ContextLedger } from "../devloop/context/context-ledger.ts";
import type { ContextGovernorMessage } from "../devloop/context/context-governor.ts";
import type {
  ContextCompilationStorePort,
  ContextLedgerStorePort,
  EndpointContextProfile,
  EndpointContextProfileStorePort,
} from "../shared/types.ts";
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

function normalizedBaseUrl(value: string | undefined): string {
  if (value === undefined) return "default";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

function routeKey(model: NonNullable<ExtensionContext["model"]>, baseUrl: string | undefined): string {
  return `${model.api}|${normalizedBaseUrl(baseUrl)}|${model.provider}/${model.id}`;
}

function sessionRevision(ctx: ExtensionContext, messageCount: number): string {
  const manager = ctx.sessionManager as { getBranch?: () => Array<{ id?: unknown }> } | undefined;
  const branch = manager?.getBranch?.() ?? [];
  const leaf = branch.at(-1)?.id;
  return `${branch.length}:${typeof leaf === "string" ? leaf : `messages-${messageCount}`}`;
}

type ContextGovernorStore = ContextCompilationStorePort & EndpointContextProfileStorePort & ContextLedgerStorePort;

export interface ContextPressureSignal {
  tokens: number;
  endpointContextWindow: number;
  reliableContextCeiling: number;
  percent: number;
}

export interface ContextGovernorAdapterOptions {
  store?: ContextGovernorStore;
  onContextPressure?: (signal: ContextPressureSignal) => void;
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
  options: ContextGovernorAdapterOptions = {},
): void {
  let durableCompactionPending = false;
  let durableCompactionRunning = false;
  const ledger = options.store === undefined ? undefined : new ContextLedger(options.store);
  let lastManifest: import("../shared/types.ts").ContextCompilationManifest | undefined;
  let lastRequest: {
    routeKey: string;
    inputTokens: number;
    profile: EndpointContextProfile;
  } | undefined;

  pi.on("context", async (event, ctx) => {
    const model = ctx.model;
    if (model === undefined) return undefined;
    // The bundled scripted provider deliberately declares a tiny synthetic
    // window for deterministic tests. Real providers, including small local
    // models, must never bypass the request-boundary budget guard.
    if (model.provider === "picode-scripted-test" || model.api === "picode-scripted-test") return undefined;
    const baseUrl = await effectiveBaseUrl(ctx);
    const currentRouteKey = routeKey(model, baseUrl);
    const loadedProfile = await options.store?.loadEndpointContextProfile(currentRouteKey);
    const profile = loadedProfile?.ok
      ? loadedProfile.value
      : { schemaVersion: "picode.endpoint-context/v1" as const, routeKey: currentRouteKey };
    const result = governor.prepareRequest({
      sessionId: (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() ?? "unknown-session",
      sessionRevision: sessionRevision(ctx, event.messages.length),
      messages: event.messages as unknown as ContextGovernorMessage[],
      systemPrompt: ctx.getSystemPrompt(),
      tools: activeTools(pi),
      declaredContextWindow: model.contextWindow,
      ...(profile.verifiedContextWindow === undefined
        ? {}
        : { verifiedContextWindow: profile.verifiedContextWindow }),
      maxOutputTokens: model.maxTokens,
      thirdPartyGateway: isThirdPartyOpenAiResponses({
        api: model.api,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      }),
    });
    options.onContextPressure?.({
      tokens: result.before.totalTokens,
      endpointContextWindow: result.budget.effectiveContextWindow,
      reliableContextCeiling: result.budget.reliableContextCeiling,
      percent: (result.before.totalTokens / result.budget.reliableContextCeiling) * 100,
    });
    lastRequest = { routeKey: currentRouteKey, inputTokens: result.after.totalTokens, profile };
    if (result.manifest !== undefined) {
      lastManifest = result.manifest;
      const saved = await options.store?.saveContextCompilation(result.manifest);
      if (saved !== undefined && !saved.ok) {
        ctx.ui.setStatus(STATUS_KEY, "context protected; manifest persistence failed");
      }
      await ledger?.record({
        sessionId: result.manifest.sessionId,
        sessionRevision: result.manifest.sessionRevision,
        layer: "governor",
        action: result.action === "blocked" ? "blocked" : "compiled",
        sourceDigest: result.manifest.inputDigest,
        outputDigest: result.manifest.outputDigest,
        beforeTokens: result.manifest.beforeTokens,
        afterTokens: result.manifest.afterTokens,
        requestOnly: true,
      });
    }
    if (result.action === "pass") {
      ctx.ui.setStatus(STATUS_KEY, `${Math.round(result.before.totalTokens / 1_000)}K / ${Math.round(result.budget.reliableContextCeiling / 1_000)}K`);
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

  pi.on("after_provider_response", async (event) => {
    if (event.status < 200 || event.status >= 300 || lastRequest === undefined || options.store === undefined) return;
    const request = lastRequest;
    const observed = Math.max(request.profile.observedSuccessInputTokens ?? 0, request.inputTokens);
    await options.store.saveEndpointContextProfile({
      ...request.profile,
      routeKey: request.routeKey,
      observedSuccessInputTokens: observed,
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!durableCompactionPending || durableCompactionRunning) return;
    durableCompactionPending = false;
    durableCompactionRunning = true;
    const durableManifest = lastManifest;
    if (durableManifest !== undefined) {
      await ledger?.record({
        sessionId: durableManifest.sessionId,
        sessionRevision: durableManifest.sessionRevision,
        layer: "durable-compaction",
        action: "scheduled",
        sourceDigest: durableManifest.outputDigest,
        beforeTokens: durableManifest.afterTokens,
        requestOnly: false,
      });
    }
    ctx.compact({
      customInstructions: "Preserve exact goals, decisions, paths, errors, pending work, and verification state. Large raw tool outputs already remain in the transcript and should be summarized, not copied.",
      onComplete: () => {
        durableCompactionRunning = false;
        if (durableManifest !== undefined) void ledger?.record({
          sessionId: durableManifest.sessionId,
          sessionRevision: durableManifest.sessionRevision,
          layer: "durable-compaction",
          action: "completed",
          sourceDigest: durableManifest.outputDigest,
          beforeTokens: durableManifest.afterTokens,
          requestOnly: false,
        });
        ctx.ui.setStatus(STATUS_KEY, "durable compaction complete");
      },
      onError: () => {
        durableCompactionRunning = false;
        durableCompactionPending = true;
        if (durableManifest !== undefined) void ledger?.record({
          sessionId: durableManifest.sessionId,
          sessionRevision: durableManifest.sessionRevision,
          layer: "durable-compaction",
          action: "failed",
          sourceDigest: durableManifest.outputDigest,
          beforeTokens: durableManifest.afterTokens,
          requestOnly: false,
        });
        ctx.ui.setStatus(STATUS_KEY, "active context protected; durable compaction retry pending");
      },
    });
  });
}

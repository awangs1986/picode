import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { retainToolOutput } from "../devloop/context/tool-output-retention.ts";
import { ContextLedger } from "../devloop/context/context-ledger.ts";
import { contextDigest, estimateContextTextTokens } from "../devloop/context/context-budget-meter.ts";
import { renderToolResult } from "../devloop/context/tool-result-renderer.ts";
import type { ContextArtifactStorePort, ContextLedgerStorePort } from "../shared/types.ts";

/** Adapter only: translate Pi's accepted tool-result event to Devloop policy. */
export function registerToolOutputRetention(
  pi: ExtensionAPI,
  store: ContextArtifactStorePort & ContextLedgerStorePort,
  options: { maxInlineBytes?: number } = {},
): void {
  const ledger = new ContextLedger(store);
  const handler = async (event: ToolResultEvent, ctx: ExtensionContext) => {
    const rendered = renderToolResult({
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
      content: event.content as unknown as import("../devloop/context/tool-output-retention.ts").ToolOutputContentBlock[],
      details: event.details,
      isError: event.isError,
    });
    const retained = await retainToolOutput({
      sessionId: ctx.sessionManager.getSessionId(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      content: rendered.content,
    }, store, options);
    if (retained.retained && retained.artifact !== undefined) {
      await ledger.record({
        sessionId: ctx.sessionManager.getSessionId(),
        sessionRevision: `tool-result:${event.toolCallId}`,
        layer: "retention",
        action: "externalized",
        sourceDigest: retained.artifact.sha256,
        outputDigest: contextDigest(retained.content),
        artifactRef: retained.artifact.path,
        beforeTokens: estimateContextTextTokens(JSON.stringify(rendered.content)),
        afterTokens: estimateContextTextTokens(JSON.stringify(retained.content)),
        requestOnly: false,
      });
    }
    if (!retained.retained && !rendered.semantic) return undefined;
    return { content: retained.content as typeof event.content };
  };
  pi.on("tool_result", handler as never);
}

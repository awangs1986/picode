import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MCP_TOOL_APPROVAL_REQUEST_EVENT,
  type McpToolApprovalDecision,
  type McpToolApprovalRequest,
} from "pi-mcp-adapter/types";
import { mcpRequestToIntent } from "../guard/mcp-arbitration.ts";
import type { PicodeRuntime } from "./index.ts";
import { resolveIntentApproval } from "./approval-ui.ts";

type Events = Pick<ExtensionAPI["events"], "on">;

/** Claims every MCP call before the adapter's own permissive fallback can run. */
export function registerMcpApprovalBridge(
  events: Events,
  runtime: PicodeRuntime,
  getContext: () => ExtensionContext | undefined,
): () => void {
  return events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (raw) => {
    const request = raw as McpToolApprovalRequest;
    request.claim(async (): Promise<McpToolApprovalDecision> => {
      const intent = mcpRequestToIntent({
        server: request.serverName,
        tool: request.originalToolName,
        argumentsJson: JSON.stringify(request.args),
      });
      const decision = runtime.guard.decide(intent);
      if (decision.verdict === "allow") return "allow_once";
      if (decision.verdict === "deny") return "deny";
      const ctx = getContext();
      if (ctx === undefined || !ctx.hasUI) return "deny";
      const approval = await resolveIntentApproval(ctx.ui, runtime.guard, intent, decision.reason);
      if (approval === "session" || approval === "session-full" || approval === "global") return "allow_for_session";
      return approval === "once" ? "allow_once" : "deny";
    });
  });
}

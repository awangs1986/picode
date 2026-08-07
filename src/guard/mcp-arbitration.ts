import type { Decision, OperationIntent } from "../shared/types.ts";

/**
 * MCP 仲裁事件接管（ADR-0005）：pi-mcp-adapter 的工具批准请求经
 * 仲裁事件送到 Guard，裁决本体留在 Guard（写 Evidence 在组合根）。
 * headless（无人可问）时 ask → fail-closed 拒绝并返回 approval_required，
 * 与 pi-mcp-adapter 语义一致。
 */

/** pi-mcp-adapter 仲裁事件的最小投影（字段名在 Spike 5 对齐实际版本） */
export interface McpApprovalRequest {
  server: string;
  tool: string;
  argumentsJson: string;
  /** adapter 若声明该工具只读，进入低风险路径 */
  readOnlyHint?: boolean;
}

export function mcpRequestToIntent(request: McpApprovalRequest): OperationIntent {
  return {
    category: "mcp-tool",
    targets: [`${request.server}:${request.tool}`],
    command: request.argumentsJson,
    destructive: false,
  };
}

export type McpArbitrationResult =
  | { action: "approve" }
  | { action: "deny"; reason: string }
  | { action: "approval_required"; reason: string };

export function arbitrateMcp(
  request: McpApprovalRequest,
  decide: (intent: OperationIntent) => Decision,
  opts: { interactive: boolean; askUser?: () => boolean },
): McpArbitrationResult {
  const decision = decide(mcpRequestToIntent(request));

  switch (decision.verdict) {
    case "allow":
      return { action: "approve" };
    case "deny":
      return { action: "deny", reason: decision.reason };
    case "ask": {
      if (!opts.interactive) {
        // headless：fail-closed（PICODE-V3-DESIGN.md §3.2）
        return { action: "approval_required", reason: decision.reason };
      }
      return opts.askUser?.() === true
        ? { action: "approve" }
        : { action: "deny", reason: "user declined" };
    }
  }
}

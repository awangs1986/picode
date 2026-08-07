import { describe, expect, it, vi } from "vitest";
import {
  arbitrateMcp,
  mcpRequestToIntent,
} from "../../src/guard/mcp-arbitration.ts";
import type { Decision } from "../../src/shared/types.ts";

const request = {
  server: "my-server",
  tool: "my-tool",
  argumentsJson: '{"arg":"value"}',
};

describe("mcpRequestToIntent", () => {
  it("maps request to mcp-tool intent with server:tool target and argumentsJson command", () => {
    const intent = mcpRequestToIntent(request);
    expect(intent).toEqual({
      category: "mcp-tool",
      targets: ["my-server:my-tool"],
      command: '{"arg":"value"}',
      destructive: false,
    });
  });
});

describe("arbitrateMcp", () => {
  it("returns approve when decide returns allow", () => {
    const decide = (): Decision => ({ verdict: "allow", reason: "ok" });
    expect(arbitrateMcp(request, decide, { interactive: false })).toEqual({ action: "approve" });
  });

  it("returns deny with reason when decide returns deny", () => {
    const decide = (): Decision => ({ verdict: "deny", reason: "blocked by policy" });
    expect(arbitrateMcp(request, decide, { interactive: true })).toEqual({
      action: "deny",
      reason: "blocked by policy",
    });
  });

  it("returns approval_required when ask and not interactive (fail-closed)", () => {
    const decide = (): Decision => ({ verdict: "ask", reason: "needs approval" });
    expect(arbitrateMcp(request, decide, { interactive: false })).toEqual({
      action: "approval_required",
      reason: "needs approval",
    });
  });

  it("returns approve when ask, interactive, and askUser returns true", () => {
    const decide = (): Decision => ({ verdict: "ask", reason: "confirm?" });
    const askUser = vi.fn(() => true);
    expect(arbitrateMcp(request, decide, { interactive: true, askUser })).toEqual({
      action: "approve",
    });
    expect(askUser).toHaveBeenCalledOnce();
  });

  it("returns deny user declined when ask, interactive, and askUser returns false", () => {
    const decide = (): Decision => ({ verdict: "ask", reason: "confirm?" });
    expect(
      arbitrateMcp(request, decide, { interactive: true, askUser: () => false }),
    ).toEqual({ action: "deny", reason: "user declined" });
  });

  it("returns deny user declined when ask, interactive, but askUser not provided", () => {
    const decide = (): Decision => ({ verdict: "ask", reason: "confirm?" });
    expect(arbitrateMcp(request, decide, { interactive: true })).toEqual({
      action: "deny",
      reason: "user declined",
    });
  });
});

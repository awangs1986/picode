import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRuntime } from "../../src/extension/index.ts";
import { registerMcpApprovalBridge } from "../../src/extension/mcp-approval-bridge.ts";

describe("registerMcpApprovalBridge", () => {
  it("claims adapter approval synchronously and fails closed without interactive UI", async () => {
    let listener: ((request: any) => void) | undefined;
    const events = { on: vi.fn((_name: string, fn: (request: any) => void) => { listener = fn; return () => {}; }) };
    const runtime = createRuntime();
    runtime.guard.setTier("readonly");
    registerMcpApprovalBridge(events, runtime, () => undefined);
    let decision: (() => Promise<string>) | undefined;
    const claim = vi.fn((handler: () => Promise<string>) => { decision = handler; return true; });

    listener?.({
      serverName: "github",
      originalToolName: "delete_issue",
      prefixedToolName: "github_delete_issue",
      args: { issue: 1 },
      origin: "proxy",
      claim,
    });

    expect(claim).toHaveBeenCalledOnce();
    expect(await decision?.()).toBe("deny");
  });

  it("maps a session approval to the adapter session cache", async () => {
    let listener: ((request: any) => void) | undefined;
    const events = { on: (_name: string, fn: (request: any) => void) => { listener = fn; return () => {}; } };
    const runtime = createRuntime();
    runtime.guard.setTier("readonly");
    const ctx = {
      hasUI: true,
      ui: { select: vi.fn(async () => "Allow exact command for this session") },
    } as unknown as ExtensionContext;
    registerMcpApprovalBridge(events, runtime, () => ctx);
    let decision: (() => Promise<string>) | undefined;
    listener?.({
      serverName: "github",
      originalToolName: "create_issue",
      prefixedToolName: "github_create_issue",
      args: { title: "bug" },
      origin: "proxy",
      claim(handler: () => Promise<string>) { decision = handler; return true; },
    });

    expect(await decision?.()).toBe("allow_for_session");
  });
});

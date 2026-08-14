import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerToolOutputRetention } from "../../src/extension/tool-output-retention.ts";
import type { ContextArtifactStorePort, ContextLedgerStorePort } from "../../src/shared/types.ts";
import { ok } from "../../src/shared/types.ts";

describe("Tool output retention Pi adapter", () => {
  it("bounds accepted tool content before Pi appends it to model history", async () => {
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    const pi = {
      on(name: string, handler: (event: never, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
    } as unknown as ExtensionAPI;
    const saveContextArtifact = vi.fn(async (input) => ok({
      artifactId: "a-1",
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      path: "C:/artifacts/a-1.txt",
      bytes: Buffer.byteLength(input.text),
      sha256: "digest",
    }));
    const appendContextLedger = vi.fn(async () => ok(undefined));
    registerToolOutputRetention(pi, {
      saveContextArtifact,
      appendContextLedger,
      listContextLedger: vi.fn(async () => ok([])),
    } as ContextArtifactStorePort & ContextLedgerStorePort, { maxInlineBytes: 4_096 });
    const huge = "log line\n".repeat(5_000);

    const transformed = await handlers.get("tool_result")?.({
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "build" },
      content: [{ type: "text", text: huge }],
      isError: false,
    } as never, {
      sessionManager: { getSessionId: () => "session-1" },
    } as unknown as ExtensionContext) as { content: Array<{ type: string; text: string }> };

    expect(saveContextArtifact).toHaveBeenCalledOnce();
    expect(appendContextLedger).toHaveBeenCalledWith(expect.objectContaining({
      layer: "retention",
      action: "externalized",
      sessionId: "session-1",
      artifactRef: "C:/artifacts/a-1.txt",
    }));
    expect(Buffer.byteLength(transformed.content[0]?.text ?? "")).toBeLessThanOrEqual(4_096);
    expect(transformed.content[0]?.text).toContain("C:/artifacts/a-1.txt");
  });
});

import { describe, expect, it } from "vitest";
import { retainToolOutput } from "../../../src/devloop/context/tool-output-retention.ts";
import type { ContextArtifactStorePort } from "../../../src/shared/types.ts";
import { err, ok } from "../../../src/shared/types.ts";

describe("retainToolOutput", () => {
  it("spills an oversized plain-text result and gives the model a bounded retrieval locator", async () => {
    const full = "compiler output\n".repeat(8_000);
    const store: ContextArtifactStorePort = {
      saveContextArtifact: async (input) => ok({
        artifactId: "artifact-1",
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        path: "C:/picode/artifacts/context/session/tool.txt",
        bytes: Buffer.byteLength(input.text),
        sha256: "abc123",
      }),
    };

    const result = await retainToolOutput({
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: full }],
    }, store, { maxInlineBytes: 8_192 });

    expect(result.retained).toBe(true);
    expect(result.artifact?.path).toContain("tool.txt");
    expect(Buffer.byteLength(result.content[0]?.text ?? "")).toBeLessThanOrEqual(8_192);
    expect(result.content[0]?.text).toContain("read with offset/limit");
    expect(result.content[0]?.text).toContain("grep this path");
    expect(result.content[0]?.text).not.toContain(full);
  });

  it("fails bounded when artifact persistence fails instead of returning the oversized result", async () => {
    const full = "very large output\n".repeat(8_000);
    const store: ContextArtifactStorePort = {
      saveContextArtifact: async () => err("store/artifact-write-failed", "disk unavailable"),
    };

    const result = await retainToolOutput({
      sessionId: "session-1",
      toolCallId: "call-2",
      toolName: "mcp",
      content: [{ type: "text", text: full }],
    }, store, { maxInlineBytes: 4_096 });

    expect(result.retained).toBe(true);
    expect(result.artifact).toBeUndefined();
    expect(Buffer.byteLength(result.content[0]?.text ?? "")).toBeLessThanOrEqual(4_096);
    expect(result.content[0]?.text).toContain("artifact storage failed");
    expect(result.content[0]?.text).not.toContain(full);
  });

  it("leaves small or mixed-content results unchanged", async () => {
    const store: ContextArtifactStorePort = {
      saveContextArtifact: async () => { throw new Error("must not persist"); },
    };
    const small = [{ type: "text" as const, text: "small" }];
    const mixed = [{ type: "text" as const, text: "caption" }, { type: "image" as const, data: "abc", mimeType: "image/png" }];

    expect((await retainToolOutput({
      sessionId: "s", toolCallId: "c", toolName: "read", content: small,
    }, store, { maxInlineBytes: 1_024 })).content).toBe(small);
    expect((await retainToolOutput({
      sessionId: "s", toolCallId: "c", toolName: "read", content: mixed,
    }, store, { maxInlineBytes: 1_024 })).content).toBe(mixed);
  });
});
